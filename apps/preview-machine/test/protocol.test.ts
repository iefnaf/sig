import { HelloMessageSchema } from "@nightboats/protocol";
import { describe, expect, it } from "vitest";
import { buildHello, scriptForStartWorker, workerEvent } from "../src/protocol.ts";

describe("preview machine protocol", () => {
  it("sends a schema-valid hello with one repository", () => {
    const hello = buildHello({ deviceId: "dev_preview" }, "boot-preview", 3, []);

    expect(HelloMessageSchema.safeParse(hello).success).toBe(true);
    expect(hello.machine).toMatchObject({ name: "preview-machine" });
    expect(hello.repos).toHaveLength(1);
  });

  it("builds worker event batches", () => {
    const event = workerEvent("worker-1", 1, "started", { sessionId: "worker-1" }, 123);

    expect(event.id).toBe("evt-worker-1-1");
    expect(event.batch[0]).toMatchObject({
      workerId: "worker-1",
      seq: 1,
      ts: 123,
      type: "started",
      sessionId: "worker-1",
    });
  });

  it("rejects start_worker without a worker id", () => {
    expect(scriptForStartWorker({})).toEqual({ ok: false, error: { code: "bad_worker_id" } });
  });
});
