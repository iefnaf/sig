// Outbound queue (steward.md §6): every user-facing message goes through here.
// Delivery is adapter-based; retry is exponential; quiet notifications merge within a window.
import type { Db } from "./db.ts";
import type { NotifyPayload } from "./templates.ts";

export interface ChannelAdapter {
	send(out: { id: string; kind: string; threadId?: string; payload: NotifyPayload }): Promise<{ providerMsgId: string }>;
}

export class NoopAdapter implements ChannelAdapter {
	sent: Array<{ id: string; payload: NotifyPayload }> = [];
	async send(out: { id: string; kind: string; payload: NotifyPayload }) {
		this.sent.push({ id: out.id, payload: out.payload });
		return { providerMsgId: `noop_${out.id}` };
	}
}

const RETRY_DELAYS = [5_000, 30_000, 120_000];

export class Outbound {
	db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	enqueue(id: string, channel: string, kind: string, payload: NotifyPayload, threadId?: string, now = Date.now()) {
		this.db.run(
			`INSERT OR IGNORE INTO sh_outbound (id, channel, kind, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
			id, channel, kind, threadId ?? null, JSON.stringify(payload), payload.urgency, now, now,
		);
	}

	/** Merge still-queued quiet notifications created within the window into one message. */
	mergeQuiet(windowMs: number, now = Date.now()): number {
		const rows = this.db.all<{ id: string; payload: string; createdAt: number }>(
			`SELECT id, payload, createdAt FROM sh_outbound WHERE status = 'queued' AND urgency = 'quiet' AND nextAttemptAt <= ? ORDER BY createdAt`,
			now,
		);
		if (rows.length < 2) return 0;
		const groups = new Map<string, typeof rows>();
		for (const r of rows) {
			const g = (groups.get("") ?? []).concat(r); // single group per channel in M1
			groups.set("", g);
		}
		let merged = 0;
		for (const group of groups.values()) {
			for (let i = 1; i < group.length; i++) {
				if (group[i].createdAt - group[i - 1].createdAt > windowMs) continue;
				const prev = JSON.parse(group[i - 1].payload) as NotifyPayload;
				const cur = JSON.parse(group[i].payload) as NotifyPayload;
				prev.conclusion = `${prev.conclusion}；${cur.conclusion}`;
				prev.did = [...prev.did, ...cur.did].slice(0, 8);
				if (cur.needsYou) prev.needsYou = prev.needsYou ? `${prev.needsYou} ${cur.needsYou}` : cur.needsYou;
				this.db.run(`UPDATE sh_outbound SET payload = ? WHERE id = ?`, JSON.stringify(prev), group[i - 1].id);
				this.db.run(`DELETE FROM sh_outbound WHERE id = ?`, group[i].id);
				merged++;
			}
		}
		return merged;
	}

	/** Deliver due messages. Returns the number of messages actually delivered. */
	async flush(adapter: ChannelAdapter, channel: string, now = Date.now()): Promise<number> {
		const due = this.db.all<{ id: string; kind: string; threadId: string | null; payload: string; attempts: number }>(
			`SELECT id, kind, threadId, payload, attempts FROM sh_outbound
			 WHERE status = 'queued' AND channel = ? AND nextAttemptAt <= ? ORDER BY createdAt LIMIT 20`,
			channel, now,
		);
		let delivered = 0;
		for (const row of due) {
			// Claim the row before sending: concurrent flush calls (interleaved async handlers
			// in the Durable Object) must not both deliver the same message.
			const claim = crypto.randomUUID();
			this.db.run(`UPDATE sh_outbound SET status = 'sending', claim = ? WHERE id = ? AND status = 'queued'`, claim, row.id);
			const mine = this.db.get(`SELECT 1 AS x FROM sh_outbound WHERE id = ? AND claim = ?`, row.id, claim);
			if (!mine) continue;
			try {
				const { providerMsgId } = await adapter.send({ id: row.id, kind: row.kind, threadId: row.threadId ?? undefined, payload: JSON.parse(row.payload) as NotifyPayload });
				this.db.run(`UPDATE sh_outbound SET status = 'sent', providerMsgId = ?, claim = NULL WHERE id = ?`, providerMsgId, row.id);
				delivered++;
			} catch (err) {
				const attemptsNow = row.attempts + 1;
				const giveUp = attemptsNow > RETRY_DELAYS.length;
				const delay = giveUp ? null : RETRY_DELAYS[attemptsNow - 1];
				this.db.run(
					`UPDATE sh_outbound SET status = ?, attempts = ?, nextAttemptAt = ?, claim = NULL WHERE id = ?`,
					giveUp ? "failed" : "queued", attemptsNow, delay == null ? null : now + delay, row.id,
				);
				if (giveUp) console.error(`outbound ${row.id} gave up:`, err);
			}
		}
		return delivered;
	}

	stats() {
		return this.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM sh_outbound GROUP BY status`);
	}
}
