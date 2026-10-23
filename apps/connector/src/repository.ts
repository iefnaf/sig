import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { RegisterRepoResult } from "@nightboats/protocol";
import type { LocalStore } from "./store.ts";
import { defaultBranch, repoTopLevel } from "./worktree.ts";

const exec = promisify(execFile);

export class DirectoryError extends Error {
  readonly code = "invalid_directory";
}

export async function registerRepository({ store, path }: { store: LocalStore; path: string }): Promise<RegisterRepoResult["repo"]> {
  let topLevel: string;
  try {
    topLevel = await repoTopLevel(path);
  } catch {
    throw new DirectoryError("Choose an existing Git directory on this machine.");
  }
  let remote: string | null = null;
  try {
    const { stdout } = await exec("git", ["config", "--get", "remote.origin.url"], { cwd: topLevel, timeout: 30_000 });
    remote = stdout.trim() || null;
  } catch {}
  const branch = await defaultBranch(topLevel).catch(() => null);
  const repo = { repoId: topLevel, name: basename(topLevel), path: topLevel, defaultBranch: branch, remote };
  store.addRepo(repo);
  return { ...repo, defaultBranch: branch ?? "", remote: remote ?? "" };
}
