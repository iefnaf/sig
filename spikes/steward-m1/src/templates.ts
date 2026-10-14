// Notification templates (steward.md §6.4): fixed three-part reports rendered from ledger data.
// The steward (LLM) never touches these in M1; the scheduler renders intents directly.
import { Memory } from "./memory.ts";

export interface NotifyPayload {
	conclusion: string; // one sentence, <= 80 chars
	did: string[]; // <= 4 bullets
	needsYou?: string; // <= 120 chars, omitted when nothing is needed
	urgency: "push" | "quiet";
	/** Message tone drives presentation (card color), independent of needsYou. */
	tone: "success" | "attention" | "failure";
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function renderNotify(memory: Memory, template: string, workerId: string, extra?: Record<string, unknown>): NotifyPayload {
	const w = memory.worker(workerId);
	const r = memory.latestReport(workerId);
	const branch = r?.git?.branch ?? w?.branch;
	switch (template) {
		case "done_report": {
			if (!r) throw new Error(`done_report: no report for ${workerId}`);
			const did: string[] = [...(r.changes ?? []).slice(0, 3)];
			if (r.tests?.ran) did.push(`测试${r.tests.passed === true ? "通过" : r.tests.passed === false ? "未通过" : "已运行"}`);
			if (branch) did.push(`分支 ${branch}${r.git?.pushed ? "（已推送）" : "（未推送）"}`);
			return {
				conclusion: clip(r.summary || "任务完成", 80),
				did: did.slice(0, 4).map((d) => clip(d, 100)),
				needsYou: !r.git?.pushed && branch ? "是否推送并开 PR？" : undefined,
				urgency: "push",
				tone: "success",
			};
		}
		case "decision_fallback": {
			const q = extra?.question as string | undefined;
			return {
				conclusion: "worker 在等你做决定",
				did: q ? [clip(q, 200)] : ["worker 提出了一个问题，需要你的回答。"],
				needsYou: "回复这条消息即可转达给 worker。",
				urgency: "push",
				tone: "attention",
			};
		}
		case "error_auth":
			return { conclusion: "任务失败：模型凭据不可用", did: ["worker 所在机器上的模型登录已失效（auth 错误）。"], needsYou: "到那台机器上重新登录模型，然后说「继续」。", urgency: "push", tone: "failure" };
		case "error_context":
			return { conclusion: "任务暂停：上下文接近上限", did: ["这个 session 的上下文快满了，继续下去质量会下降。"], needsYou: "让总管开一个新 session 接力（会附交接简报），或直接结束。", urgency: "push", tone: "attention" };
		case "broken":
			return { conclusion: "worker 无法自动恢复", did: [`原因：${clip(String(extra?.reason ?? "未知"), 160)}`], needsYou: "重试、换一台机器，还是放弃？", urgency: "push", tone: "attention" };
		default:
			throw new Error(`unknown template ${template}`);
	}
}
