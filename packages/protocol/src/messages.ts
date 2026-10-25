// Message schemas, docs/design/connector-do-protocol.md §6. Only the handshake (hello/welcome/error)
// is needed for this slice; commands/events arrive with the outbox/event-stream tickets.
import { z } from "zod";
import { type RepoCapability } from "./git.ts";

export const PROTOCOL_VERSION = { min: 1, max: 1 } as const;

const ProtocolRangeSchema = z.object({ min: z.number().int(), max: z.number().int() });

const AgentCapabilitySchema = z.object({
  kind: z.string(),
  version: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
});

const RepoCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git"), gitRoot: z.string(), defaultBranch: z.string().nullable(), remote: z.string().nullable() }),
  z.object({ kind: z.literal("plain") }),
]);

export const RepoSchema = z.object({
  repoId: z.string(),
  name: z.string(),
  path: z.string(),
  /** @deprecated superseded by `capability`; kept so a pre-this-change connector's payload
   *  still parses on a mixed-version fleet. A pre-this-change connector could only ever
   *  register a Git repo, so `capabilityOf()` below bridges it exactly, not a guess. */
  defaultBranch: z.string(),
  remote: z.string(),
  capability: RepoCapabilitySchema.optional(),
});

/** The one place a `Repo` (old wire shape, new wire shape, or a mix mid-rollout) becomes a
 *  real `RepoCapability`. Every reader should call this instead of reading `.defaultBranch`/
 *  `.remote`/`.capability` directly. */
export function capabilityOf(repo: { capability?: RepoCapability; path: string; defaultBranch: string; remote: string }): RepoCapability {
  return repo.capability ?? { kind: "git", gitRoot: repo.path, defaultBranch: repo.defaultBranch || null, remote: repo.remote || null };
}

const WorkerSnapshotSchema = z.object({
  workerId: z.string(),
  agent: z.string(),
  state: z.string(),
  lastSeq: z.number().int(),
  sessionId: z.string(),
  lastOutcome: z.string(),
});

// `state` may be any command state; `code` rides a recovered `failed` (e.g.
// not_delivered from the §6.3 session-tail adjudication) so the DO can surface it.
const PendingAckSchema = z.object({
  cmdId: z.string(),
  state: z.string(),
  code: z.string().optional(),
});

export const HelloMessageSchema = z.object({
  t: z.literal("hello"),
  id: z.string(),
  protocol: ProtocolRangeSchema,
  deviceId: z.string(),
  bootId: z.string(),
  connEpoch: z.number().int(),
  connector: z.object({ version: z.string(), os: z.string(), arch: z.string(), node: z.string() }),
  capabilities: z.object({ directoryBrowse: z.boolean().optional() }).optional(),
  machine: z.object({ name: z.string(), memTotalMB: z.number(), memFreeMB: z.number() }),
  agents: z.array(AgentCapabilitySchema),
  repos: z.array(RepoSchema),
  limits: z.object({ maxWorkers: z.number().int(), running: z.number().int() }),
  workers: z.array(WorkerSnapshotSchema),
  pendingAcks: z.array(PendingAckSchema),
});

export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const WelcomeMessageSchema = z.object({
  t: z.literal("welcome"),
  re: z.string(),
  protocol: z.number().int(),
  serverTime: z.number().int(),
  sessionId: z.string(),
  acks: z.record(z.string(), z.number().int()),
  limits: z.object({
    maxMessageBytes: z.number().int(),
    batchMs: z.number().int(),
    batchEvents: z.number().int(),
  }),
  // SERVER_KEY rotation (issue #27): when the connection authenticated with a non-primary
  // key, the DO hands the connector a freshly minted primary-key token; the connector
  // persists it and uses it for every future reconnect. Absent on normal welcomes.
  token: z.string().optional(),
});

export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;

const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "busy",
  "expired",
  "unsupported",
  "too_large",
  "rate_limited",
  "internal",
  // History relay (§6.6): the worker exists but has no session to read (connector-pi.md §11.4).
  "no_history",
]);

export const ErrorMessageSchema = z.object({
  t: z.literal("error"),
  re: z.string(),
  code: ErrorCode,
  message: z.string(),
  retriable: z.boolean(),
});

export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
