// Parallel test-group runner (why: apps/steward's vitest config runs files one at a time —
// one workerd instance backs every file and the DO's SQLite plus the node-side Feishu mock
// are shared mutable state — so a serial pass took ~3.5 min while mostly waiting on
// real-time alarm cadence at ~50% CPU). Each group below is its own vitest *process*:
// it loads vitest.config.ts independently, so it gets its own workerd instance and its own
// Feishu mock state, and files inside the group still run one at a time exactly as before.
//
// Files are assigned greedily (longest measured cost into the lightest group) from the
// COST table below, so the slowest group bounds wall time. Unknown files default to
// DEFAULT_COST — add measurements for new slow files (vitest run --reporter=json) as they grow.
//
// - `node scripts/test-groups.mjs`                 → balanced parallel groups
// - `node scripts/test-groups.mjs <vitest args…>`  → one plain serial `vitest run` (single
//   process, same semantics as before this runner) — used for single-file debugging.
// - STEWARD_TEST_GROUPS=n                           → force the group count (default: scales
//   with CPUs; these tests wait on real-time alarms more than they burn CPU).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, "test");
const vitestBin = path.join(root, "node_modules", ".bin", "vitest");

// Per-file wall seconds (test time + per-file workerd import overhead), from a
// `vitest run --reporter=json` pass. Refresh when the mix changes materially.
const COST = {
  "routing.test.ts": 45,
  "worker-questions.test.ts": 55,
  "relay.test.ts": 26,
  "budget.test.ts": 25,
  "intervention.test.ts": 24,
  "review-regressions.test.ts": 21,
  "e2e-loop.test.ts": 19,
  "llm-reply.test.ts": 19,
  "web-workspace.test.ts": 20,
  "web-workspace-cards.test.ts": 18,
  "routines.test.ts": 14,
  "notes.test.ts": 11,
  "offline-dispatch.test.ts": 10,
  "history-relay.test.ts": 18,
  "machine-status.test.ts": 7,
  "ledger.test.ts": 5,
  "handoff.test.ts": 4,
  "raw-process-page.test.ts": 4,
  "dispatch.test.ts": 4,
  "alarm.test.ts": 4,
  "web-auth.test.ts": 4,
  "web-pages.test.ts": 4,
  "ui-session.test.ts": 4,
  "ui-modules.test.ts": 4,
  "workspace-stream.test.ts": 12,
  "verify-sweep-grid.test.ts": 7,
};
const DEFAULT_COST = 3;

const PALETTE = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function label(index, group) {
  const color = PALETTE[index % PALETTE.length];
  const names = group.map((f) => f.replace(".test.ts", "")).join(" ");
  return `${color}[g${index + 1}: ${names}]${RESET}`;
}

function pipe(tag, stream, out) {
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => out.write(`${tag} ${line}\n`));
}

function runVitest(args, tag) {
  const started = Date.now();
  const child = spawn(vitestBin, args, { cwd: root, env: { ...process.env, CI: "1" } });
  if (tag) {
    pipe(tag, child.stdout, process.stdout);
    pipe(tag, child.stderr, process.stderr);
  } else {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`${tag ?? ""} failed to start vitest: ${err.message}`);
      resolve({ code: 1, seconds: (Date.now() - started) / 1000 });
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, seconds: (Date.now() - started) / 1000 }));
  });
}

const passthrough = process.argv.slice(2);
if (passthrough.length > 0) {
  // Single serial run — one process, one workerd, exactly the pre-group-runner behavior.
  const { code } = await runVitest(["run", ...passthrough]);
  process.exit(code);
}

// generated-auth.test.ts runs a no-SERVER_KEY workerd (vitest.generated-auth.config.ts). Every
// other file runs the explicit-key compatibility suite in vitest.config.ts.
const isGeneratedAuthTest = (f) => f === "generated-auth.test.ts";
const allTests = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).sort();
const files = allTests.filter((f) => !isGeneratedAuthTest(f));
const generatedAuthFiles = allTests.filter(isGeneratedAuthTest);
if (files.length === 0) {
  console.error(`no *.test.ts files under ${testDir}`);
  process.exit(1);
}

const missing = Object.keys(COST).filter((f) => !files.includes(f));
if (missing.length > 0) {
  console.warn(`${DIM}cost table lists files that no longer exist (rename? update COST): ${missing.join(", ")}${RESET}`);
}

const defaultCount = Math.min(6, Math.max(3, os.cpus().length));
const parsed = Number.parseInt(process.env.STEWARD_TEST_GROUPS ?? "", 10);
const groupCount = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, files.length) : Math.min(defaultCount, files.length);

// Greedy longest-cost-first into the currently lightest group.
const groups = Array.from({ length: groupCount }, () => ({ files: [], cost: 0 }));
for (const file of [...files].sort((a, b) => (COST[b] ?? DEFAULT_COST) - (COST[a] ?? DEFAULT_COST))) {
  const lightest = groups.reduce((min, g) => (g.cost < min.cost ? g : min), groups[0]);
  lightest.files.push(file);
  lightest.cost += COST[file] ?? DEFAULT_COST;
}
for (const g of groups) g.files.sort();

console.log(
  `running ${files.length} test files in ${groupCount} parallel vitest processes ` +
    `(groups: ${groups.map((g) => `~${g.cost}s/${g.files.length}f`).join("  ")}; per-process workerd, serial within)`,
);

const generatedAuthRun = generatedAuthFiles.length === 0
  ? Promise.resolve({ code: 0, seconds: 0 })
  : runVitest(
      ["run", "--config", "vitest.generated-auth.config.ts", ...generatedAuthFiles.map((f) => path.join("test", f))],
      `${PALETTE[groups.length % PALETTE.length]}[fresh-deploy: ${generatedAuthFiles.map((f) => f.replace(".test.ts", "")).join(" ")}]${RESET}`,
    );
const results = await Promise.all([
  ...groups.map((g, i) => {
    if (g.files.length === 0) return Promise.resolve({ code: 0, seconds: 0 });
    return runVitest(["run", ...g.files.map((f) => path.join("test", f))], label(i, g.files));
  }),
  generatedAuthRun,
]);

let failed = false;
if (generatedAuthFiles.length > 0) {
  const r = results[results.length - 1];
  console.log(`${r.code === 0 ? "✓" : "✗"} fresh-deploy: ${generatedAuthFiles.length} files in ${r.seconds.toFixed(1)}s`);
  if (r.code !== 0) failed = true;
}
for (const [i, r] of results.slice(0, groups.length).entries()) {
  if (groups[i].files.length === 0) continue;
  const mark = r.code === 0 ? "✓" : "✗";
  console.log(`${mark} group ${i + 1}: ${groups[i].files.length} files in ${r.seconds.toFixed(1)}s`);
  if (r.code !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
