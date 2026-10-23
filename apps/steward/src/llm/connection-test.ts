import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildStewardModels, resolveModelThinking, type StewardModelConfig } from "./models.ts";

export type ConnectionTestResult =
  | { ok: true }
  | { ok: false; error: "missing_key" | "unknown_model" | "authentication" | "quota" | "endpoint" | "timeout" | "provider_error" | "busy" };

/** Use the same provider adapter as a conversation, without installing it on the steward. */
export async function testModelConnection(
  config: StewardModelConfig,
  apiKey: string | undefined,
  fetcher: FetchFunction = fetch,
): Promise<ConnectionTestResult> {
  if (!apiKey) return { ok: false, error: "missing_key" };
  const { models } = buildStewardModels(config, apiKey);
  const model = models.getModel(config.provider, config.modelId);
  if (!model) return { ok: false, error: "unknown_model" };
  const { thinkingLevel } = resolveModelThinking(config);
  const controller = new AbortController();
  let status: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConnectionTestResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: "timeout" });
    }, 20_000);
  });
  const probe = async (): Promise<ConnectionTestResult> => {
    try {
      const reply = await models.completeSimple(model, {
        messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
      }, {
        ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
        maxTokens: 32, maxRetries: 0, timeoutMs: 20_000, signal: controller.signal,
        fetch: async (input, init) => {
          const response = await fetcher(input, init);
          status = response.status;
          return response;
        },
      });
      if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { ok: true };
    } catch {
      // Provider errors may echo request headers or bodies. Return only our own error codes.
    }
    if (controller.signal.aborted) return { ok: false, error: "timeout" };
    if (status === 401 || status === 403) return { ok: false, error: "authentication" };
    if (status === 402 || status === 429) return { ok: false, error: "quota" };
    if (status === 404) return { ok: false, error: "endpoint" };
    return { ok: false, error: "provider_error" };
  };
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
