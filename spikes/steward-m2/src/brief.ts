// The situation brief (steward.md §4.1): live state injected as a prompt section on every request.
import { Memory } from "../../steward-m1/src/memory.ts";

export function buildBrief(memory: Memory): string {
	const s = memory.situation();
	if (!s.threads.length) return "当前没有任何 Thread。机器在线。";
	const lines = s.threads.slice(0, 12).map((t) => {
		const state = t.state === "running" ? "进行中" : t.state === "waiting_you" ? "等你" : "空闲";
		const flag = t.unread ? "（有未读汇报）" : "";
		return `- ${t.threadId}「${t.title}」${state}${flag}`;
	});
	return ["Thread 一览：", ...lines].join("\n");
}
