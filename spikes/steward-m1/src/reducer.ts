// Deterministic reducer (steward.md §5.3): WorkerEvent batch -> ledger updates + intents.
// No LLM anywhere in this file. Every branch is testable.
import { Memory } from "./memory.ts";
import type { ApplyResult, Intent, WorkerEvent } from "./types.ts";

const DECISION_WINDOW_MS = 90_000;

export function applyEvents(memory: Memory, batch: WorkerEvent[], now = Date.now()): ApplyResult {
	const intents: Intent[] = [];
	let applied = 0;
	let duplicated = 0;

	for (const e of batch) {
		if (!memory.acceptEvent(e)) {
			duplicated++;
			continue;
		}
		applied++;
		const w = memory.worker(e.workerId);
		const threadId = w?.threadId;
		if (!threadId) continue; // unknown worker: dropped (connector and DO reconcile first)
		memory.touchThread(threadId, now);

		switch (e.type) {
			case "started": {
				memory.setWorkerState(e.workerId, "running", undefined, now);
				memory.timeline(threadId, "worker_started", `worker 开始运行${e.branch ? `（分支 ${e.branch}）` : ""}`, { workerId: e.workerId });
				break;
			}
			case "progress": {
				const label = [e.tool, e.target].filter(Boolean).join(" ");
				memory.setProgress(e.workerId, label || e.phase || "…", now);
				break;
			}
			case "report": {
				memory.saveReport(e);
				memory.markThreadUnread(threadId);
				memory.setWorkerState(e.workerId, e.status === "done" ? "idle" : "idle", `reported:${e.status}`, now);
				memory.timeline(threadId, "report", `[${e.status}] ${e.summary}`, { workerId: e.workerId, seq: e.seq });
				if (e.status === "done") {
					intents.push({ type: "notify", template: "done_report", threadId, workerId: e.workerId, payload: { workerId: e.workerId, seq: e.seq } });
					intents.push({ type: "wake", threadId, priority: "normal", payload: { reason: "report", workerId: e.workerId } });
				} else {
					// blocked / needs_decision: open a question and give the steward a window first
					const qid = `q_${e.workerId}_${e.seq}`;
					memory.createQuestion(qid, threadId, e.workerId, e.question ?? e.summary, `report:${e.status}`, now);
					intents.push({ type: "decision_window", threadId, workerId: e.workerId, questionId: qid, dueAt: now + DECISION_WINDOW_MS });
					intents.push({ type: "wake", threadId, priority: "high", payload: { reason: "decision", workerId: e.workerId } });
				}
				break;
			}
			case "settled": {
				memory.setWorkerState(e.workerId, "idle", `settled:${e.outcome}`, now);
				if (e.outcome === "error") {
					memory.markThreadUnread(threadId);
					if (e.errorClass === "auth") {
						const qid = `q_${e.workerId}_${e.seq}_auth`;
						memory.createQuestion(qid, threadId, e.workerId, "模型凭据不可用（auth），需要在这台机器上重新登录。", "settled:error:auth", now);
						intents.push({ type: "notify", template: "error_auth", threadId, workerId: e.workerId, payload: { workerId: e.workerId } });
						intents.push({ type: "wake", threadId, priority: "high", payload: { reason: "error:auth" } });
					} else if (e.errorClass === "context") {
						const qid = `q_${e.workerId}_${e.seq}_ctx`;
						memory.createQuestion(qid, threadId, e.workerId, "上下文接近上限，建议开新接力 session（附交接简报）。", "settled:error:context", now);
						intents.push({ type: "notify", template: "error_context", threadId, workerId: e.workerId, payload: { workerId: e.workerId } });
						intents.push({ type: "wake", threadId, priority: "high", payload: { reason: "error:context" } });
					}
					// transient: the connector auto-resumes; nothing to tell the user
				} else if (e.outcome === "unreported") {
					memory.markThreadUnread(threadId);
					const qid = `q_${e.workerId}_${e.seq}_unrep`;
					memory.createQuestion(qid, threadId, e.workerId, `worker 结束但没有汇报。它最后说：${(e.lastText ?? "（无输出）").slice(0, 200)}`, "settled:unreported", now);
					intents.push({ type: "wake", threadId, priority: "high", payload: { reason: "unreported", lastText: e.lastText } });
				}
				memory.timeline(threadId, "settled", `运行结束：${e.outcome}${e.errorClass ? `（${e.errorClass}）` : ""}`, { workerId: e.workerId, seq: e.seq });
				break;
			}
			case "lost": {
				memory.setWorkerState(e.workerId, "unreachable", undefined, now);
				memory.timeline(threadId, "lost", `机器失联，worker 暂停（不算失败）`, { workerId: e.workerId });
				break;
			}
			case "resumed": {
				memory.setWorkerState(e.workerId, "running", undefined, now);
				memory.timeline(threadId, "resumed", `失联后自动续上（第 ${e.attempt ?? 1} 次）`, { workerId: e.workerId });
				break;
			}
			case "broken": {
				memory.setWorkerState(e.workerId, "broken", "broken", now);
				memory.markThreadUnread(threadId);
				const qid = `q_${e.workerId}_${e.seq}_broken`;
				memory.createQuestion(qid, threadId, e.workerId, `worker 无法自动恢复（${e.reason ?? "原因未知"}）。重试、换机器，还是放弃？`, "broken", now);
				intents.push({ type: "notify", template: "broken", threadId, workerId: e.workerId, payload: { workerId: e.workerId, reason: e.reason } });
				intents.push({ type: "wake", threadId, priority: "high", payload: { reason: "broken" } });
				break;
			}
			case "external_activity": {
				memory.timeline(threadId, "external_activity", `检测到本机会话有外部改动（${e.entries ?? "?"} 条）`, { workerId: e.workerId });
				intents.push({ type: "wake", threadId, priority: "low", payload: { reason: "external_activity" } });
				break;
			}
		}
	}

	for (const i of intents) memory.addIntent(i.type, i, now);
	memory.recomputeThreadStates();
	return { applied, duplicated, intents };
}
