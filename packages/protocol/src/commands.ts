// Commands (DO -> connector) and their acks/results, docs/design/connector-do-protocol.md §4.2, §6.2-6.3.
import { z } from "zod";
import { RepoSchema } from "./messages.ts";

export const RegisterRepoArgsSchema = z.strictObject({
  path: z.string().min(1).max(4096).regex(/^[^\0]+$/),
});

export const RegisterRepoResultSchema = z.object({
  repo: RepoSchema.refine((repo) => repo.repoId !== "" && repo.name !== "" && repo.path !== ""),
});
export type RegisterRepoResult = z.infer<typeof RegisterRepoResultSchema>;

export const CmdMessageSchema = z.object({
  t: z.literal("cmd"),
  id: z.string(),
  cseq: z.number().int(),
  kind: z.string(),
  workerId: z.string().optional(),
  notAfter: z.number().int().nullable().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export type CmdMessage = z.infer<typeof CmdMessageSchema>;

const CmdAckStatus = z.enum(["accepted", "duplicate", "rejected", "ambiguous"]);

export const CmdResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type CmdResult = z.infer<typeof CmdResultSchema>;

export const CmdAckMessageSchema = z.object({
  t: z.literal("cmd_ack"),
  re: z.string(),
  status: CmdAckStatus,
  result: CmdResultSchema.optional(),
  code: z.string().optional(),
});

export type CmdAckMessage = z.infer<typeof CmdAckMessageSchema>;

export const CmdResultMessageSchema = z.object({
  t: z.literal("cmd_result"),
  re: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type CmdResultMessage = z.infer<typeof CmdResultMessageSchema>;
