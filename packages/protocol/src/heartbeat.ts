// Bidirectional application-level heartbeat (ADR-0001 correction to protocol §3.2):
// the connector sends uplink `ping`, the DO replies downlink `pong`.
import { z } from "zod";

export const PingMessageSchema = z.object({
  t: z.literal("ping"),
  id: z.string(),
});

export type PingMessage = z.infer<typeof PingMessageSchema>;

export const PongMessageSchema = z.object({
  t: z.literal("pong"),
  re: z.string(),
});

export type PongMessage = z.infer<typeof PongMessageSchema>;
