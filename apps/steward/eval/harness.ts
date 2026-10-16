// The in-process eval harness (issue #7, steward.md §3.4): a fresh node:sqlite world seeded
// from the dataset, the real steward extension (find_threads + the routing gate + ask_user)
// against a real model, and the scoring ported from the spike. Everything the production DO
// contributes deterministically (dispatch service, outbound queue, Feishu) is stubbed —
// routing is what this measures.
//
// Runs under plain Node (node:sqlite + the pi-durable Harness), NOT workerd: the DO test
// suite covers the wired-together paths; this is the model-facing regression gate.
import { DatabaseSync } from "node:sqlite";
import { createLedger, type Ledger, type LedgerSql } from "../src/ledger.ts";
import { MIGRATIONS, runMigrations, type SqlExecutor } from "../src/schema.ts";
import type { WorkerEvent } from "@shepherd/protocol";
import { CASES, THREADS, type Case } from "./dataset.ts";
import { buildSituationBrief } from "../src/llm/brief.ts";
import type { StewardExtensionContext } from "../src/llm/extension.ts";
import type { StartWorkerInput, StartWorkerOutcome } from "../src/dispatch.ts";

/** The tagged-template sql over node:sqlite, shaped exactly like the DO's. */
export function nodeSql(path: ":memory:" | string): LedgerSql {
  const db = new DatabaseSync(path);
  const executor: SqlExecutor = (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? "?" : ""), "");
    const stmt = db.prepare(text);
    // `columns()` is static metadata: row-returning statements go through .all() (which
    // executes), everything else through .run() — never both, or INSERTs would fire twice.
    if (stmt.columns().length > 0) return stmt.all(...(values as (string | number | boolean | null)[])) as Record<string, unknown>[];
    stmt.run(...(values as (string | number | boolean | null)[]));
    return [];
  };
  return executor as LedgerSql;
}

export interface SeededLedger {
  ledger: Ledger;
  sql: LedgerSql;
}

/**
 * Seeds one dataset world (the spike's seedWorld, on this tree's ledger): threads with their
 * dataset ids, one worker each, event scripts reaching the target state, then the summary /
 * recency / unread adjustments. Seeding writes with raw SQL where the ledger interface has
 * no seeding surface — the same tradeoff the spike made; production code never does this.
 */
export function seedWorld(seeded: SeededLedger, now: number): void {
  const { ledger, sql } = seeded;
  ledger.machines.setOnline("dev_eval", true, "MacBook Pro");
  // One repo the machine reported: the brief shows it, so the model has a repoRef for
  // dispatches without asking (the spike's world had none and its dispatch took no repo).
  sql`INSERT OR REPLACE INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
      VALUES ('repo-eval', 'dev_eval', 'shepherd-demo', '/srv/shepherd-demo', 'main', 'git@github.com:example/shepherd-demo.git', ${now})`;
  for (const t of THREADS) {
    ledger.threads.create({ threadId: t.id, title: t.title, goal: t.goal, createdFromMsg: "seed" });
    const workerId = `w_${t.id.slice(2)}`;
    ledger.workers.register({ workerId, threadId: t.id, deviceId: "dev_eval", agent: "pi", mode: "write" });
    const at = now - Math.round(t.ageH * 3_600_000);
    const events: WorkerEvent[] = [
      { workerId, seq: 1, ts: at - 600_000, type: "started", branch: "shepherd/seed" } as WorkerEvent,
    ];
    if (t.state === "idle_clean" || t.state === "idle_unread") {
      events.push({
        workerId, seq: 2, ts: at - 300_000, type: "report", status: "done",
        summary: t.summary ?? t.goal, changes: [], decisions: [], leftovers: [], tests: { ran: true, passed: true },
      } as WorkerEvent);
      events.push({ workerId, seq: 3, ts: at, type: "settled", outcome: "reported" } as WorkerEvent);
    }
    if (t.state === "waiting") {
      events.push({
        workerId, seq: 2, ts: at, type: "report", status: "needs_decision",
        summary: t.summary ?? t.goal, changes: [], decisions: [], leftovers: [], tests: null,
        question: `${t.summary ?? t.goal}——需要你拍板`,
      } as WorkerEvent);
      // The needs_decision report is a closing report on this protocol: the worker settles,
      // the open question is what keeps the Thread in waiting_you (steward.md §5.2).
      events.push({ workerId, seq: 3, ts: at + 1, type: "settled", outcome: "reported" } as WorkerEvent);
    }
    // Feed the reducer the way the transport does: inbox + watermark, then drain.
    sql`INSERT OR IGNORE INTO worker_ack (workerId, upTo) VALUES (${workerId}, 0)`;
    for (const event of events) {
      sql`INSERT OR IGNORE INTO event_inbox (workerId, seq, payload, receivedAt) VALUES (${workerId}, ${event.seq}, ${JSON.stringify(event)}, ${event.ts})`;
    }
    ledger.applyPendingEvents();
    if (t.summary) sql`UPDATE sh_thread SET summary = ${t.summary} WHERE threadId = ${t.id}`;
    sql`UPDATE sh_thread SET lastActivityAt = ${at} WHERE threadId = ${t.id}`;
    if (t.state === "idle_clean") sql`UPDATE sh_thread SET unread = 0 WHERE threadId = ${t.id}`;
  }
}

export function openSeededLedger(now: number): SeededLedger {
  const sql = nodeSql(":memory:");
  runMigrations(sql as SqlExecutor, MIGRATIONS);
  const ledger = createLedger({ sql, tx: (fn) => fn() }); // node:sqlite autocommits; seeding needs no cross-statement atomicity
  seedWorld({ ledger, sql }, now);
  return { ledger, sql };
}

// ---- the outcome plumbing ------------------------------------------------------------------------

export type Outcome =
  | { kind: "attach"; threadId: string; isNew: boolean }
  | { kind: "new" }
  | { kind: "ask" }
  | { kind: "chat" }
  | { kind: "error"; reason: string };

/** What the extension's stubs observed while the model ran one case. */
export interface Observation {
  asks: Array<{ question: string; candidates: Array<{ threadId: string; label: string }> }>;
  dispatches: Array<{ threadId: string; isNew: boolean }>;
}

/** The steward extension context over a seeded world (dispatch/ask recorded, never sent). */
export function buildEvalContext(ledger: Ledger, caseId: number, observation: Observation): StewardExtensionContext {
  const seedIds = new Set(THREADS.map((t) => t.id));
  return {
    ledger,
    buildBrief: () => buildSituationBrief(ledger),
    currentRun: async () => ({
      operationId: `user:eval_${caseId}`,
      kind: "user",
      provenance: `user:eval_${caseId}`,
      routedThreadId: null,
    }),
    checkProvenanceRef: async () => true, // user runs carry their own authorization
    startWorker: async (input: StartWorkerInput): Promise<StartWorkerOutcome> => {
      if (input.threadId !== undefined) {
        if (!ledger.threads.get(input.threadId)) return { kind: "refused", reason: `Thread ${input.threadId} 不存在` };
        observation.dispatches.push({ threadId: input.threadId, isNew: false });
        return {
          kind: "dispatched", workerId: `w_eval_${observation.dispatches.length}`, threadId: input.threadId,
          machineName: "MacBook Pro", repoId: "repo-eval", queued: false, created: false,
        };
      }
      const created = ledger.threads.create({
        title: input.newTitle ?? input.prompt.slice(0, 24),
        goal: input.goal ?? input.prompt,
        createdFromMsg: `eval_${caseId}`,
      });
      observation.dispatches.push({ threadId: created.threadId, isNew: !seedIds.has(created.threadId) });
      return {
        kind: "dispatched", workerId: `w_eval_${observation.dispatches.length}`, threadId: created.threadId,
        machineName: "MacBook Pro", repoId: "repo-eval", queued: false, created: true,
      };
    },
    notifyUser: async () => {},
    askUser: async (input) => {
      observation.asks.push({ question: input.question, candidates: input.candidates });
    },
    audit: () => {},
  };
}

export function outcomeOf(observation: Observation): Outcome {
  if (observation.asks.length > 0) return { kind: "ask" };
  if (observation.dispatches.length > 0) {
    const first = observation.dispatches[0]!;
    return first.isNew ? { kind: "new" } : { kind: "attach", threadId: first.threadId, isNew: false };
  }
  return { kind: "chat" };
}

// ---- scoring (steward.md §3.4 metrics) ------------------------------------------------------------

/** A prose question that lists candidates counts as asking — the product wants the
 *  ask_user tool (buttons), but text-asking is not a routing failure. Flagged so it stays visible. */
export const isTextAsk = (reply: string): boolean =>
  /(哪件|哪个|哪一|是哪|哪种|还是|定一个|定一下|选一个|回一句|告诉我)/.test(reply);

export type Verdict = "pass" | "wrong_route" | "missed_ask" | "unnecessary_ask" | "pass_text_ask" | "error";

export function score(expect: Case["expect"], outcome: Outcome, reply: string): Verdict {
  if (outcome.kind === "error") return "error";
  if (expect.kind === "ask") {
    if (outcome.kind === "ask") return "pass";
    if (outcome.kind === "chat" && isTextAsk(reply)) return "pass_text_ask";
    return "missed_ask"; // attached/created/conversed instead of asking
  }
  if (outcome.kind === "ask") return "unnecessary_ask";
  if (expect.kind === "chat") return outcome.kind === "chat" ? "pass" : "wrong_route"; // dispatched while chatting
  if (expect.kind === "new") return outcome.kind === "new" ? "pass" : "wrong_route"; // attached to something
  // expect attach
  if (outcome.kind === "attach" && outcome.threadId === expect.threadId) return "pass";
  return "wrong_route";
}

export { CASES, THREADS };
export type { Case };
