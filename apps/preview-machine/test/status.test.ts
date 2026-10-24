import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("PreviewMachine control API", () => {
  it("answers unauthorized status probes without waking a paired machine", async () => {
    const response = await SELF.fetch("https://example.com/status");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("reports the unpaired status through the control API", async () => {
    const response = await SELF.fetch("https://example.com/status", {
      headers: { authorization: "Bearer test-machine-key-not-a-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "unpaired", deviceId: "" });
  });
});
