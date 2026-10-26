// Build for the published npm package (issue #26): bundle the CLI into a single plain-JS
// ESM file so `npx @alexlikevibe/sig` needs no TypeScript stripping and no workspace deps
// (@alexlikevibe/protocol and ws are bundled in; node: builtins stay external). The pi
// extension is NOT bundled — pi loads it as a file — so it is copied verbatim to
// dist/ext/, where install.ts resolves it via import.meta.url.
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/ext", { recursive: true });
mkdirSync("dist/mcp", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/cli.js",
  sourcemap: true,
  legalComments: "none",
  // `ws` is CJS and requires node builtins at runtime; give the ESM bundle a real require.
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  // ws's optional native accelerators: absent in most installs; ws falls back at runtime.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});

copyFileSync("src/ext/sig-pi.ts", "dist/ext/sig-pi.ts");
// The MCP report server is likewise loaded as a FILE (Claude Code spawns it per its
// mcp-config), so it ships verbatim next to the extension (issue #17).
copyFileSync("src/mcp/report-server.mjs", "dist/mcp/report-server.mjs");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
console.log(`built dist/cli.js (v${pkg.version}, ${(statSync("dist/cli.js").size / 1024).toFixed(0)} KiB)`);
