// SERVER_KEY rotation (issue #27): keyId in the token, a SERVER_KEY_PREVIOUS verification
// window, rekey-on-welcome so machines rotate without re-pairing, and sealed secrets that
// survive the window and converge onto the new primary key.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintToken, parseToken, serverKey, type ServerKey } from "@shepherd/protocol";
import { openSecret } from "../src/secretbox.ts";
import type { Steward } from "../src/steward.ts";
import {
  connect,
  configureAndBind,
  connectAndHello,
  messageEvent,
  mockCalls,
  nextClose,
  ownerStub,
  postEvent,
  resetChannelState,
  tokenCalls,
  waitWhileOutboundPending,
} from "./helpers.ts";

const PRIMARY_SECRET = env.SERVER_KEY;
const PREVIOUS_SECRET = env.SERVER_KEY_PREVIOUS!;

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/** Runs raw SQL inside the DO. Call an RPC (e.g. setupState) first on a cold DO so onStart's
 * migrations have run — pairedUnderOldKey does that itself. */
async function execSql(fn: (sql: Sql) => void): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    fn(sql);
  });
}

/** Overrides the DO's key set (protected serverKeys()) for rotation-window simulations. */
async function overrideKeys(keys: ServerKey[]): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { serverKeys: () => Promise<ServerKey[]> }).serverKeys = async () => keys;
  });
}

async function envKeys(): Promise<ServerKey[]> {
  return [await serverKey(PRIMARY_SECRET), await serverKey(PREVIOUS_SECRET)];
}

/** The DO's actual key set (ADR-0004: the auth root leads, the legacy env keys follow). */
async function doKeys(): Promise<ServerKey[]> {
  const keys = await ownerStub().authKeys();
  return keys;
}

async function insertDevice(deviceId: string, name: string): Promise<void> {
  // RPC first: wakes the DO through the SDK lifecycle so migrations have run.
  await ownerStub().setupState();
  await execSql((sql) => {
    sql`INSERT OR REPLACE INTO device (deviceId, name, epoch, revoked, createdAt) VALUES (${deviceId}, ${name}, 1, 0, ${Date.now()})`;
  });
}

/** A device "paired long ago" plus a token minted under the previous key. */
async function pairedUnderOldKey(deviceId: string): Promise<string> {
  await insertDevice(deviceId, "old-machine");
  return mintToken(await serverKey(PREVIOUS_SECRET), deviceId, 1);
}

/** Legacy pre-keyId format: st1.<deviceId>.<epoch>.<issuedAt>.<mac> under the previous key. */
async function legacyTokenUnderOldKey(deviceId: string): Promise<string> {
  await insertDevice(deviceId, "legacy-machine");
  const enc = new TextEncoder();
  const base = `st1.${deviceId}.1.1600000000000`;
  const mac = [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", enc.encode(PREVIOUS_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        enc.encode(base),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${base}.${mac}`;
}

describe("SERVER_KEY rotation: device tokens (issue #27)", () => {
  it("a previous-key token keeps connecting during the window", async () => {
    const token = await pairedUnderOldKey("dev_rot_oldkey");
    const { welcome } = await connectAndHello("dev_rot_oldkey", token, 1);
    expect(welcome.t).toBe("welcome");
  });

  it("welcome hands the connector a primary-key token; the reconnect uses it (no re-pairing)", async () => {
    const token = await pairedUnderOldKey("dev_rot_rekey");
    const first = await connectAndHello("dev_rot_rekey", token, 1);
    const rekeyed = first.welcome.token as string;
    expect(typeof rekeyed).toBe("string");

    const [primary] = await doKeys();
    expect(await parseToken([primary!], rekeyed)).toMatchObject({ deviceId: "dev_rot_rekey", epoch: 1, keyId: primary!.id });

    // The rekeyed token authenticates the next connection — and needs no further rekey.
    const second = await connectAndHello("dev_rot_rekey", rekeyed, 2);
    expect(second.welcome.token).toBeUndefined();
    first.ws.close();
    second.ws.close();
  });

  it("legacy pre-keyId tokens also verify during the window and are rekeyed", async () => {
    const legacy = await legacyTokenUnderOldKey("dev_rot_legacy");
    const { welcome } = await connectAndHello("dev_rot_legacy", legacy, 1);
    expect(typeof welcome.token).toBe("string");
    const [primary] = await doKeys();
    expect(await parseToken([primary!], welcome.token as string)).toMatchObject({ deviceId: "dev_rot_legacy", keyId: primary!.id });
  });

  it("once SERVER_KEY_PREVIOUS is dropped, previous-key tokens are refused at the DO layer", async () => {
    const token = await pairedUnderOldKey("dev_rot_dropped");
    // Simulate the window closing: only the DO's own primary (the auth root) remains.
    const [primary] = await doKeys();
    await overrideKeys([primary!]);
    try {
      // The Worker's pre-check and the DO now share one live key set (ADR-0004: the fixture
      // asks the DO), so a dropped key is refused at the door already.
      const res = await connect(token);
      expect(res.status).toBe(401);
    } finally {
      // restore: clear the override so serverKeys() returns to its own derivation
      await runInDurableObject(ownerStub(), (instance: Steward) => {
        delete (instance as unknown as { serverKeys?: unknown }).serverKeys;
      });
    }
  });

  it("a primary-key token is not rekeyed (no rotation in progress)", async () => {
    await insertDevice("dev_rot_current", "fresh-machine");
    const [primary] = await doKeys();
    const token = await mintToken(primary!, "dev_rot_current", 1);
    const { welcome } = await connectAndHello("dev_rot_current", token, 1);
    expect(welcome.token).toBeUndefined();
  });
});

describe("SERVER_KEY rotation: sealed secrets (issue #27)", () => {
  beforeEach(async () => {
    await resetChannelState();
    await overrideKeys(await envKeys());
  });

  it("Feishu secrets sealed under the old key keep opening during the window and re-seal onto the primary", async () => {
    await configureAndBind("ou_rot");
    const before = await readChannelEnc("appSecretEnc");
    expect(before).toMatch(/^v2\./);

    // Simulate rotation: a brand-new primary, the old primary demoted to previous.
    const freshPrimary = await serverKey("rotated-fresh-server-key");
    const oldPrimary = await serverKey(PRIMARY_SECRET);
    await overrideKeys([freshPrimary, oldPrimary]);

    // Any read (here: a webhook event) opens via the demoted key and re-seals under the new one.
    const res = await postEvent(messageEvent({ msgId: "om_rot", senderId: "ou_rot", text: "still works" }));
    expect(res.status).toBe(200);

    const after = await readChannelEnc("appSecretEnc");
    expect(after).not.toBe(before);
    expect(await openSecret([freshPrimary], after)).toMatchObject({ text: "sec_test_secret" });
    expect(await ownerStub().inboundSeen("om_rot")).toBe(true);
  });

  it("the cached Feishu tenant_access_token is sealed at rest as well", async () => {
    await configureAndBind("ou_tenant"); // setup validation fetches and caches a tenant token
    expect((await tokenCalls(await mockCalls())).length).toBeGreaterThan(0);
    const enc = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
      return (sql`SELECT tokenEnc FROM sh_channel_token WHERE channel = 'feishu'` as { tokenEnc: string }[])[0]!.tokenEnc;
    });
    expect(enc).toMatch(/^v2\./);
    const opened = await openSecret(await envKeys(), enc);
    expect(opened?.text).toMatch(/^t_mock_/);
    await waitWhileOutboundPending();
  });

  it("model API key is stored encrypted and round-trips across a rotation", async () => {
    await ownerStub().setModelConfig("deepseek", "sk-model-secret-123");
    const row = await readModelRow();
    expect(row.provider).toBe("deepseek");
    expect(row.apiKeyEnc).toMatch(/^v2\./);
    expect(row.apiKeyEnc).not.toContain("sk-model-secret-123");

    expect(await ownerStub().modelConfig()).toEqual({ provider: "deepseek", apiKey: "sk-model-secret-123" });

    // Rotate: the sealed key still opens during the window (old primary demoted).
    const freshPrimary = await serverKey("rotated-fresh-server-key-2");
    const oldPrimary = await serverKey(PRIMARY_SECRET);
    await overrideKeys([freshPrimary, oldPrimary]);
    expect(await ownerStub().modelConfig()).toEqual({ provider: "deepseek", apiKey: "sk-model-secret-123" });
    // Window closed (key dropped entirely): reads report unconfigured, not garbage.
    await overrideKeys([freshPrimary]);
    expect(await ownerStub().modelConfig()).toBeNull();
  });
});

async function readChannelEnc(column: "appSecretEnc" | "verificationTokenEnc"): Promise<string> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    const rows =
      column === "appSecretEnc"
        ? (sql`SELECT appSecretEnc AS enc FROM sh_channel WHERE channel = 'feishu'` as { enc: string }[])
        : (sql`SELECT verificationTokenEnc AS enc FROM sh_channel WHERE channel = 'feishu'` as { enc: string }[]);
    return rows[0]!.enc;
  });
}

async function readModelRow(): Promise<{ provider: string; apiKeyEnc: string }> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    return (sql`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0` as { provider: string; apiKeyEnc: string }[])[0]!;
  });
}
