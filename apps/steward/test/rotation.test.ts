// SERVER_KEY rotation (issue #27): keyId in the token, a SERVER_KEY_PREVIOUS verification
// window, rekey-on-welcome so machines rotate without re-pairing, and sealed secrets that
// survive the window and converge onto the new primary key.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintToken, parseToken, serverKey, type ServerKey } from "@alexlikevibe/protocol";
import { openSecret } from "../src/secretbox.ts";
import type { Steward } from "../src/steward.ts";
import {
  connect,
  configureAndBind,
  connectAndHello,
  messageEvent,
  nextClose,
  ownerStub,
  postEvent,
  resetChannelState,
  waitWhileOutboundPending,
} from "./helpers.ts";

const PRIMARY_SECRET = env.SERVER_KEY!;
const PREVIOUS_SECRET = env.SERVER_KEY_PREVIOUS!;

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/** Runs raw SQL inside the DO. Call an RPC first on a cold DO so onStart's migrations have
 * run — insertDevice does that itself. */
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

async function insertDevice(deviceId: string, name: string): Promise<void> {
  // RPC first: wakes the DO through the SDK lifecycle so migrations have run.
  await ownerStub().channelLogEntries(1);
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

    const primary = await serverKey(PRIMARY_SECRET);
    expect(await parseToken([primary], rekeyed)).toMatchObject({ deviceId: "dev_rot_rekey", epoch: 1, keyId: primary.id });

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
    const primary = await serverKey(PRIMARY_SECRET);
    expect(await parseToken([primary], welcome.token as string)).toMatchObject({ deviceId: "dev_rot_legacy", keyId: primary.id });
  });

  it("once SERVER_KEY_PREVIOUS is dropped, previous-key tokens are refused at the DO layer", async () => {
    const token = await pairedUnderOldKey("dev_rot_dropped");
    // Simulate the operator closing the window: only the new primary remains configured.
    await overrideKeys([await serverKey(PRIMARY_SECRET)]);
    try {
      const res = await connect(token);
      expect(res.status).toBe(101); // the Worker precheck still has the old env…
      const ws = res.webSocket!;
      ws.accept();
      const closed = await nextClose(ws); // …but the DO layer refuses the stale key
      expect(closed.code).toBe(4401);
    } finally {
      await overrideKeys(await envKeys());
    }
  });

  it("a primary-key token is not rekeyed (no rotation in progress)", async () => {
    await insertDevice("dev_rot_current", "fresh-machine");
    const token = await mintToken(await serverKey(PRIMARY_SECRET), "dev_rot_current", 1);
    const { welcome } = await connectAndHello("dev_rot_current", token, 1);
    expect(welcome.token).toBeUndefined();
  });
});

describe("SERVER_KEY rotation: sealed secrets (issue #27)", () => {
  beforeEach(async () => {
    await resetChannelState();
    await overrideKeys(await envKeys());
  });

  it("model API key is stored encrypted and round-trips across a rotation", async () => {
    await ownerStub().setModelConfig("deepseek", "sk-model-secret-123");
    const row = await readModelRow();
    expect(row.provider).toBe("deepseek");
    expect(row.apiKeyEnc).toMatch(/^v2\./);
    expect(row.apiKeyEnc).not.toContain("sk-model-secret-123");

    expect(await ownerStub().modelConfig()).toEqual({ provider: "deepseek", modelId: null, baseUrl: null, apiKey: "sk-model-secret-123" });

    // Rotate: the sealed key still opens during the window (old primary demoted).
    const freshPrimary = await serverKey("rotated-fresh-server-key-2");
    const oldPrimary = await serverKey(PRIMARY_SECRET);
    await overrideKeys([freshPrimary, oldPrimary]);
    expect(await ownerStub().modelConfig()).toEqual({ provider: "deepseek", modelId: null, baseUrl: null, apiKey: "sk-model-secret-123" });
    // Window closed (key dropped entirely): the key is unreadable, but the selection itself
    // is plain columns — it survives as a keyless row the Settings page can re-key, instead
    // of masquerading as "no selection" (issue #74 split the two storages).
    await overrideKeys([freshPrimary]);
    expect(await ownerStub().modelConfig()).toEqual({ provider: "deepseek", modelId: null, baseUrl: null, apiKey: "" });
  });
});


async function readModelRow(): Promise<{ provider: string; apiKeyEnc: string }> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    return (sql`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0` as { provider: string; apiKeyEnc: string }[])[0]!;
  });
}
