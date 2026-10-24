import { describe, expect, it } from "vitest";
import { DIRECTORY_MAX_ENTRIES, DirectoryBrowseArgsSchema, DirectoryListingMessageSchema, DirectoryListingSchema } from "../src/directories.ts";

const listing = { path: "/home/owner", home: "/home/owner", parent: "/home", directories: [], truncated: false };

describe("directory browse boundaries", () => {
  it("accepts defaults and rejects malformed path, hidden option and extra arguments", () => {
    expect(DirectoryBrowseArgsSchema.parse({})).toEqual({});
    for (const input of [{ path: "" }, { path: "\0" }, { path: "x".repeat(4097) }, { showHidden: "true" }, { approved: true }]) {
      expect(DirectoryBrowseArgsSchema.safeParse(input).success).toBe(false);
    }
  });

  it("bounds result count and serialized bytes", () => {
    expect(DirectoryListingSchema.safeParse(listing).success).toBe(true);
    expect(DirectoryListingSchema.safeParse({ ...listing, directories: Array.from({ length: DIRECTORY_MAX_ENTRIES + 1 }, () => ({ name: "x", path: "/x" })) }).success).toBe(false);
    expect(DirectoryListingSchema.safeParse({ ...listing, directories: Array.from({ length: 100 }, () => ({ name: "x", path: `/${"x".repeat(4000)}` })) }).success).toBe(false);
    expect(DirectoryListingMessageSchema.safeParse({ t: "directory_listing", re: "r", ok: false, code: "OS_INTERNAL_DETAIL" }).success).toBe(false);
  });
});
