import { basename } from "node:path";
import { promisify } from "node:util";
import type { RegisterRepoResult } from "@alexlikevibe/protocol";
import type { LocalStore } from "./store.ts";
import { identifyWorkspace } from "./worktree.ts";

export class DirectoryError extends Error {
  readonly code = "invalid_directory";
}

export async function registerRepository({ store, path }: { store: LocalStore; path: string }): Promise<RegisterRepoResult["repo"]> {
  let identity: Awaited<ReturnType<typeof identifyWorkspace>>;
  try {
    identity = await identifyWorkspace(path);
  } catch {
    throw new DirectoryError("Choose an existing directory on this machine.");
  }
  const repo = { repoId: identity.repoId, name: basename(identity.repoId), path: identity.repoId, capability: identity.capability };
  store.addRepo(repo);
  const branch = identity.capability.kind === "git" ? identity.capability.defaultBranch : null;
  const remote = identity.capability.kind === "git" ? identity.capability.remote : null;
  return { repoId: repo.repoId, name: repo.name, path: repo.path, capability: identity.capability, defaultBranch: branch ?? "", remote: remote ?? "" };
}
