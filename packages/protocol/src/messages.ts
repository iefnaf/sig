// Message schemas, docs/design/connector-do-protocol.md §6. Only the handshake (hello/welcome/error)
// is needed for this slice; commands/events arrive with the outbox/event-stream tickets.
import { z } from "zod";

export const PROTOCOL_VERSION = { min: 1, max: 1 } as const;

const ProtocolRangeSchema = z.object({ min: z.number().int(), max: z.number().int() });

const AgentCapabilitySchema = z.object({
  kind: z.string(),
  version: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
});

const RepoSchema = z.object({
  repoId: z.string(),
  name: z.string(),
  path: z.string(),
  defaultBranch: z.string(),
  remote: z.string(),
});

const WorkerSnapshotSchema = z.object({
  workerId: z.string(),
  agent: z.string(),
  state: z.string(),
  lastSeq: z.number().int(),
  sessionId: z.string(),
  lastOutcome: z.string(),
});

const PendingAckSchema = z.object({
  cmdId: z.string(),
  state: z.string(),
});

export const HelloMessageSchema = z.object({
  t: z.literal("hello"),
  id: z.string(),
  protocol: ProtocolRangeSchema,
  deviceId: z.string(),
  bootId: z.string(),
  connEpoch: z.number().int(),
  connector: z.object({ version: z.string(), os: z.string(), arch: z.string(), node: z.string() }),
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
]);

export const ErrorMessageSchema = z.object({
  t: z.literal("error"),
  re: z.string(),
  code: ErrorCode,
  message: z.string(),
  retriable: z.boolean(),
});

export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
