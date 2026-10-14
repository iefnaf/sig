// Scheduler (steward.md §5.1 step 4→5): turn pending intents into outbound messages.
// In the DO this runs from an alarm; here it is a plain function with injected time.
// M1: wake intents are recorded and completed without action (no steward LLM yet).
import { Memory } from "./memory.ts";
import { Outbound } from "./outbound.ts";
import { renderNotify } from "./templates.ts";
import type { Intent } from "./types.ts";

export function processIntents(memory: Memory, outbound: Outbound, channel: string, now = Date.now()): { notified: number; wakes: number } {
	let notified = 0;
	let wakes = 0;
	for (const intent of memory.pendingIntents()) {
		if (intent.type === "notify") {
			const i = intent as Intent & { template: string };
			const payload = renderNotify(memory, i.template ?? "", intent.workerId ?? "", intent.payload);
			outbound.enqueue(`out_${intent.id}`, channel, i.template ?? "notify", payload, intent.threadId ?? undefined, now);
			notified++;
			memory.completeIntent(intent.id);
		} else if (intent.type === "wake") {
			// No steward LLM in M1: record that the wake fired and move on.
			wakes++;
			memory.completeIntent(intent.id);
		} else if (intent.type === "decision_window") {
			// Handled by runDecisionWindows below.
		}
	}
	const fallbacks = runDecisionWindows(memory, outbound, channel, now);
	return { notified: notified + fallbacks, wakes };
}

/** The 90-second window (steward.md §5.3): if a decision question is still open when due,
 *  the deterministic fallback pushes it to the user — the LLM being down cannot lose it. */
export function runDecisionWindows(memory: Memory, outbound: Outbound, channel: string, now = Date.now()): number {
	let fired = 0;
	for (const intent of memory.pendingIntents()) {
		if (intent.type !== "decision_window" || intent.dueAt == null || intent.dueAt > now) continue;
		const q = intent.questionId ? memory.question(intent.questionId) : undefined;
		if (q && q.status !== "open") {
			memory.completeIntent(intent.id); // steward (or user) handled it inside the window
			continue;
		}
		const payload = renderNotify(memory, "decision_fallback", intent.workerId ?? "", { question: q?.text });
		outbound.enqueue(`out_${intent.id}`, channel, "decision_fallback", payload, intent.threadId ?? undefined, now);
		fired++;
		memory.completeIntent(intent.id);
	}
	return fired;
}
