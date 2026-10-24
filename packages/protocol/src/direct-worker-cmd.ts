// Direct worker commands from an open session view (issue #84, ADR-0011,
// docs/design/connector-do-protocol.md §6.8): a browser that already has a worker's session
// view open may send/interrupt that worker directly, without routing through Sig's
// conversation. v1 scope is deliberately the mechanical subset of §6.2 that already has a
// deterministic, LLM-free dispatch path — `resume`/`stop_process` are not included.
import { z } from "zod";

/** browser → DO: declare which worker's session view is open. Required before `worker_cmd`;
 *  tracked on the connection itself, never inferred from any other state. */
export const SubscribeMessageSchema = z.object({
  t: z.literal("subscribe"),
  workerId: z.string().min(1),
});
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;

/** browser → DO: the session view closed (or is switching workers) — ends `worker_cmd`
 *  eligibility until the next `subscribe`. */
export const UnsubscribeMessageSchema = z.object({
  t: z.literal("unsubscribe"),
});
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;

const WorkerCmdArgsSchema = z.object({
  /** `kind: "send"` */
  text: z.string().optional(),
  intent: z.enum(["now", "after", "auto"]).optional(),
  /** `kind: "interrupt"`: "停，然后……" */
  then: z.string().optional(),
});

/** browser → DO → connector: dispatched exactly like a steward-issued `cmd` (§4.2), with no
 *  steward/LLM step in between. `id` is the caller's `sh_web_request` and becomes the
 *  resulting command's `cmdId` directly (§7.1). */
export const WorkerCmdMessageSchema = z.object({
  t: z.literal("worker_cmd"),
  id: z.string().min(1),
  workerId: z.string().min(1),
  kind: z.enum(["send", "interrupt"]),
  args: WorkerCmdArgsSchema.optional(),
});
export type WorkerCmdMessage = z.infer<typeof WorkerCmdMessageSchema>;
