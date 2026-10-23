import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A fresh-deployment workerd: no SERVER_KEY, so the owner Durable Object generates its internal
// signing key. This process is separate from the explicit-key compatibility suite.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          LOGIN_PASSWORD: "correct horse battery staple 47!",
          MODEL_KEY: "test-model-key-not-a-secret",
          STEWARD_MODEL: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
        },
      },
    }),
  ],
  test: { fileParallelism: false },
});
