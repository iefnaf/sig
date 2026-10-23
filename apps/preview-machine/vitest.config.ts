import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.machine-preview.jsonc" },
      miniflare: { bindings: { PREVIEW_MACHINE_KEY: "test-machine-key-not-a-secret" } },
    }),
  ],
  test: { fileParallelism: false },
});
