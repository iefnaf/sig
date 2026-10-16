// Shared helpers for connector tests: real git fixtures, fake-pi wiring, and polling waits.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { PiAdapter } from "../src/pi-adapter.ts";

export const exec = promisify(execFile);

export function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

/** Creates a real git repository with one commit on `main`. */
export async function makeGitRepo(parent: string, name = "repo-a"): Promise<string> {
  const repo = join(parent, name);
  mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@shepherd.local"]);
  await git(repo, ["config", "user.name", "Shepherd Test"]);
  writeFileSync(join(repo, "README.md"), `# ${basename(repo)}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** The fake-pi argv prefix for PiAdapterOptions.command. */
export function fakePiCommand(): string[] {
  return [process.execPath, join(import.meta.dirname, "fake-pi.mjs")];
}

export function fakePiAdapter(stateDir: string, scenarioPath: string, extra: Record<string, string> = {}): PiAdapter {
  return new PiAdapter({
    stateDir,
    command: fakePiCommand(),
    env: { FAKE_PI_SCRIPT: scenarioPath, ...extra },
  });
}

export interface ScenarioStep {
  delayMs?: number;
  emit?: Record<string, unknown>;
  raw?: string;
  shell?: string;
  exit?: number;
}

/** Writes a fake-pi scenario file and returns its path. */
export function writeScenario(dir: string, name: string, runs: ScenarioStep[][]): string {
  const path = join(dir, `${name}.scenario.json`);
  writeFileSync(path, JSON.stringify({ runs }));
  return path;
}

/** Polls until the predicate returns a truthy value; rejects on timeout. */
export function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000, what = "condition"): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const value = predicate();
      if (value !== undefined && value !== null && value !== false) {
        resolve(value as T);
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timed out waiting for ${what}`));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

/** A run whose steps stream a normal assistant turn. */
export function assistantTurn(text: string): ScenarioStep[] {
  return [
    { emit: { type: "agent_start" } },
    { emit: { type: "turn_start" } },
    {
      emit: {
        type: "message_end",
        message: { role: "user", content: "task", timestamp: 0 },
      },
    },
    {
      emit: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
      },
    },
    { emit: { type: "agent_settled", aborted: false } },
  ];
}

/** A run that calls the report tool, optionally after a shell step. */
export function reportRun(
  report: Record<string, unknown>,
  opts: { shellBefore?: string; tool?: string } = {},
): ScenarioStep[] {
  return [
    { emit: { type: "agent_start" } },
    { emit: { type: "turn_start" } },
    ...(opts.shellBefore ? [{ shell: opts.shellBefore }] : []),
    ...(opts.tool
      ? [
          { emit: { type: "tool_execution_start", toolCallId: "c0", toolName: opts.tool, args: { file_path: "src/a.ts" } } },
          { emit: { type: "tool_execution_end", toolCallId: "c0", toolName: opts.tool, result: {}, isError: false } },
        ]
      : []),
    { emit: { type: "tool_execution_start", toolCallId: "c1", toolName: "report", args: report } },
    { emit: { type: "tool_execution_end", toolCallId: "c1", toolName: "report", result: {}, isError: false } },
    {
      emit: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Reported." }], stopReason: "stop" },
      },
    },
    { emit: { type: "agent_settled", aborted: false } },
  ];
}
