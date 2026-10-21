// git-facts: pointers, never content (connector-pi.md §7.2; issue #8's handoff briefs).
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitFacts } from "../src/git-facts.ts";
import { exec } from "./helpers.ts";

/** `git <args>` in `cwd`. */
const g = (cwd: string, args: string[]) => exec("git", args, { cwd });

describe("collectGitFacts (issue #8: pointers for handoff briefs)", () => {
  it("returns commit shas and changed file paths, never content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gitfacts-"));
    const repo = join(dir, "repo");
    try {
      mkdirSync(repo);
      await g(repo, ["init", "-b", "main"]);
      await g(repo, ["config", "user.email", "t@t"]);
      await g(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      await g(repo, ["add", "."]);
      await g(repo, ["commit", "-m", "secret-message-1"]);
      // Second commit on a branch off main, plus a dirty + an untracked file — the write
      // leg's end state that a handoff brief points at.
      await g(repo, ["checkout", "-b", "sig/relay-1"]);
      writeFileSync(join(repo, "b.txt"), "b\n");
      await g(repo, ["add", "b.txt"]);
      await g(repo, ["commit", "-m", "second-commit"]);
      writeFileSync(join(repo, "c.txt"), "untracked-content-xyz");
      writeFileSync(join(repo, "a.txt"), "a2\n");

      const facts = await collectGitFacts(repo, "main");
      expect(facts.commits).toHaveLength(1);
      expect(facts.commits![0]).toMatch(/^[0-9a-f]{40}$/);
      expect(facts.changedFiles).toContain("b.txt");
      expect(facts.changedFiles).toContain("a.txt");
      expect(facts.changedFiles).toContain("c.txt"); // untracked included
      expect(facts.dirty).toBeGreaterThanOrEqual(2);
      expect(facts.ahead).toBe(1);
      expect(JSON.stringify(facts)).not.toContain("secret-message"); // no commit messages
      expect(JSON.stringify(facts)).not.toContain("untracked-content-xyz"); // no file contents
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  }, 30_000);
});
