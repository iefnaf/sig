import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // SERVER_KEY is a `wrangler secret put` value in real deployments; tests supply a
      // deterministic stand-in instead of relying on a committed or ambient secret.
      miniflare: { bindings: { SERVER_KEY: "test-server-key-not-a-secret" } },
    }),
  ],
});
