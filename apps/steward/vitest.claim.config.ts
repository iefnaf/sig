import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The production Worker entry (src/index.ts, as wrangler.jsonc names it) with the ADR-0004
// doors: no Access, no passwords — the first machine claims with a Cloudflare-written claim
// secret (SHEPHERD_CLAIM_SECRET, bound here as the tests' stand-in for the API write), and
// browsers sign in with machine-minted one-time links. The claim secret's hash is what /pair
// verifies; SHEPHERD_IDENTITY is the deploy-time stamp scripts/deploy.mjs writes.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          // No SERVER_KEY: a fresh ADR-0004 deployment has none — the Durable Object's own
          // auth root signs everything. (Binding one here masked exactly that shape.)
          // No MODEL_KEY either: the first-run flow saves one through the settings API.
          STEWARD_MODEL: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
          SHEPHERD_IDENTITY: JSON.stringify({ accountId: "1234567890", scriptName: "shepherd-steward" }),
          // What `shepherd connect` writes through the Cloudflare API in production; here it is
          // simply bound, and the tests send its SHA-256 (claim-helpers claimProof).
          SHEPHERD_CLAIM_SECRET: "test-claim-secret-not-a-real-one",
        },
      },
    }),
  ],
  // One workerd and one Durable Object back every file, so files run one at a time (see vitest.config.ts).
  test: { fileParallelism: false, include: ["test/claim-*.test.ts"] },
});
