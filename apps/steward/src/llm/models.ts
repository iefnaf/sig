// Steward model configuration and provider construction (issue #6, ADR-0001 decision 11,
// spike-conclusions bug 7): inside Workers never resolve API keys from environment variables —
// the provider is built with an inline `auth.apiKey.resolve` closure over the deploy-config
// secret, on a rebuilt copy of the catalog provider. The `faux` provider id is the test hook:
// vitest binds STEWARD_MODEL accordingly and scripts replies through Steward.fauxScript.
import {
  createModels,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  createProvider,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { providerInfo, type ProviderInfo } from "./provider-info.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";

/** The deploy-config shape (`vars.STEWARD_MODEL` in the root wrangler.jsonc). */
export interface StewardModelConfig {
  provider: string;
  modelId: string;
  /** Overrides the provider's catalog base URL (self-hosted / proxy endpoints). */
  baseUrl?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** True when the deploy config actually named a provider/model — the sealed sh_model row's
   *  provider only wins when this is false, UNLESS the row itself carries an explicit
   *  modelId (a runtime switch, issue #70), which wins unconditionally (see
   *  mergeModelSelection). */
  explicit: boolean;
}

/** The sealed sh_model row, as steward.ts's modelConfig() reads it back. */
export interface SealedModelSelection {
  provider: string;
  /** Set only by an owner-driven runtime switch (issue #70's Settings page); null for the
   *  legacy MODEL_KEY seed or a pre-#70 provider-only setModelConfig call. */
  modelId: string | null;
  baseUrl: string | null;
  apiKey: string;
  thinkingLevel?: ModelThinkingLevel;
}

/**
 * The precedence rule for the effective model selection (steward.ts ensureRootModel and
 * llmSelection share this): a runtime switch's own modelId (issue #70) wins over
 * vars.STEWARD_MODEL entirely — that is the point of letting the owner switch at runtime
 * without a redeploy. Short of that, a legacy sealed row (provider only, no modelId) picks
 * the provider when vars are unset; the deploy config alone otherwise.
 */
export function mergeModelSelection(sealed: SealedModelSelection | null, vars: StewardModelConfig): StewardModelConfig {
  if (sealed?.modelId) {
    return { provider: sealed.provider, modelId: sealed.modelId, explicit: true, ...(sealed.thinkingLevel ? { thinkingLevel: sealed.thinkingLevel } : {}), ...(sealed.baseUrl ? { baseUrl: sealed.baseUrl } : {}) };
  }
  return sealed && !vars.explicit ? { ...vars, provider: sealed.provider } : vars;
}

/** ADR-0001 decision 11: the eval baseline. Changing it requires re-running the routing eval. */
export const DEFAULT_MODEL_CONFIG: StewardModelConfig = { provider: "deepseek", modelId: "deepseek-flash", explicit: false };

/** One catalog provider as the Settings page sees it (issue #74): pickable models included. */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  info?: ProviderInfo;
  models: Array<{ id: string; name: string; baseUrl: string; api: string; thinkingLevels: ModelThinkingLevel[]; defaultThinkingLevel: ModelThinkingLevel }>;
}

/** Keep legacy Coding Plan IDs stable so existing encrypted keys remain usable. */
export function stewardProviders(): Provider[] {
  const providers = builtinProviders();
  const apiVariants = [
    { source: "zai", id: "zai-api", baseUrl: "https://api.z.ai/api/paas/v4" },
    { source: "zai-coding-cn", id: "zai-api-cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  ];
  for (const { source, id, baseUrl } of apiVariants) {
    const base = providers.find((provider) => provider.id === source);
    if (!base) throw new Error(`Missing catalog provider: ${source}`);
    providers.push(createProvider({
      id, name: base.name, baseUrl, auth: {},
      models: base.getModels().map((model) => ({ ...model, provider: id, baseUrl })),
      api: { stream: base.stream.bind(base), streamSimple: base.streamSimple.bind(base) },
    }));
  }
  return providers;
}

let catalogMemo: ProviderCatalogEntry[] | undefined;

/** The builtin provider catalog (id, display name, chat models) — the list the Settings
 *  dialog picks from. Static per deployment, so memoized; the shape is intentionally flat
 *  and JSON-friendly (it rides /app/api/settings). */
export function providerCatalog(): ProviderCatalogEntry[] {
  if (!catalogMemo) {
    catalogMemo = stewardProviders().filter((provider) => provider.getModels().length > 0).map((provider) => ({
      id: provider.id,
      name: provider.name,
      info: providerInfo(provider.id, provider.name),
      models: provider.getModels().map((model) => ({ id: model.id, name: model.name, baseUrl: model.baseUrl, api: model.api, thinkingLevels: getSupportedThinkingLevels(model), defaultThinkingLevel: clampThinkingLevel(model, "off") })),
    }));
  }
  return catalogMemo;
}

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return MODEL_THINKING_LEVELS.some((level) => value === level);
}

export function resolveModelThinking(config: StewardModelConfig): { thinkingLevel: ModelThinkingLevel; thinkingLevels: ModelThinkingLevel[] } {
  const model = stewardProviders().find((provider) => provider.id === config.provider)?.getModels().find((entry) => entry.id === config.modelId);
  return model
    ? { thinkingLevel: clampThinkingLevel(model, config.thinkingLevel ?? "off"), thinkingLevels: getSupportedThinkingLevels(model) }
    : { thinkingLevel: "off", thinkingLevels: ["off"] };
}

export type ModelSwitchInput = Pick<StewardModelConfig, "provider" | "modelId" | "baseUrl" | "thinkingLevel"> & { apiKey?: string };
export type ComposerModelInput = Pick<StewardModelConfig, "provider" | "modelId"> & { thinkingLevel: ModelThinkingLevel };

/** Parses `vars.STEWARD_MODEL`; anything malformed falls back to the default. */
export function resolveModelConfig(raw: unknown): StewardModelConfig {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ...DEFAULT_MODEL_CONFIG };
    }
  }
  if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_MODEL_CONFIG };
  const cfg = parsed as { provider?: unknown; modelId?: unknown; baseUrl?: unknown; thinkingLevel?: unknown };
  if (typeof cfg.provider !== "string" || typeof cfg.modelId !== "string" || !cfg.provider || !cfg.modelId) {
    return { ...DEFAULT_MODEL_CONFIG };
  }
  return {
    provider: cfg.provider,
    modelId: cfg.modelId,
    explicit: true,
    ...(isThinkingLevel(cfg.thinkingLevel) ? { thinkingLevel: cfg.thinkingLevel } : {}),
    ...(typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0 ? { baseUrl: cfg.baseUrl } : {}),
  };
}

/**
 * Rebuilds a catalog provider with an inline API-key auth (spike bug 7): the resolve closure
 * returns the deploy-config secret directly — no ambient environment lookup happens inside
 * the Worker. A missing key keeps the provider registered but unconfigured, so model calls
 * fail loudly instead of silently trying `DEEPSEEK_API_KEY`.
 */
export function providerWithInlineKey(base: Provider, apiKey: string | undefined, baseUrl?: string): Provider {
  return createProvider({
    id: base.id,
    name: base.name,
    baseUrl: baseUrl ?? base.baseUrl,
    headers: base.headers,
    auth: {
      apiKey: {
        name: `${base.name} API key`,
        resolve: async () => (apiKey ? { auth: { apiKey, ...(baseUrl ? { baseUrl } : {}) }, source: "deploy config" } : undefined),
      },
    },
    models: [...base.getModels()],
    api: {
      stream: base.stream.bind(base),
      streamSimple: base.streamSimple.bind(base),
      ...(base.fetchDeferred ? { fetchDeferred: base.fetchDeferred.bind(base) } : {}),
      ...(base.cancelDeferred ? { cancelDeferred: base.cancelDeferred.bind(base) } : {}),
    },
  });
}

/** One captured model request, as the test scaffolding sees it (after beforeRequest). */
export interface FauxRequestRecord {
  at: number;
  /** The last user message's text — the exact input the model received. */
  userText: string;
  /** The `sig-situation` section of the outgoing system prompt, if the hook injected one. */
  brief: string | null;
  /** The `sig-notes` section (resident-layer memory, issue #18), when present. */
  notes: string | null;
  lastToolResult: string;
}

/** The test-side scripting surface over the in-DO faux provider. */
export interface FauxScripting {
  /** FIFO steps; each provider call consumes one. Steps run out → a plain default reply. */
  setSteps(steps: AssistantMessage[]): void;
  requests(): FauxRequestRecord[];
  reset(): void;
  /** Replies arrive word by word at this rate (tokens per second) instead of all at once — what a live
   *  view needs to see a reply being written. `undefined` restores the instant default. */
  streamAt(tokensPerSecond: number | undefined): void;
}

export interface StewardModels {
  models: MutableModels;
  config: StewardModelConfig;
  /** Present only for the `faux` test provider. */
  faux?: FauxScripting;
}

/**
 * Installs/updates the configured provider on an existing (mutable) Models collection —
 * the PiHarness factory hands pi one collection for the isolate's lifetime, and the sealed
 * key (readable only after migrations) is installed onto that same object later. Idempotent;
 * the faux provider is never touched (its in-memory script is per-isolate state).
 */
export function installModel(models: MutableModels, config: StewardModelConfig, apiKey: string | undefined): void {
  if (config.provider === "faux") return;
  const base = stewardProviders().find((p) => p.id === config.provider);
  if (!base) return; // unknown provider: registers nothing — runs fail visibly as no_model
  models.setProvider(providerWithInlineKey(base, apiKey, config.baseUrl));
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && "type" in part && (part as { type: string }).type === "text"
        ? [(part as { text?: string }).text ?? ""]
        : [],
    )
    .join("");
};

/**
 * Builds the `Models` collection for the PiHarness factory. `faux` constructs the scripted
 * provider with a single recording response factory: every model request is captured for
 * assertions, and the FIFO script decides the reply (a benign default when it runs dry, so an
 * unscripted DO never wedges a run).
 */
export function buildStewardModels(config: StewardModelConfig, apiKey: string | undefined): StewardModels {
  if (config.provider === "faux") {
    const makeFaux = (tokensPerSecond?: number): FauxProviderHandle =>
      fauxProvider({ models: [{ id: config.modelId, name: "Faux" }], ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }) });
    const steps: AssistantMessage[] = [];
    const requests: FauxRequestRecord[] = [];
    const factory = async (context: TranscriptContext): Promise<AssistantMessage> => {
      const messages = [...context.messages];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastToolResult = [...messages].reverse().find((m) => m.role === "toolResult");
      // Replay the sections the way the provider will (transcript.js): every system message
      // patches by name, null removes. A delta-appended section (sig-notes) must be
      // visible here exactly as the model receives it after the collapse into one prompt.
      const sections = new Map<string, string>();
      for (const message of messages) {
        if (message.role !== "system") continue;
        for (const [name, value] of Object.entries((message as { sections?: Record<string, string | null> }).sections ?? {})) {
          if (value === null) sections.delete(name);
          else sections.set(name, value);
        }
      }
      requests.push({
        at: Date.now(),
        userText: textOf((lastUser as { content?: unknown } | undefined)?.content),
        brief: sections.get("sig-situation") ?? null,
        notes: sections.get("sig-notes") ?? null,
        lastToolResult: textOf((lastToolResult as { content?: unknown } | undefined)?.content),
      });
      if (requests.length > 50) requests.shift();
      const step = steps.shift();
      // `{ waitForMs, text }` steps delay the reply — the no-nudge alarm tests use them to
      // keep a run open across several real alarm cycles (review #1's regression coverage).
      if (step !== undefined && "waitForMs" in (step as unknown as Record<string, unknown>)) {
        const delayed = step as unknown as { waitForMs: number; text: string };
        await new Promise((resolve) => setTimeout(resolve, delayed.waitForMs));
        return {
          role: "assistant",
          content: [{ type: "text", text: delayed.text }],
          api: "faux",
          provider: "faux",
          model: config.modelId,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies AssistantMessage;
      }
      return (
        step ?? {
          role: "assistant",
          content: [{ type: "text", text: "(faux: 未脚本化的回复)" }],
          api: "faux",
          provider: "faux",
          model: config.modelId,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        }
      );
    };
    // Faux consumes one response entry per provider call: register many copies of the same
    // recording factory (the spike did the same), so it never runs out mid-conversation.
    const install = (tokensPerSecond?: number): void => {
      const faux = makeFaux(tokensPerSecond);
      faux.setResponses(Array.from({ length: 1000 }, () => factory));
      models.setProvider(faux.provider);
    };
    const models = createModels();
    install();
    return {
      models,
      config,
      faux: {
        setSteps: (s) => steps.push(...s),
        requests: () => [...requests],
        reset: () => {
          steps.splice(0, steps.length);
          requests.splice(0, requests.length);
          install(); // back to instant replies
        },
        streamAt: (tokensPerSecond) => install(tokensPerSecond),
      },
    };
  }

  const base = stewardProviders().find((p) => p.id === config.provider);
  const models = createModels();
  if (!base) {
    // Unknown provider id: register nothing. The root session's model stays unresolvable and
    // runs settle `unanswered` with `no_model` — visible in sh_run, not a silent wrong model.
    return { models, config };
  }
  // An unknown model id is likewise kept as configured (it fails visibly as `no_model`);
  // silently substituting a different model would break the eval-baseline rule.
  models.setProvider(providerWithInlineKey(base, apiKey, config.baseUrl));
  return { models, config };
}
