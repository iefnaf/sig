// The Sig MCP report server (issue #17): stdio JSON-RPC 2.0, one tool (`report`),
// §7.2 fields — driven over its real stdio pipe exactly like Claude Code drives it
// (initialize → notifications/initialized → tools/list → tools/call).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SERVER = join(import.meta.dirname, "../src/mcp/report-server.mjs");

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  workDir = null;
});

interface Turn {
  stdout: string;
  stderr: string;
}

/** Spawns the server, writes the given LF-delimited requests on stdin, closes stdin, and
 *  collects everything it answered. One shot per turn — the real server lives as long as
 *  Claude Code keeps it, but every exchange here is stateless. */
function drive(requests: Array<Record<string, unknown>>, args: string[] = []): Turn {
  const result = spawnSync(process.execPath, [SERVER, ...args], {
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 15_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("sig MCP report server (issue #17, spike §2: ~40 lines of JSON-RPC)", () => {
  it("initializes, lists the report tool, and answers ping", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    const replies = lines(stdout);
    expect(replies).toHaveLength(3); // the notification gets NO response
    expect(replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    const tools = replies[1]!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]!.name).toBe("report");
    expect(tools.tools[0]!.inputSchema.required).toContain("status");
    expect(tools.tools[0]!.inputSchema.required).toContain("summary");
    expect(tools.tools[0]!.inputSchema.properties).toHaveProperty("answer");
    expect(replies[2]).toMatchObject({ id: 3, result: {} });
  });

  it("accepts a valid report call and persists it to the audit file", () => {
    workDir = mkdtempSync(join(tmpdir(), "sig-mcp-"));
    const audit = join(workDir, "w-1.json");
    const { stdout } = drive(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report", arguments: { status: "done", summary: "shipped", decisions: ["sqlite"] } } },
      ],
      [audit],
    );
    const [reply] = lines(stdout);
    expect(reply).toMatchObject({ id: 1, result: { isError: false } });
    expect(((reply!.result as { content: Array<{ text: string }> }).content[0]!.text)).toContain("done");
    expect(JSON.parse(readFileSync(audit, "utf8") as string)).toMatchObject({ status: "done", summary: "shipped" });
  });

  it("rejects an invalid report as a tool-level error the model can fix and retry", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "report", arguments: { status: "blocked", summary: "need a decision" } } },
    ]);
    const [reply] = lines(stdout);
    expect(reply!.result).toMatchObject({ isError: true });
    expect(JSON.stringify(reply)).toContain("question");
  });

  it("answers unknown tools and methods with JSON-RPC errors", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ]);
    const replies = lines(stdout);
    expect(replies[0]!.error).toBeDefined();
    expect(replies[1]!.error).toBeDefined();
  });

  it("is installed by installClaudeAssets under the state dir", async () => {
    const { installClaudeAssets } = await import("../src/install.ts");
    workDir = mkdtempSync(join(tmpdir(), "sig-mcp-"));
    const { serverPath } = installClaudeAssets(workDir, "test-version");
    expect(serverPath).toContain("mcp");
    expect(existsSync(serverPath)).toBe(true);
  });
});
