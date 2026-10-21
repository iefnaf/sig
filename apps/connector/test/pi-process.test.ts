import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiProcess, RpcError } from "../src/pi-process.ts";
import { tmpDir } from "./helpers.ts";

let dir: string;
let processes: PiProcess[];

beforeEach(() => {
  dir = tmpDir("sig-pi-process-test");
  processes = [];
});

afterEach(async () => {
  await Promise.allSettled(processes.map((p) => p.close(200).catch(() => p.kill())));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** Spawns PiProcess against an inline `node -e` script acting as the peer. */
function peer(script: string, onEvent: (e: Record<string, unknown>) => void = () => {}): PiProcess {
  const proc = new PiProcess({
    command: [process.execPath, "-e", script],
    args: [],
    cwd: dir,
    onEvent,
    onExit: () => {},
  });
  proc.spawn();
  processes.push(proc);
  return proc;
}

describe("PiProcess (rpc.md framing + spike-conclusions §2)", () => {
  it("correlates responses by id and checks success === false || error", async () => {
    const proc = peer(`
      const readline = [];
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        readline.push(c);
        const s = readline.join(""); readline.length = 0;
        for (const line of s.split("\\n")) {
          if (!line) continue;
          const cmd = JSON.parse(line);
          if (cmd.type === "ok") process.stdout.write(JSON.stringify({type:"response", id: cmd.id, command:"ok", success:true, data:{answer:42}}) + "\\n");
          if (cmd.type === "nope") process.stdout.write(JSON.stringify({type:"response", id: cmd.id, command:"nope", success:false, error:"no luck"}) + "\\n");
          if (cmd.type === "weird") process.stdout.write(JSON.stringify({type:"response", id: cmd.id, command:"weird", success:true, error:"error field without success:false"}) + "\\n");
        }
      });
    `);
    const data = await proc.rpc({ type: "ok" }, 2000);
    expect(data.answer).toBe(42);
    await expect(proc.rpc({ type: "nope" }, 2000)).rejects.toThrow(/no luck/);
    // spike-conclusions §2: an `error` field must fail the rpc even when success is true.
    await expect(proc.rpc({ type: "weird" }, 2000)).rejects.toBeInstanceOf(RpcError);
  });

  it("uses strict LF framing: U+2028 inside a JSON string is not a record boundary", async () => {
    // JSON.stringify leaves U+2028 raw in the output — readline-style readers would split here.
    const proc = peer(`
      const line = JSON.stringify({type:"response", id:"framing-1", command:"get_state", success:true, data:{sessionId:"w-ok", v:"a\\u2028b"}});
      process.stdout.write(line + "\\n");
    `);
    const data = await proc.rpc({ type: "get_state", id: "framing-1" }, 2000);
    expect(data.sessionId).toBe("w-ok");
    expect(data.v).toBe("a\u2028b");
  });

  it("handles a JSON record split across multiple stdout chunks", async () => {
    const proc = peer(`
      const line = JSON.stringify({type:"response", id:"chunked-1", command:"get_state", success:true, data:{sessionId:"w-chunked"}});
      const half = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, half));
      setTimeout(() => process.stdout.write(line.slice(half) + "\\n"), 30);
    `);
    const data = await proc.rpc({ type: "get_state", id: "chunked-1" }, 2000);
    expect(data.sessionId).toBe("w-chunked");
  });

  it("keeps draining stdout: ~16MB of events do not stall the peer or the client", async () => {
    const events: Record<string, unknown>[] = [];
    const proc = new PiProcess({
      command: [process.execPath, "-e", `
        let lines = 0;
        const big = "x".repeat(8192);
        function pump() {
          while (lines < 2000) {
            lines += 1;
            const record = JSON.stringify({type:"message_update", assistantMessageEvent:{type:"text_delta", delta: big}});
            if (!process.stdout.write(record + "\\n")) { process.stdout.once("drain", pump); return; }
          }
          process.stdout.write(JSON.stringify({type:"response", id:"after-drain", command:"get_state", success:true, data:{sessionId:"w-drained"}}) + "\\n");
        }
        pump();
      `],
      args: [],
      cwd: dir,
      onEvent: (e) => events.push(e),
      onExit: () => {},
    });
    proc.spawn();
    processes.push(proc);
    // If the client stopped reading, the peer's stdout would fill and this would time out.
    const data = await proc.rpc({ type: "get_state", id: "after-drain" }, 20_000);
    expect(data.sessionId).toBe("w-drained");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.length).toBe(2000);
  });

  it("detects exit and rejects pending rpcs", async () => {
    const proc = peer(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", () => process.exit(7));
      setInterval(() => {}, 1000);
    `);
    const exited = proc.waitExit();
    proc.send({ type: "trigger" });
    await exited;
    expect(proc.hasExited).toBe(true);
    await expect(proc.rpc({ type: "get_state" }, 500)).rejects.toThrow(/not running|exited/);
  });

  it("applies a default timeout when a call passes none: a wedged peer fails the rpc instead of parking it (PR #45 review #8)", async () => {
    const proc = new PiProcess({
      command: [process.execPath, "-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', () => {}); setInterval(() => {}, 1000);"],
      args: [],
      cwd: dir,
      onEvent: () => {},
      onExit: () => {},
      defaultRpcTimeoutMs: 200,
    });
    proc.spawn();
    processes.push(proc);
    await expect(proc.rpc({ type: "abort" })).rejects.toThrow(/rpc timed out after 200ms/);
  });

  it("close() ends stdin and resolves on graceful exit; kill is the fallback", async () => {
    const proc = peer(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    await proc.close(2000);
    expect(proc.hasExited).toBe(true);
  });

  it("keeps a bounded stderr tail", async () => {
    const proc = peer(`
      process.stderr.write("E".repeat(200_000));
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        for (const line of c.split("\\n")) {
          if (!line) continue;
          const cmd = JSON.parse(line);
          process.stdout.write(JSON.stringify({type:"response", id: cmd.id, command: cmd.type, success:true, data:{}}) + "\\n");
        }
      });
      setInterval(() => {}, 1000);
    `);
    await proc.rpc({ type: "get_state" }, 2000);
    expect(proc.getStderrTail().length).toBeLessThanOrEqual(64 * 1024 + 100);
  });

  it("writes a redacted, capped stderr file per worker (§12: tails under ~/.sig/logs)", async () => {
    const stderrFile = join(dir, "pi-w-test.log");
    const proc = new PiProcess({
      command: [
        process.execPath,
        "-e",
        `for (let i = 0; i < 60; i++) process.stderr.write("sk-abcdefghijklmnopqrst noise " + i + " " + "x".repeat(60) + "\\n");`,
      ],
      args: [],
      cwd: dir,
      onEvent: () => {},
      onExit: () => {},
      stderrFile,
      stderrFileMaxBytes: 2048,
    });
    proc.spawn();
    await proc.waitExit();

    // Every line carried the key, so any window the cap kept is fully redacted — the
    // assertion cannot depend on which chunk boundaries the platform happens to deliver.
    const content = readFileSync(stderrFile, "utf8");
    expect(content).not.toContain("sk-abcdefghijklmnopqrst");
    expect(content).toContain("[redacted]");
    expect(content.length).toBeLessThan(8192); // bounded (worst case: one big final append)
    expect(content).toContain("noise 59");
  });
});
