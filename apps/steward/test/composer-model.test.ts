import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { ownerStub, webLogin } from "./helpers.ts";

const BACKGROUND_CONTEXT = { abortSignal: undefined, value: () => undefined, toString: () => "[test background]" };
const BASE = "https://example.com";
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
async function clearSelection() {
  await ownerStub().channelLogEntries(1);
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    sql`DELETE FROM sh_model`;
    sql`DELETE FROM sh_provider_key`;
  });
}
beforeEach(clearSelection);
afterEach(clearSelection);
async function browser() {
  const cookie = await webLogin();
  const workspace = await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json() as { csrf: string };
  const post = (body: unknown, csrf = workspace.csrf) => SELF.fetch(`${BASE}/app/api/settings/model/selection`, {
    method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body),
  });
  return { post, settings: () => SELF.fetch(`${BASE}/app/api/settings`, { headers: { cookie } }) };
}

describe("model and thinking selection from the composer", () => {
  it("reports the effective thinking level and only a model's supported levels", async () => {
    await ownerStub().setModelConfig("deepseek", "test-only", "deepseek-flash");
    const { settings } = await browser();
    const body = await (await settings()).json() as { model: { thinkingLevel: string }; providers: Array<{ id: string; models: Array<{ id: string; thinkingLevels: string[] }> }> };
    expect(body.model.thinkingLevel).toBe("off");
    expect(body.providers.find((p) => p.id === "deepseek")?.models.find((m) => m.id === "deepseek-flash")?.thinkingLevels).toEqual(["off", "low", "high", "max"]);
  });

  it("persists the choice, preserves the saved key, and configures the actual conversation", async () => {
    await ownerStub().setModelConfig("deepseek", "saved-test-key", "deepseek-flash");
    const { post } = await browser();
    const response = await post({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" } });
    expect(await ownerStub().modelConfig()).toMatchObject({ apiKey: "saved-test-key", thinkingLevel: "high" });
    const agent = await runInDurableObject(ownerStub(), async (instance: Steward) => {
      await (instance as unknown as { ensureRootModel(): Promise<void> }).ensureRootModel();
      const pi = await instance.piHarness.pi();
      const root = await pi.root(BACKGROUND_CONTEXT);
      const configured = await root.agent(BACKGROUND_CONTEXT);
      return { model: configured.model, thinkingLevel: configured.thinkingLevel };
    });
    expect(agent).toEqual({ model: { provider: "deepseek", modelId: "deepseek-flash" }, thinkingLevel: "high" });
    await ownerStub().setModelConfig("deepseek", "replacement-test-key", "deepseek-flash");
    expect(await ownerStub().modelConfig()).toMatchObject({ apiKey: "replacement-test-key", thinkingLevel: "high" });
  });

  it("rejects unconfigured providers, unknown models and unsupported thinking levels without changing the choice", async () => {
    await ownerStub().setModelConfig("deepseek", "test-only", "deepseek-flash");
    const { post } = await browser();
    for (const input of [
      { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" },
      { provider: "deepseek", modelId: "missing", thinkingLevel: "off" },
      { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "medium" },
      { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "turbo" },
    ]) expect((await post(input)).status).toBe(400);
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" });
  });

  it("requires a live owner session and CSRF token", async () => {
    const unauthenticated = await SELF.fetch(`${BASE}/app/api/settings/model/selection`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthenticated.status).toBe(401);
    const { post } = await browser();
    expect((await post({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" }, "wrong-token")).status).toBe(403);
  });
});
