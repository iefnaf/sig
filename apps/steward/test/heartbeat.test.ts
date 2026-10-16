// ADR-0001 correction to protocol §3.2: bidirectional application-level heartbeat. The
// connector sends uplink `ping`; the DO must answer downlink `pong` so the connector's
// inter-frame timeout can detect a silently-dead downlink (spike bug 10).
import { describe, expect, it } from "vitest";
import { connectAndHello, pairDevice } from "./helpers.ts";

describe("heartbeat", () => {
  it("replies pong to every ping, echoing its id", async () => {
    const { deviceId, token } = await pairDevice("heartbeat-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    for (const id of ["p1", "p2", "p3"]) {
      ws.send(JSON.stringify({ t: "ping", id }));
      const pong = await reader.nextWhere((m) => m.t === "pong");
      expect(pong.re).toBe(id);
    }
  });

  it("interleaves pongs with other traffic (cmd frames) without breaking either", async () => {
    const { deviceId, token } = await pairDevice("heartbeat-interleave");
    const { ws, reader } = await connectAndHello(deviceId, token);
    const { ownerStub } = await import("./helpers.ts");
    const cmdPromise = ownerStub().enqueue(deviceId, "diag", {});

    const cmd = await reader.nextWhere((m) => m.t === "cmd");
    ws.send(JSON.stringify({ t: "ping", id: "px" }));
    const pong = await reader.nextWhere((m) => m.t === "pong");
    expect(pong.re).toBe("px");
    expect((await cmdPromise).cmdId).toBe(cmd.id);
  });
});
