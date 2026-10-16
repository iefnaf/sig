// SERVER_KEY and SETUP_TOKEN are `wrangler secret put` values, not declared in
// wrangler.jsonc, so `wrangler types` doesn't know about them; merge them into the generated
// ambient Env here instead (both the global interface used by src and Cloudflare.Env, which
// is what cloudflare:test's `env` is typed as). FEISHU_API exists only in tests (a service
// binding that mocks Feishu's API); production leaves it unset and the adapter uses fetch.
//
// The steward model (issue #6, ADR-0001 decision 11): `STEWARD_MODEL` is deploy config
// (wrangler.jsonc `vars`, JSON: {provider, modelId, baseUrl?}; default deepseek/deepseek-flash
// when unset), and `STEWARD_MODEL_API_KEY` is the matching `wrangler secret put` value. Tests
// bind STEWARD_MODEL = {provider: "faux", modelId: "faux-1"} for the scripted provider.
interface Env {
  SERVER_KEY: string;
  SETUP_TOKEN: string;
  FEISHU_API?: Fetcher;
  STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
  STEWARD_MODEL_API_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    SERVER_KEY: string;
    SETUP_TOKEN: string;
    FEISHU_API?: Fetcher;
    STEWARD_MODEL?: string | { provider?: unknown; modelId?: unknown; baseUrl?: unknown };
    STEWARD_MODEL_API_KEY?: string;
  }
}
