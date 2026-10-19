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

/** The same notice for a web-only deployment, where the key goes into the workspace's Settings and
 *  the Feishu-era commands do not exist. */
export const NO_MODEL_KEY_WEB_NOTICE = "⚠️ 还没有配置模型 key，所以我暂时听不懂自然语言。在右上角头像的「设置」里粘贴模型 API key，然后再发一次即可。";

/** The provider rejected the key itself: 401/403 authentication failures in the model error
 *  detail (DeepSeek answers `Authentication Fails, Your api key ... is invalid`). Retrying
 *  cannot fix this — the pilot deployment hit it with a pasted-but-invalid key, and the
 *  generic "try again" notice sent the user nowhere. */
export const INVALID_MODEL_KEY_WEB_NOTICE =
  "⚠️ 模型服务拒绝了这个 API key（401 密钥无效或已失效）。在右上角头像的「设置」里重新粘贴有效的 key，然后再发一次。";
export const INVALID_MODEL_KEY_NOTICE =
  "⚠️ 模型服务拒绝了这个 API key（401 密钥无效或已失效）。更新 MODEL_KEY（或在工作台「设置」里重新粘贴）后再发一次。";

/** The provider error classes that mean "the key is the problem". Written loosely on
 *  purpose: vendors word these differently and the cost of a false negative is the generic
 *  notice, never a wrong instruction. */
export function isModelAuthFailure(detail: string): boolean {
  return /\b40[13]\b|authentication_error|authentication fails|invalid api key|api key[^.]{0,40}invalid/i.test(detail);
}

/** `selection` is Steward.llmSelection(): the faux test provider carries no key by design.
 *  `modelErrorDetail` is the provider-facing error text of the failed call, when one is
 *  known (the transcript tail's errorMessage) — a keyed deployment whose key was rejected
 *  is told to fix the key, not to retry. */
export function failedRunNotice(
  selection: { provider: string; apiKey: boolean },
  web = false,
  modelErrorDetail?: string,
): string {
  if (selection.provider !== "faux" && !selection.apiKey) return web ? NO_MODEL_KEY_WEB_NOTICE : NO_MODEL_KEY_NOTICE;
  if (selection.apiKey && modelErrorDetail && isModelAuthFailure(modelErrorDetail)) {
    return web ? INVALID_MODEL_KEY_WEB_NOTICE : INVALID_MODEL_KEY_NOTICE;
  }
  return FAILED_RUN_NOTICE;
}
