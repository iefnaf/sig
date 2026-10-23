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
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_provider_key`;
  });
}

// sh_model/sh_provider_key survive between test files (the DO's SQLite is never rolled back) and, once
// a switch sets an explicit modelId, it wins over every other test's vars.STEWARD_MODEL = faux
// binding. Clear both on both sides so nothing here leaks into a later file.
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

describe("per-provider keys (issue #74)", () => {
  it("keeps each provider's key when switching between them, and switching back needs no re-entry", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-a", "claude-a");
    await ownerStub().setModelConfig("openai", "sk-openai-b", "gpt-b");
    expect(await ownerStub().keyedProviders()).toEqual(["anthropic", "openai"]);

    // No apiKey given: the selection moves back to anthropic and picks up its sealed key.
    await ownerStub().setModelConfig("anthropic", undefined, "claude-a2");
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "anthropic", modelId: "claude-a2", apiKey: "sk-ant-a" });
  });

  it("a keyless switch resolves with an empty key and reports apiKey: false", async () => {
    await ownerStub().setModelConfig("deepseek", undefined, "deepseek-flash");
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "" });
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", apiKey: false });
  });

  it("mirrors the selected provider's key in sh_model, so a pre-#74 reader stays consistent", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-mirror", "claude-m");
    await ownerStub().setModelConfig("openai", "sk-openai-mirror", "gpt-m");
    const rows = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { sql: Sql }).sql.bind(instance)`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0` as unknown as { provider: string; apiKeyEnc: string }[],
    );
    expect(rows[0]).toMatchObject({ provider: "openai" });
    expect(rows[0]!.apiKeyEnc.length).toBeGreaterThan(0);
    expect(rows[0]!.apiKeyEnc).not.toContain("sk-openai-mirror");
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

  it("tests saved or draft keys without saving credentials or changing the selected model", async () => {
    const { settings, post } = await browser();
    await post("settings/model", { provider: "deepseek", modelId: "deepseek-flash", apiKey: "saved-test-key" });
    const before = await (await settings()).json();
    const saved = await post("settings/model/test", { provider: "deepseek", modelId: "not-in-catalog" });
    expect(await saved.json()).toEqual({ ok: false, error: "unknown_model" });
    const draft = await post("settings/model/test", { provider: "openai", modelId: "not-in-catalog", apiKey: "unsaved-test-key" });
    expect(await draft.json()).toEqual({ ok: false, error: "unknown_model" });
    expect(await (await post("settings/model/test", { provider: "openai", modelId: "not-in-catalog" })).json()).toEqual({ ok: false, error: "missing_key" });
    expect(await (await settings()).json()).toEqual(before);
    expect((await ownerStub().modelConfig())?.apiKey).toBe("saved-test-key");
  });

  it("protects the connection test with CSRF and validates its request", async () => {
    const cookie = await webLogin();
    const forbidden = await SELF.fetch(`${BASE}/app/api/settings/model/test`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "test-only" }),
    });
    expect(forbidden.status).toBe(403);
    const { post } = await browser();
    expect((await post("settings/model/test", { provider: "deepseek" })).status).toBe(400);
  });

  it("GET /app/api/settings reports the merged selection, the provider catalog, and which providers have keys (issue #74)", async () => {
    const { settings, post } = await browser();
    const res = await settings();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: { provider: string; modelId: string; baseUrl: string | null; apiKey: boolean };
      providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
      keyedProviders: string[];
    };
    expect(body.model).toMatchObject({ provider: "faux", modelId: "faux-1" });
    const deepseek = body.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
    expect(deepseek?.models.some((model) => model.id === "deepseek-flash")).toBe(true);
    // The test env binds MODEL_KEY, so this first read seeds the default provider's key.
    expect(body.keyedProviders).toEqual(["deepseek"]);

    await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    const after = (await (await settings()).json()) as { keyedProviders: string[] };
    expect(after.keyedProviders).toEqual(["anthropic", "deepseek"]);
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

  it("a switch without apiKey keeps the provider's sealed key (issue #74)", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    await post("settings/model", { provider: "openai", modelId: "gpt-o", apiKey: "sk-openai-web" });

    const back = await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-y" });
    expect(back.status).toBe(200);
    const after = (await (await settings()).json()) as { model: { provider: string; modelId: string; apiKey: boolean }; keyedProviders: string[] };
    expect(after.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-y", apiKey: true });
    // No settings read happened first, so MODEL_KEY never seeded: only the saved keys.
    expect(after.keyedProviders).toEqual(["anthropic", "openai"]);
  });

  it("rejects a switch missing provider or modelId, or with a malformed apiKey", async () => {
    const { post } = await browser();
    expect((await post("settings/model", { modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "", modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", modelId: "claude-x", apiKey: 5 })).status).toBe(400);
  });
});
