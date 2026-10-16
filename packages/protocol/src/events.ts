// Events (connector -> DO) and their acks/resync, docs/design/connector-do-protocol.md §4.3, §6.4.
import { z } from "zod";

export const WorkerEventSchema = z
  .object({
    workerId: z.string(),
    seq: z.number().int(),
    ts: z.number().int(),
    type: z.string(),
  })
  .catchall(z.unknown());

export type WorkerEvent = z.infer<typeof WorkerEventSchema>;

export const EventsMessageSchema = z.object({
  t: z.literal("events"),
  id: z.string(),
  batch: z.array(WorkerEventSchema).min(1),
});

export type EventsMessage = z.infer<typeof EventsMessageSchema>;

export const EventsAckMessageSchema = z.object({
  t: z.literal("events_ack"),
  workerId: z.string(),
  upTo: z.number().int(),
});

export type EventsAckMessage = z.infer<typeof EventsAckMessageSchema>;

export const ResyncMessageSchema = z.object({
  t: z.literal("resync"),
  workerId: z.string(),
  from: z.number().int(),
});

export type ResyncMessage = z.infer<typeof ResyncMessageSchema>;

export const EventsGapMessageSchema = z.object({
  t: z.literal("events_gap"),
  workerId: z.string(),
  from: z.number().int(),
  to: z.number().int(),
});

export type EventsGapMessage = z.infer<typeof EventsGapMessageSchema>;
