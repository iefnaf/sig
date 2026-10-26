import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  DIRECTORY_MAX_BYTES,
  DIRECTORY_MAX_ENTRIES,
  type DirectoryBrowseArgs,
  type DirectoryBrowseResult,
  type DirectoryListing,
} from "@alexlikevibe/protocol";

const MAX_SCANNED_ENTRIES = 10_000;

export async function browseDirectory(args: DirectoryBrowseArgs): Promise<DirectoryBrowseResult> {
  const requested = args.path ?? "~";
  const home = os.homedir();
  const expanded = requested === "~" ? home : requested.startsWith("~/") ? join(home, requested.slice(2)) : requested;
  if (!isAbsolute(expanded)) return { ok: false, code: "invalid_directory" };
  try {
    const path = await realpath(expanded);
    const canonicalHome = await realpath(home).catch(() => home);
    const listing: DirectoryListing = {
      path, home: canonicalHome, parent: dirname(path) === path ? null : dirname(path), directories: [], truncated: false,
    };
    let bytes = Buffer.byteLength(JSON.stringify(listing));
    let scanned = 0;
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++scanned > MAX_SCANNED_ENTRIES) { listing.truncated = true; break; }
      if (!args.showHidden && entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(child).then((value) => value.isDirectory(), () => false));
      if (!isDirectory) continue;
      const item = { name: entry.name, path: child };
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (listing.directories.length === DIRECTORY_MAX_ENTRIES || bytes + itemBytes > DIRECTORY_MAX_BYTES || child.length > 4096) {
        listing.truncated = true;
        break;
      }
      listing.directories.push(item);
      bytes += itemBytes;
    }
    listing.directories.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, listing };
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { ok: false, code: "not_found" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, code: "forbidden" };
    if (code === "ENOTDIR" || code === "EINVAL" || code === "ENAMETOOLONG") return { ok: false, code: "invalid_directory" };
    return { ok: false, code: "browse_failed" };
  }
}
