// One-click-deploy glue (issue #25, spec §12.1 step 1): the MODEL_KEY secret collected by the
// Deploy-to-Cloudflare form seeds the sealed model config exactly once — the first
// modelConfig() on an empty sh_model seals it under SERVER_KEY (default provider per
// ADR-0001 decision 11); an explicit setModelConfig always wins over the env seed.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { ownerStub, resetChannelState } from "./helpers.ts";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

beforeEach(async () => {
  await resetChannelState();
  // sh_model/sh_provider_key are deliberately not part of resetChannelState (they survive
  // channel resets); this suite owns their rows explicitly.
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_provider_key`;
  });
});

describe("modelConfig: MODEL_KEY seeding", () => {
  it("seals the deploy-form key into sh_model on first read, under the default provider", async () => {
    const cfg = await ownerStub().modelConfig();
    expect(cfg).toEqual({ provider: "deepseek", modelId: null, baseUrl: null, apiKey: env.MODEL_KEY });

    // Sealed at rest (spec §12.2): the stored row never contains the plaintext key.
    const rows = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { sql: Sql }).sql.bind(instance)`
        SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0
      ` as unknown as { provider: string; apiKeyEnc: string }[],
    );
    const row = rows[0]!;
    expect(row.provider).toBe("deepseek");
    expect(row.apiKeyEnc).not.toContain(env.MODEL_KEY!);
    expect(row.apiKeyEnc.length).toBeGreaterThan(0);

    // The credential itself lives in the per-provider registry (issue #74).
    const keyRows = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { sql: Sql }).sql.bind(instance)`SELECT provider, apiKeyEnc FROM sh_provider_key` as unknown as { provider: string; apiKeyEnc: string }[],
    );
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]).toMatchObject({ provider: "deepseek" });
    expect(keyRows[0]!.apiKeyEnc).not.toContain(env.MODEL_KEY!);
  });

  it("never overwrites an explicit config: setModelConfig beats the env seed", async () => {
    await ownerStub().setModelConfig("openai", "sk-explicit-setting");
    // A later read (what a fresh isolate's first modelConfig() would do) must keep it.
    expect(await ownerStub().modelConfig()).toEqual({ provider: "openai", modelId: null, baseUrl: null, apiKey: "sk-explicit-setting" });
  });
});
