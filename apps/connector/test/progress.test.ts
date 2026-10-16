import { describe, expect, it } from "vitest";
import { ProgressThrottle } from "../src/progress.ts";

describe("ProgressThrottle (connector-pi.md §11.2)", () => {
  it("emits the first event immediately", () => {
    const t = new ProgressThrottle();
    expect(t.decide(0, "thinking")).toBe(true);
  });

  it("emits immediately when the tool type changes, after the absolute cap", () => {
    const t = new ProgressThrottle();
    expect(t.decide(0, "tool", "bash")).toBe(true);
    // Tool type changed but the 5s absolute cap still applies ("never more than one per 5s").
    expect(t.decide(4_999, "tool", "edit")).toBe(false);
    expect(t.decide(5_000, "tool", "edit")).toBe(true);
  });

  it("suppresses the same tool type until 15s pass", () => {
    const t = new ProgressThrottle();
    expect(t.decide(0, "tool", "bash")).toBe(true);
    expect(t.decide(5_000, "tool", "bash")).toBe(false);
    expect(t.decide(14_999, "tool", "bash")).toBe(false);
    expect(t.decide(15_000, "tool", "bash")).toBe(true);
  });

  it("phase change counts as a type change", () => {
    const t = new ProgressThrottle();
    expect(t.decide(0, "tool", "bash")).toBe(true);
    expect(t.decide(5_000, "thinking")).toBe(true);
    expect(t.decide(9_000, "thinking")).toBe(false);
  });

  it("thinking events without a tool are keyed by phase alone", () => {
    const t = new ProgressThrottle();
    expect(t.decide(0, "thinking")).toBe(true);
    expect(t.decide(10_000, "thinking")).toBe(false);
    expect(t.decide(15_000, "thinking")).toBe(true);
  });
});
