import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The chat channel is gone (ADR-0003): the owner talks to the deployment through the
// SERVER_KEY-gated /api/* routes, so no Feishu service-binding mock is needed anymore.

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The Worker's config lives at the repo root (issue #25: Deploy-to-Cloudflare reads it
      // there); paths inside it resolve relative to the config file.
      wrangler: { configPath: "../../wrangler.jsonc" },
      // SERVER_KEY is a `wrangler secret put` value in real deployments; tests supply a
      // deterministic stand-in instead of relying on committed or ambient secrets.
      miniflare: {
        bindings: {
          SERVER_KEY: "test-server-key-not-a-secret",
          SERVER_KEY_PREVIOUS: "test-previous-server-key-not-a-secret",
          // Keep the legacy/link suite independent of a developer's ignored .dev.vars. Browser
          // password coverage uses configureBrowserPasswordForTests, and the generated-key suite
          // supplies its own deployment password in a separate workerd.
          LOGIN_PASSWORD: "",
          // The deploy-form model key (issue #25): modelConfig() seeds sh_model from it once.
          MODEL_KEY: "test-model-key-not-a-secret",
          // The scripted model provider (issue #6): replies are queued per-test through
          // Steward.fauxScript; requests are captured for assertions through fauxRequests.
          STEWARD_MODEL: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
        },
      },
    }),
  ],
  // One workerd instance backs every file here, and the Durable Object's SQLite is shared
  // mutable state that per-test storage isolation does not cover — so files must run one at
  // a time for exact-count assertions to stay meaningful. Wall time instead comes from
  // parallel *processes*: scripts/test-groups.mjs (the `test` script) runs balanced file
  // groups concurrently, each loading this config — and therefore its own workerd — in a
  // separate vitest process. Keep fileParallelism false: within one process the shared
  // state above still requires serial files.
  test: { fileParallelism: false },
});
