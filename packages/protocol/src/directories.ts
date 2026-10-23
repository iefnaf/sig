import { z } from "zod";

export const DIRECTORY_MAX_ENTRIES = 500;
export const DIRECTORY_MAX_BYTES = 128 * 1024;
export const DIRECTORY_BROWSE_TIMEOUT_MS = 10_000;

const PathSchema = z.string().min(1).max(4096).regex(/^[^\0]+$/);

export const DirectoryBrowseArgsSchema = z.strictObject({
  path: PathSchema.optional(),
  showHidden: z.boolean().optional(),
});
export type DirectoryBrowseArgs = z.infer<typeof DirectoryBrowseArgsSchema>;

export const DirectoryListingSchema = z.object({
  path: PathSchema,
  home: PathSchema,
  parent: PathSchema.nullable(),
  directories: z.array(z.object({ name: z.string().min(1).max(1024), path: PathSchema })).max(DIRECTORY_MAX_ENTRIES),
  truncated: z.boolean(),
}).refine((listing) => new TextEncoder().encode(JSON.stringify(listing)).byteLength <= DIRECTORY_MAX_BYTES);
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const DirectoryBrowseErrorSchema = z.enum([
  "unsupported", "not_found", "forbidden", "invalid_directory", "browse_failed", "busy",
]);
export type DirectoryBrowseError = z.infer<typeof DirectoryBrowseErrorSchema>;

export const DirectoryListMessageSchema = DirectoryBrowseArgsSchema.extend({
  t: z.literal("directory_list"),
  id: z.string().min(1).max(128),
});
export type DirectoryListMessage = z.infer<typeof DirectoryListMessageSchema>;

export const DirectoryListingMessageSchema = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("directory_listing"), re: z.string().min(1).max(128), ok: z.literal(true), listing: DirectoryListingSchema }),
  z.object({ t: z.literal("directory_listing"), re: z.string().min(1).max(128), ok: z.literal(false), code: DirectoryBrowseErrorSchema }),
]);
export type DirectoryListingMessage = z.infer<typeof DirectoryListingMessageSchema>;
export type DirectoryBrowseResult =
  | { ok: true; listing: DirectoryListing }
  | { ok: false; code: DirectoryBrowseError };
