// Runtime model switching (issue #70): the Settings page picks provider + modelId (and
// optionally baseUrl) without a redeploy. Unlike the legacy provider-only
// setModelConfig(provider, apiKey) — which only ever supplies the provider, and only when
// vars.STEWARD_MODEL is unset — a switch that names its own modelId wins over vars
// entirely (llm/models.ts mergeModelSelection): that is the whole point of being able to
// switch at runtime instead of editing vars and redeploying.
import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { ownerStub, webLogin } from "./helpers.ts";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

const BASE = "https://example.com";

async function clearModelRow(): Promise<void> {
  // An RPC first, so onStart's migrations have run (the raw SQL below would otherwise hit a
  // cold DO with no sh_* tables yet — same reasoning as resetChannelState).
  await ownerStub().channelLogEntries(1);
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model`;
  });
}

// sh_model survives between test files (the DO's SQLite is never rolled back) and, once a
// switch sets an explicit modelId, it wins over every other test's vars.STEWARD_MODEL = faux
// binding. Clear it on both sides so nothing here leaks into a later file.
beforeEach(clearModelRow);
afterEach(clearModelRow);

describe("mergeModelSelection via setModelConfig/llmSelection (RPC level)", () => {
  it("a runtime switch's modelId wins over an explicit vars.STEWARD_MODEL (the test env binds faux)", async () => {
    const before = await ownerStub().llmSelection();
    expect(before).toMatchObject({ provider: "faux", modelId: "faux-1", explicitVars: true });

    await ownerStub().setModelConfig("anthropic", "sk-ant-switch", "claude-sonnet-x");
    const after = await ownerStub().llmSelection();
    expect(after).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: true });
  });

  it("carries an optional baseUrl through the switch", async () => {
    await ownerStub().setModelConfig("openai", "sk-openai-switch", "gpt-x", "https://proxy.example/v1");
    const selected = await ownerStub().llmSelection();
    expect(selected).toMatchObject({ provider: "openai", modelId: "gpt-x", baseUrl: "https://proxy.example/v1" });
  });

  it("round-trips modelId/baseUrl through modelConfig(), sealed like the key", async () => {
    await ownerStub().setModelConfig("openai", "sk-openai-roundtrip", "gpt-y", "https://proxy.example/v2");
    expect(await ownerStub().modelConfig()).toEqual({
      provider: "openai",
      modelId: "gpt-y",
      baseUrl: "https://proxy.example/v2",
      apiKey: "sk-openai-roundtrip",
    });
  });

  it("a later switch without modelId falls back to legacy (provider-only) precedence, not stuck on the old modelId", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-1", "claude-a");
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "anthropic", modelId: "claude-a" });

    // The pre-#70 form (provider + key only): clears the sticky modelId, reverting to
    // "provider only wins when vars are unset" — vars.STEWARD_MODEL here is explicit (faux),
    // so the deploy config is back in charge entirely.
    await ownerStub().setModelConfig("anthropic", "sk-ant-2");
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "faux", modelId: "faux-1" });
  });
});

describe("the Settings page's model switch (HTTP level, ADR-0004)", () => {
  async function browser() {
    const cookie = await webLogin();
    const workspace = await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown) =>
      SELF.fetch(`${BASE}/app/api/${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": workspace.csrf },
        body: JSON.stringify(body),
      });
    const settings = () => SELF.fetch(`${BASE}/app/api/settings`, { headers: { cookie } });
    return { post, settings };
  }

  it("GET /app/api/settings reports the merged selection", async () => {
    const { settings } = await browser();
    const res = await settings();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: { provider: string; modelId: string; baseUrl: string | null; apiKey: boolean } };
    expect(body.model).toMatchObject({ provider: "faux", modelId: "faux-1" });
  });

  it("POST /app/api/settings/model switches provider + modelId, overriding vars, and the owner sees it reflected back", async () => {
    const { post, settings } = await browser();
    const res = await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = (await (await settings()).json()) as { model: { provider: string; modelId: string; apiKey: boolean } };
    expect(after.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: true });
  });

  it("carries baseUrl through when given", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "openai", modelId: "gpt-x", apiKey: "sk-openai-web", baseUrl: "https://proxy.example/v1" });
    const after = (await (await settings()).json()) as { model: { baseUrl: string | null } };
    expect(after.model.baseUrl).toBe("https://proxy.example/v1");
  });

  it("rejects a switch missing provider, modelId, or apiKey", async () => {
    const { post } = await browser();
    expect((await post("settings/model", { modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", modelId: "claude-x" })).status).toBe(400);
    expect((await post("settings/model", { provider: "", modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
  });
});
