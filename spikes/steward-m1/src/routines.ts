// Built-in routines (spec §8.3): the only proactive behavior with a recorded origin —
// a sh_routine row created by the owner, not by the steward LLM. Everything here is
// deterministic ledger rendering, mirroring templates.ts: no LLM anywhere in this file.
import { Memory } from "./memory.ts";
import type { NotifyPayload } from "./templates.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Next due time for a schedule: `every@<seconds>` (tests, short loops) or `daily@HH:MM` (UTC). */
export function nextDue(schedule: string, from = Date.now()): number {
	const every = /^every@(\d+)$/.exec(schedule);
	if (every) return from + Number(every[1]) * 1000;
	const daily = /^daily@(\d{1,2}):(\d{2})$/.exec(schedule);
	if (daily) {
		const t = new Date(from);
		t.setUTCHours(Number(daily[1]), Number(daily[2]), 0, 0);
		if (t.getTime() <= from) t.setUTCDate(t.getUTCDate() + 1);
		return t.getTime();
	}
	throw new Error(`bad schedule: ${schedule}`);
}

/**
 * The digest routine's content: what is running, what is waiting on the owner, what is
 * unread. Returns null when there is nothing to say — a quiet routine sends nothing
 * rather than an empty card.
 */
export function renderDigest(memory: Memory): NotifyPayload | null {
	const running = memory.db.all<{ workerId: string; threadId: string; lastProgress: string | null }>(
		`SELECT workerId, threadId, lastProgress FROM sh_worker WHERE state = 'running' ORDER BY rowid DESC LIMIT 5`,
	);
	const questions = memory.db.all<{ text: string }>(
		`SELECT text FROM sh_question WHERE status = 'open' ORDER BY askedAt DESC LIMIT 3`,
	);
	const unread = memory.db.all<{ title: string }>(
		`SELECT title FROM sh_thread WHERE unread = 1 AND archived = 0 ORDER BY lastActivityAt DESC LIMIT 5`,
	);
	if (!running.length && !questions.length && !unread.length) return null;

	const titles = new Map(memory.situation().threads.map((t) => [t.threadId, t.title]));
	const did: string[] = [];
	if (running.length) {
		did.push(`进行中 ${running.length} 个：` + running.map((w) => `${titles.get(w.threadId) ?? w.threadId}（${clip(w.lastProgress ?? "…", 60)}）`).join("；"));
	}
	if (unread.length) did.push(`有新汇报待看 ${unread.length} 条：${unread.map((t) => clip(t.title, 40)).join("、")}`);
	if (questions.length) did.push(`等你决定 ${questions.length} 件：${questions.map((q) => clip(q.text, 60)).join("；")}`);

	return {
		conclusion: clip(`速览：${running.length} 个进行中，${questions.length} 件待决定，${unread.length} 条未读`, 80),
		did: did.slice(0, 4).map((d) => clip(d, 200)),
		urgency: questions.length ? "push" : "quiet",
		tone: questions.length ? "attention" : "success",
	};
}
