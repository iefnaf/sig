// Deterministic notices the owner sees when the model could not answer (steward.md §6.2 source
// 3, issue #6). Written by the core, not the LLM: they have to work precisely when the model
// does not.

/** A user-triggered run settled without an answer: the model call failed or was interrupted. */
export const FAILED_RUN_NOTICE = "⚠️ 总管这轮没有跑成（模型调用失败或被中断），这条消息我没能处理；稍后再试或重发一次。";

/** A fresh deployment has no model key yet — the first thing a new owner hits, and "try again"
 *  cannot fix it. /网页 and /加机器 are deterministic (they mint credentials without a model),
 *  so the notice points at what already works. */
export const NO_MODEL_KEY_NOTICE =
  "⚠️ 还没有配置模型 key，所以我暂时听不懂自然语言。给这个部署设置 MODEL_KEY 后再发一次即可（部署指南「模型配置」一节）。" +
  "/网页、/加机器 这两个命令不需要模型，现在就能用。";

/** `selection` is Steward.llmSelection(): the faux test provider carries no key by design. */
export function failedRunNotice(selection: { provider: string; apiKey: boolean }): string {
  return selection.provider !== "faux" && !selection.apiKey ? NO_MODEL_KEY_NOTICE : FAILED_RUN_NOTICE;
}
