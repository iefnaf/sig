import { describe, expect, it } from "vitest";
import {
  FAILED_RUN_NOTICE,
  INVALID_MODEL_KEY_NOTICE,
  INVALID_MODEL_KEY_WEB_NOTICE,
  NO_MODEL_KEY_NOTICE,
  NO_MODEL_KEY_WEB_NOTICE,
  failedRunNotice,
  isModelAuthFailure,
} from "../src/owner-notices.ts";

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

  it("on the web the key is added in Settings, and no Feishu command is promised", () => {
    const notice = failedRunNotice({ provider: "deepseek", apiKey: false }, true);
    expect(notice).toBe(NO_MODEL_KEY_WEB_NOTICE);
    expect(notice).toContain("设置");
    expect(notice).not.toMatch(/MODEL_KEY|\/网页|\/加机器|飞书/);
    expect(failedRunNotice({ provider: "deepseek", apiKey: true }, true)).toBe(FAILED_RUN_NOTICE);
  });

  it("a keyed deployment keeps the generic failure notice", () => {
    expect(failedRunNotice({ provider: "deepseek", apiKey: true })).toBe(FAILED_RUN_NOTICE);
  });

  it("the faux test provider has no key by design and is never reported as missing one", () => {
    expect(failedRunNotice({ provider: "faux", apiKey: false })).toBe(FAILED_RUN_NOTICE);
  });
});

describe("a keyed deployment whose key the provider rejects", () => {
  // The real DeepSeek answer (pilot deployment, 2026-10-19): the pasted key was invalid.
  const deepseek401 = '401: {"message":"Authentication Fails, Your api key: ****6eb2 is invalid","type":"authentication_error"}';

  it("isModelAuthFailure recognizes the vendor wordings", () => {
    expect(isModelAuthFailure(deepseek401)).toBe(true);
    expect(isModelAuthFailure("403: forbidden")).toBe(true);
    expect(isModelAuthFailure("Invalid API key provided")).toBe(true);
    expect(isModelAuthFailure("500: upstream timeout")).toBe(false);
    expect(isModelAuthFailure("model overloaded")).toBe(false);
  });

  it("tells the owner to fix the key, not to retry", () => {
    expect(failedRunNotice({ provider: "deepseek", apiKey: true }, true, deepseek401)).toBe(INVALID_MODEL_KEY_WEB_NOTICE);
    expect(failedRunNotice({ provider: "deepseek", apiKey: true }, false, deepseek401)).toBe(INVALID_MODEL_KEY_NOTICE);
    expect(INVALID_MODEL_KEY_WEB_NOTICE).toContain("设置");
    expect(INVALID_MODEL_KEY_WEB_NOTICE).not.toContain("稍后再试");
  });

  it("non-auth failures keep the generic notice, and a missing key outranks the detail", () => {
    expect(failedRunNotice({ provider: "deepseek", apiKey: true }, true, "500: upstream")).toContain("暂时不可用");
    expect(failedRunNotice({ provider: "deepseek", apiKey: true }, true, undefined)).toBe(FAILED_RUN_NOTICE);
    expect(failedRunNotice({ provider: "deepseek", apiKey: false }, true, deepseek401)).toBe(NO_MODEL_KEY_WEB_NOTICE);
  });
});

describe("actionable model failure messages", () => {
  it.each([
    ["429: rate limit exceeded", "请求过于频繁"],
    ["402: insufficient balance", "额度不足"],
    ["insufficient_quota", "额度不足"],
    ["request timed out", "超时"],
    ["404: model_not_found", "模型或端点"],
    ["503: service unavailable", "暂时不可用"],
  ])("explains %s without exposing the upstream payload", (detail, expected) => {
    const notice = failedRunNotice({ provider: "deepseek", apiKey: true }, true, detail + " secret-key-should-not-leak");
    expect(notice).toContain(expected);
    expect(notice).not.toContain("总管");
    expect(notice).not.toContain("secret-key-should-not-leak");
  });

  it("gives a concrete next step when the cause is unknown", () => {
    const notice = failedRunNotice({ provider: "deepseek", apiKey: true }, true);
    expect(notice).toContain("测试连接");
    expect(notice).not.toContain("总管");
  });
});
