// SERVER_KEY and SERVER_KEY_PREVIOUS are `wrangler secret put` values, not declared in
// wrangler.jsonc, so `wrangler types` doesn't know about them; merge them into the generated
// ambient Env here instead (both the global interface used by src and Cloudflare.Env, which
// is what cloudflare:test's `env` is typed as). SERVER_KEY_PREVIOUS is the optional
// rotation-window key (issue #27): while set, tokens and sealed secrets made under the old
// SERVER_KEY keep verifying, and it also gates the owner API during the window (ADR-0003).
// MODEL_KEY (issue #25) is the deploy-form model provider key: consumed once to seed the
// sealed sh_model row, deletable afterwards.
//
// The steward model selection (issue #6, ADR-0001 decision 11): `STEWARD_MODEL` is deploy
// config (the root wrangler.jsonc `vars`, JSON: {provider, modelId, baseUrl?}; default
// deepseek/deepseek-flash when unset) and picks provider + model id. The API key never comes
// from an env var: it is the sealed sh_model row (seeded from MODEL_KEY at deploy, or set via
// setModelConfig/the Settings page's runtime switch), read through Steward.modelConfig(). A
// runtime switch (issue #70) carries its own modelId and wins over vars.STEWARD_MODEL
// entirely; a legacy provider-only seal (MODEL_KEY, or setModelConfig with no modelId) only
// picks the provider, and only when vars are unset (llm/models.ts mergeModelSelection). Tests
// bind STEWARD_MODEL = {provider: "faux", modelId: "faux-1"} for the scripted provider.
interface Env {
  SERVER_KEY?: string;
  LOGIN_PASSWORD?: string;
  LOGIN_RATE_LIMITER?: RateLimit;
  SERVER_KEY_PREVIOUS?: string;
  MODEL_KEY?: string;
  STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
  // Issue #28 (steward.md §12): USD per UTC day for the daily budget soft cap. Unset →
  // budget.ts DEFAULT_DAILY_BUDGET_USD; 0 disables automatic model wakes entirely.
  DAILY_BUDGET_USD?: string | number;
  // Preview deployments can loosen the shared PR sign-in link. Unset values keep the
  // production policy: 15 minutes and one use.
  LOGIN_LINK_TTL_MS?: string | number;
  LOGIN_LINK_REUSABLE?: string | boolean;
}

declare namespace Cloudflare {
  interface Env {
    SERVER_KEY?: string;
    LOGIN_PASSWORD?: string;
    LOGIN_RATE_LIMITER?: RateLimit;
    SERVER_KEY_PREVIOUS?: string;
    MODEL_KEY?: string;
    STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
    DAILY_BUDGET_USD?: string | number;
    LOGIN_LINK_TTL_MS?: string | number;
    LOGIN_LINK_REUSABLE?: string | boolean;
  }
}
