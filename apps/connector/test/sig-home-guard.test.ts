// The state-dir guard: connect may not install the shared service from a private state dir
// (SIG_HOME). The guard fires before any pairing traffic, so a dummy code never reaches the
// network.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe("connect with a private state directory", () => {
  it("refuses to install the shared service from SIG_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "sig-guard-"));
    try {
      const p = run(process.execPath, [dist, "connect", "https://example.com", "DUMMY1234"], {
        env: { ...process.env, SIG_HOME: home },
      });
      await expect(p).rejects.toThrow(/would repoint this machine's connector/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
