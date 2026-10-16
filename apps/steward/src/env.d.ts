// SERVER_KEY, SERVER_KEY_PREVIOUS, and SETUP_TOKEN are `wrangler secret put` values, not
// declared in wrangler.jsonc, so `wrangler types` doesn't know about them; merge them into
// the generated ambient Env here instead (both the global interface used by src and
// Cloudflare.Env, which is what cloudflare:test's `env` is typed as). SERVER_KEY_PREVIOUS is
// the optional rotation-window key (issue #27): while set, tokens and sealed secrets made
// under the old SERVER_KEY keep verifying. MODEL_KEY (issue #25) is the deploy-form model
// provider key: consumed once to seed the sealed sh_model row, deletable afterwards.
// FEISHU_API exists only in tests (a service binding that mocks Feishu's API); production
// leaves it unset and the adapter uses fetch.
//
// The steward model selection (issue #6, ADR-0001 decision 11): `STEWARD_MODEL` is deploy
// config (the root wrangler.jsonc `vars`, JSON: {provider, modelId, baseUrl?}; default
// deepseek/deepseek-flash when unset) and picks provider + model id. The API key never comes
// from an env var: it is the sealed sh_model row (seeded from MODEL_KEY at deploy or set via
// setModelConfig), read through Steward.modelConfig() — the provider it names wins over the
// vars default. Tests bind STEWARD_MODEL = {provider: "faux", modelId: "faux-1"} for the
// scripted provider.
interface Env {
  SERVER_KEY: string;
  SERVER_KEY_PREVIOUS?: string;
  SETUP_TOKEN: string;
  MODEL_KEY?: string;
  FEISHU_API?: Fetcher;
  STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
}

declare namespace Cloudflare {
  interface Env {
    SERVER_KEY: string;
    SERVER_KEY_PREVIOUS?: string;
    SETUP_TOKEN: string;
    MODEL_KEY?: string;
    FEISHU_API?: Fetcher;
    STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
  }
}
