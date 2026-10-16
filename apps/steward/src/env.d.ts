// SERVER_KEY / SERVER_KEY_PREVIOUS and SETUP_TOKEN are `wrangler secret put` values, not
// declared in wrangler.jsonc, so `wrangler types` doesn't know about them; merge them into the
// generated ambient Env here instead (both the global interface used by src and Cloudflare.Env,
// which is what cloudflare:test's `env` is typed as). SERVER_KEY_PREVIOUS is the optional
// rotation-window key (issue #27): while set, tokens and sealed secrets made under the old
// SERVER_KEY keep verifying. FEISHU_API exists only in tests (a service binding that mocks
// Feishu's API); production leaves it unset and the adapter uses fetch.
interface Env {
  SERVER_KEY: string;
  SERVER_KEY_PREVIOUS?: string;
  SETUP_TOKEN: string;
  FEISHU_API?: Fetcher;
}

declare namespace Cloudflare {
  interface Env {
    SERVER_KEY: string;
    SERVER_KEY_PREVIOUS?: string;
    SETUP_TOKEN: string;
    FEISHU_API?: Fetcher;
  }
}
