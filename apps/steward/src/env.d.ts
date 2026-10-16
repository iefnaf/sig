// SERVER_KEY is a `wrangler secret put` value, not declared in wrangler.jsonc, so
// `wrangler types` doesn't know about it; merge it into the generated ambient Env here instead.
interface Env {
  SERVER_KEY: string;
}
