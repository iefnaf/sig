import { describe, expect, it } from "vitest";
import { FAILED_RUN_NOTICE, NO_MODEL_KEY_NOTICE, failedRunNotice } from "../src/owner-notices.ts";

describe("the notice for a user run that did not complete", () => {
  it("a deployment with no model key is told so — retrying cannot fix it", () => {
    const notice = failedRunNotice({ provider: "deepseek", apiKey: false });
    expect(notice).toBe(NO_MODEL_KEY_NOTICE);
    expect(notice).toContain("MODEL_KEY");
    // The commands that mint credentials work without a model; the notice says so.
    expect(notice).toContain("/网页");
    expect(notice).toContain("/加机器");
    expect(notice).not.toContain("稍后再试");
  });

  it("a keyed deployment keeps the generic failure notice", () => {
    expect(failedRunNotice({ provider: "deepseek", apiKey: true })).toBe(FAILED_RUN_NOTICE);
  });

  it("the faux test provider has no key by design and is never reported as missing one", () => {
    expect(failedRunNotice({ provider: "faux", apiKey: false })).toBe(FAILED_RUN_NOTICE);
  });
});
