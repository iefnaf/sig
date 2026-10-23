import { describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { providerWithInlineKey } from "../src/llm/models.ts";

describe("provider endpoint selection", () => {
  it("keeps a model's protocol-specific endpoint unless the owner overrides it", async () => {
    const base = builtinProviders().find((p) => p.id === "openrouter")!;
    const model = base.getModels().find((m) => m.api === "anthropic-messages")!;
    const urls: string[] = [];
    for (const override of [undefined, "https://proxy.example/anthropic"]) {
      const models = createModels();
      models.setProvider(providerWithInlineKey(base, "test-only", override));
      await models.completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: 0 }] }, {
        maxRetries: 0,
        fetch: async (input) => {
          const url = new URL(String(input));
          urls.push(url.origin + url.pathname);
          return new Response(JSON.stringify({ error: { message: "test rejection", type: "authentication_error" } }), { status: 401 });
        },
      });
    }
    expect(urls).toEqual([`${model.baseUrl}/v1/messages`, "https://proxy.example/anthropic/v1/messages"]);
  });
});

import { testModelConnection } from "../src/llm/connection-test.ts";
import { providerCatalog } from "../src/llm/models.ts";

const config = { provider: "deepseek", modelId: "deepseek-flash", explicit: true };

describe("connection probe", () => {
  it("sends a minimal real completion through the selected adapter and endpoint", async () => {
    let url = "";
    let requestBody = "";
    let authorization: string | null = null;
    const result = await testModelConnection({ ...config, baseUrl: "https://proxy.example/v1" }, "test-only", async (input, init) => {
      url = String(input);
      requestBody = String(init?.body);
      authorization = new Headers(init?.headers).get("authorization");
      return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    expect(result).toEqual({ ok: true });
    expect(url).toBe("https://proxy.example/v1/chat/completions");
    expect(authorization).toBe("Bearer test-only");
    expect(JSON.parse(requestBody)).toMatchObject({ messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 32 });
  });

  it.each([[401, "authentication"], [403, "authentication"], [429, "quota"], [404, "endpoint"], [500, "provider_error"]])("sanitizes HTTP %s without retrying or leaking upstream errors", async (status, error) => {
    let calls = 0;
    const result = await testModelConnection(config, "test-only-secret", async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "echoed test-only-secret" } }), { status: Number(status) });
    });
    expect(result).toEqual({ ok: false, error });
    expect(calls).toBe(1);
  });

  it.each(["off", "high", "max"] as const)("sends the selected %s thinking level to the provider", async (thinkingLevel) => {
    let payload = "";
    await testModelConnection({ ...config, thinkingLevel }, "test-only", async (_input, init) => {
      payload = String(init?.body);
      return new Response(JSON.stringify({ error: { message: "test rejection" } }), { status: 401 });
    });
    const body = JSON.parse(payload);
    expect(body.thinking).toEqual({ type: thinkingLevel === "off" ? "disabled" : "enabled" });
    if (thinkingLevel === "off") expect(body.reasoning_effort).toBeUndefined();
    else expect(body.reasoning_effort).toBe(thinkingLevel);
  });

  it("times out and aborts a stalled upstream request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    try {
      const result = testModelConnection(config, "test-only", async (_input, init) => {
        signal = init?.signal;
        return await new Promise<Response>(() => {});
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await result).toEqual({ ok: false, error: "timeout" });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call the provider without credentials or a known model", async () => {
    const noFetch = async () => { throw new Error("must not fetch"); };
    expect(await testModelConnection(config, undefined, noFetch)).toEqual({ ok: false, error: "missing_key" });
    expect(await testModelConnection({ ...config, modelId: "missing" }, "test-only", noFetch)).toEqual({ ok: false, error: "unknown_model" });
  });
});

describe("API and plan catalog", () => {
  it("exposes separate API and Coding Plan configurations, preserving existing IDs", () => {
    const catalog = providerCatalog();
    for (const [id, endpoint, plan] of [
      ["zai", "https://api.z.ai/api/coding/paas/v4", "coding"],
      ["zai-api", "https://api.z.ai/api/paas/v4", "api"],
      ["zai-api-cn", "https://open.bigmodel.cn/api/paas/v4", "api"],
    ]) {
      const provider = catalog.find((p) => p.id === id)!;
      expect(provider.info).toMatchObject({ family: "zai", plan });
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.models.every((m) => m.baseUrl === endpoint)).toBe(true);
    }
    expect(catalog.find((p) => p.id === "xiaomi")?.info?.keysUrl).not.toEqual(catalog.find((p) => p.id === "xiaomi-token-plan-cn")?.info?.keysUrl);
  });
});
