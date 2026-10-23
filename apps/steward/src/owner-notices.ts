// Deterministic notices the owner sees when the model could not answer (steward.md §6.2 source
// 3, issue #6). Written by the core, not the LLM: they have to work precisely when the model
// does not.

/** A user-triggered run settled without an answer: the model call failed or was interrupted. */
export const FAILED_RUN_NOTICE = "⚠️ Sig 暂时无法回复：模型请求未完成。请在「设置 → 模型服务」中测试连接，确认可用后重新发送这条消息。";

/** A fresh deployment has no model key yet — the first thing a new owner hits, and "try again"
 *  cannot fix it. /网页 and /加机器 are deterministic (they mint credentials without a model),
 *  so the notice points at what already works. */
export const NO_MODEL_KEY_NOTICE =
  "⚠️ 还没有配置模型 key，所以我暂时听不懂自然语言。给这个部署设置 MODEL_KEY 后再发一次即可（部署指南「模型配置」一节）。" +
  "/网页、/加机器 这两个命令不需要模型，现在就能用。";

/** The same notice for a web-only deployment, where the key goes into the workspace's Settings and
 *  the Feishu-era commands do not exist. */
export const NO_MODEL_KEY_WEB_NOTICE = "⚠️ 还没有连接模型。请打开右上角「设置 → 模型服务」，添加 API 密钥并测试连接，然后重新发送这条消息。";

/** The provider rejected the key itself: 401/403 authentication failures in the model error
 *  detail (DeepSeek answers `Authentication Fails, Your api key ... is invalid`). Retrying
 *  cannot fix this — the pilot deployment hit it with a pasted-but-invalid key, and the
 *  generic "try again" notice sent the user nowhere. */
export const INVALID_MODEL_KEY_WEB_NOTICE =
  "⚠️ 模型服务拒绝了访问。请在「设置 → 模型服务」中检查 API 密钥、套餐、地区和模型权限，然后测试连接。";
export const INVALID_MODEL_KEY_NOTICE =
  "⚠️ 模型服务拒绝了访问。请检查 MODEL_KEY，以及所选套餐、地区和模型权限；也可以在工作台「设置 → 模型服务」中更新密钥并测试连接。";

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
  reason?: string,
): string {
  if (selection.provider !== "faux" && !selection.apiKey) return web ? NO_MODEL_KEY_WEB_NOTICE : NO_MODEL_KEY_NOTICE;
  if (selection.apiKey && modelErrorDetail && isModelAuthFailure(modelErrorDetail)) {
    return web ? INVALID_MODEL_KEY_WEB_NOTICE : INVALID_MODEL_KEY_NOTICE;
  }
  if (reason === "no_model") return "⚠️ 所选模型不可用。请在「设置 → 模型服务」中选择可用的模型并测试连接，然后重新发送这条消息。";
  if (reason === "aborted" || reason === "interrupted" || reason === "cancelled") return "⚠️ 回复已中断，这条消息尚未处理完成。请重新发送。";
  const detail = modelErrorDetail ?? "";
  if (/\b402\b|insufficient[_ ](?:quota|balance|credits)|credit balance|quota exceeded|余额不足/i.test(detail)) {
    return "⚠️ 模型服务的额度不足，暂时无法回复。请打开「设置 → 模型服务」中的控制台链接，检查余额或套餐额度，恢复后重新发送这条消息。";
  }
  if (/\b429\b|rate[_ -]?limit|too many requests/i.test(detail)) return "⚠️ 模型服务提示请求过于频繁。请稍等片刻，再重新发送这条消息。";
  if (/timed? ?out|timeout|\b(?:408|504)\b/i.test(detail)) return "⚠️ 等待模型回复超时。请重新发送这条消息；如果持续超时，可在「设置 → 模型服务」中测试连接或切换模型。";
  if (/\b404\b|model[_ ]not[_ ]found|unknown model/i.test(detail)) return "⚠️ 所选模型或端点不可用。请在「设置 → 模型服务」中检查套餐、地区和模型，然后测试连接。";
  if (/\b5\d\d\b|overloaded|service unavailable/i.test(detail)) return "⚠️ 模型服务暂时不可用。请稍后重新发送这条消息，或在设置中切换其他模型服务。";
  return FAILED_RUN_NOTICE;
}
