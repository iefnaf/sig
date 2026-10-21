// The log contract (issue #26): ~/.sig/logs contains no keys and no session content.
// redactText is the backstop; the Logger writes JSONL, caps growth, and tails for `logs`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCapped, Logger, tailFile } from "../src/logger.ts";
import { redactText } from "../src/redact.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sig-logger-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("redactText", () => {
  it("replaces provided secret values", () => {
    const token = "st1.dev_abc.1.100.deadbeefcafe";
    expect(redactText(`Bearer ${token} ok`, [token])).toBe("Bearer [redacted] ok");
  });

  it("scrubs common key shapes without knowing the secret", () => {
    expect(redactText("key sk-proj-abc123defGHIjklmnop")).not.toContain("sk-proj-abc123defGHIjklmnop");
    expect(redactText("token ghp_" + "a".repeat(30))).toContain("[redacted]");
    expect(redactText("xoxb-1234567890-abcdefghijkl")).toContain("[redacted]");
    expect(redactText("aws AKIAIOSFODNN7EXAMPLE")).toContain("[redacted]");
    expect(redactText("Authorization: Bearer abc123def456ghi789==")).toContain("Bearer [redacted]");
  });

  it("leaves ordinary content alone", () => {
    const line = JSON.stringify({ event: "worker_event", workerId: "w-abc", type: "settled" });
    expect(redactText(line)).toBe(line);
  });
});

describe("Logger", () => {
  it("writes redacted JSONL lines", () => {
    const token = "st1.dev_abc.1.100.deadbeefcafe";
    const logger = new Logger({ dir, secrets: [token], now: () => 1000 });
    logger.info("daemon_start", { deviceId: "dev_abc", note: `token=${token}` });

    const content = readFileSync(join(dir, "connector.log"), "utf8");
    expect(content).not.toContain(token);
    const parsed = JSON.parse(content.trim()) as { ts: number; level: string; event: string };
    expect(parsed).toMatchObject({ ts: 1000, level: "info", event: "daemon_start" });
  });

  it("trims the file to its newest half once past the cap", () => {
    const path = join(dir, "capped.log");
    const line = (i: number) => `line-${String(i).padStart(3, "0")} ${"x".repeat(100)}\n`;
    for (let i = 0; i < 100; i++) appendCapped(path, line(i), 1024);
    const content = readFileSync(path, "utf8");
    expect(content.length).toBeLessThan(2048); // 1 KiB cap plus one in-flight line
    expect(content).not.toContain("line-000");
    expect(content).toContain("line-099");
  });
});

describe("tailFile", () => {
  it("returns the last N lines", () => {
    const path = join(dir, "t.log");
    writeFileSync(path, "a\nb\nc\nd\n");
    expect(tailFile(path, 2)).toBe("c\nd");
    expect(tailFile(path, 100)).toBe("a\nb\nc\nd");
    expect(tailFile(join(dir, "missing.log"), 5)).toBe("");
  });
});
