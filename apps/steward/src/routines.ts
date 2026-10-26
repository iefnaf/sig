// The proactive-behavior service (issue #20, steward.md §8, spec §8): routines (what the
// owner prescribed by conversation) and follow-ups (a Thread-scoped alarm). Deterministic
// code, no LLM anywhere in here — digest routines render straight from the ledger
// (spike-conclusions §2), instruction routines queue a ⟦routine⟧ steward input whose
// operationId (routine:<id>:<fireTime>) dedups duplicate fires (steward.md §8.2/§11).
//
// "Proactive behavior must have provenance" (spec §8.3) is enforced in the data layer:
// createdFromMsg / sourceRef are NOT NULL and verified against sh_inbound / sh_routine at
// creation time. Suggestions (§8.5) send a button card only; the tap is what creates.
import { ulid } from "@alexlikevibe/protocol";
import type { FollowupRow, Ledger, RoutineKind, RoutineRow, RoutineSpecStored } from "./ledger.ts";
import { digestCard, digestIsEmpty, digestSection, routineOfferCard, type DigestData, type QuietSection } from "./report-template.ts";
import { followupWakeText, routineWakeText } from "./wake-text.ts";

/** What a schedule payload carries into the Agents SDK callback. */
export interface RoutineFirePayload {
  routineId: string;
}
export interface FollowupFirePayload {
  followupId: string;
}

export interface RoutineServiceDeps {
  ledger: Ledger;
  /** Agents SDK schedule (steward.md §8.2): cron dedups by expression+payload by default;
   *  one-shots opt in with `idempotent: true` so a replayed create converges on one row. */
  schedule(
    when: Date | string | number,
    callback: "fireRoutine" | "fireFollowup",
    payload: Record<string, string>,
    opts?: { idempotent?: boolean },
  ): Promise<{ id: string }>;
  cancelSchedule(id: string): Promise<boolean>;
  enqueueOutbound(input: {
    kind: "text" | "card";
    to: string;
    text?: string;
    card?: unknown;
    threadId?: string | null;
    urgency?: "push" | "quiet";
    part?: QuietSection;
    id?: string;
  }): Promise<{ id: string }>;
  ownerOpenId(): string | null;
  /** Nudge the wake drain (a queued routine wake wants an immediate submit). */
  onWakeQueued(): void;
  audit(kind: string, detail: string): void;
  now?: () => number;
}

export interface RoutineSpecInput {
  instruction: string;
  kind: RoutineKind;
  cron?: string;
  onceAt?: number;
  threadId?: string;
  repoId?: string;
}

/** Exactly-one-of cron/once, a sane instruction, and a 5-field cron — refuse before storing. */
export function validateRoutineSpec(spec: RoutineSpecInput, now: number): string | null {
  if (spec.instruction.trim().length === 0) return "instruction 不能为空。";
  if (spec.instruction.length > 300) return `instruction 超长（${spec.instruction.length} > 300 字）。`;
  const hasCron = spec.cron !== undefined && spec.cron.length > 0;
  const hasOnce = spec.onceAt !== undefined;
  if (hasCron === hasOnce) return "触发条件必须二选一：cron（周期）或 atIso（一次性）。";
  if (hasCron) {
    const fields = spec.cron!.trim().split(/\s+/);
    if (fields.length !== 5) return `cron 需要 5 段（分 时 日 月 周，UTC），收到 ${fields.length} 段：「${spec.cron}」。`;
  }
  if (hasOnce && (!Number.isFinite(spec.onceAt) || spec.onceAt! <= now - 60_000)) {
    return "一次性触发时间必须是未来时间（ISO 8601）。";
  }
  return null;
}

/** Human-readable trigger description, for cards, list_schedules, and the timeline. */
export function describeSchedule(r: Pick<RoutineRow, "scheduleKind" | "cron" | "onceAt">): string {
  return r.scheduleKind === "cron"
    ? `cron ${r.cron}（UTC）`
    : `一次性 ${new Date(r.onceAt ?? 0).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** Parses an atIso parameter; returns an error text instead of throwing. */
export function parseAtIso(atIso: string): { ok: true; onceAt: number } | { ok: false; error: string } {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return { ok: false, error: `atIso 不是有效时间：「${atIso}」。` };
  return { ok: true, onceAt: t };
}

export class RoutineService {
  readonly #deps: RoutineServiceDeps;

  constructor(deps: RoutineServiceDeps) {
    this.#deps = deps;
  }

  private get ledger(): Ledger {
    return this.#deps.ledger;
  }

  private now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  // ---- creation (the tools' deterministic backend) ----------------------------------------------

  /** create_routine / an accepted offer land here. `createdFromMsg` is a received user msg. */
  async create(input: RoutineSpecInput & { routineId: string; createdFromMsg: string }): Promise<{ ok: true; routine: RoutineRow } | { ok: false; reason: string }> {
    const violation = validateRoutineSpec(input, this.now());
    if (violation) return { ok: false, reason: violation };
    const routine = this.ledger.routines.create({
      routineId: input.routineId,
      kind: input.kind,
      createdFromMsg: input.createdFromMsg,
      scheduleKind: input.cron !== undefined ? "cron" : "once",
      cron: input.cron ?? null,
      onceAt: input.onceAt ?? null,
      instruction: input.instruction.trim(),
      threadId: input.threadId ?? null,
      repoId: input.repoId ?? null,
    });
    try {
      await this.#arm(routine);
    } catch (err) {
      // The row stays (auditable) but nothing fires — cancel rather than leave a zombie.
      this.ledger.routines.setStatus(routine.routineId, "cancelled");
      return { ok: false, reason: `调度失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.ledger.timeline.add(
      routine.threadId,
      "routine",
      `创建例行任务 ${routine.routineId}（${describeSchedule(routine)}）：${routine.instruction}`,
      { routineId: routine.routineId, createdFromMsg: routine.createdFromMsg, kind: routine.kind },
    );
    return { ok: true, routine };
  }

  /** suggest_routine: send the button card ONLY — creation waits for the tap (spec §8.3). */
  async suggest(input: RoutineSpecInput & { offerId: string; sourceMsg: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const violation = validateRoutineSpec(input, this.now());
    if (violation) return { ok: false, reason: violation };
    const owner = this.#deps.ownerOpenId();
    if (!owner) return { ok: false, reason: "还没有绑定主人，无法发送建议。" };
    const spec: RoutineSpecStored = {
      instruction: input.instruction.trim(),
      kind: input.kind,
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
      ...(input.onceAt !== undefined ? { onceAt: input.onceAt } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
    };
    // The card's outbound id doubles as the offer's resolver: the tap handler finds the row
    // through providerMsgId → outbound id "offer:<offerId>" (steward.md §3.1's rule — no
    // ids stuffed into button values).
    const outboundId = `offer:${input.offerId}`;
    // Row FIRST, card second (review #47-4): a crash between the two then leaves an offer
    // row without a card (harmless, never tappable) — never a live card whose tap finds no
    // row and lies "已经处理过了".
    this.ledger.offers.create({ offerId: input.offerId, spec, sourceMsg: input.sourceMsg, outboundId });
    await this.#deps.enqueueOutbound({
      id: outboundId,
      kind: "card",
      to: owner,
      card: routineOfferCard({ schedule: describeScheduleFromSpec(input), instruction: spec.instruction }),
      threadId: input.threadId ?? null,
      urgency: "push",
    });
    return { ok: true };
  }

  /** The tap (dispatch.ts routes `offer:` cards here): the consent that creates the routine. */
  async handleOfferTap(offerId: string, action: string): Promise<void> {
    const offer = this.ledger.offers.consume(offerId, action === "routine_accept" ? "accepted" : "dismissed");
    if (!offer) {
      await this.#sendOwner("这张建议卡已经处理过了。");
      return;
    }
    if (action !== "routine_accept") {
      await this.#sendOwner("好的，没有创建。想创建的时候再和我说。", offer.spec.threadId ?? null);
      return;
    }
    const routineId = `r_${ulid()}`;
    const outcome = await this.create({ ...offer.spec, routineId, createdFromMsg: offer.sourceMsg });
    if (!outcome.ok) {
      await this.#sendOwner(`创建失败：${outcome.reason}`);
      return;
    }
    this.#deps.audit("routine_created_from_offer", `${routineId} <- ${offer.sourceMsg}`);
    await this.#sendOwner(
      `已创建例行任务（${describeSchedule(outcome.routine)}）：${outcome.routine.instruction}\n随时说「暂停/恢复/取消这个例行任务」即可管理。`,
      offer.spec.threadId ?? null,
    );
  }

  /** set_followup (steward.md §8.3): a Thread alarm; the source ref is already verified. */
  async setFollowup(input: {
    followupId: string;
    threadId: string;
    afterMinutes: number;
    reason: string;
    createdBy: "user" | "steward";
    sourceRef: string;
  }): Promise<{ ok: true; followup: FollowupRow } | { ok: false; reason: string }> {
    if (!Number.isFinite(input.afterMinutes) || input.afterMinutes <= 0) return { ok: false, reason: "afterMinutes 必须是正数（分钟）。" };
    if (input.reason.trim().length === 0) return { ok: false, reason: "reason 不能为空。" };
    const dueAt = this.now() + input.afterMinutes * 60_000;
    const followup = this.ledger.followups.create({ ...input, dueAt, reason: input.reason.trim() });
    try {
      const sched = await this.#deps.schedule(new Date(dueAt), "fireFollowup", { followupId: input.followupId }, { idempotent: true });
      this.ledger.followups.setScheduleId(input.followupId, sched.id);
    } catch (err) {
      this.ledger.followups.setStatus(input.followupId, "cancelled");
      return { ok: false, reason: `调度失败：${err instanceof Error ? err.message : String(err)}` };
    }
    this.ledger.timeline.add(
      input.threadId,
      "followup",
      `设定定时回看（${Math.round(input.afterMinutes)} 分钟后）：${followup.reason}`,
      { followupId: followup.followupId, createdBy: input.createdBy, sourceRef: input.sourceRef },
    );
    return { ok: true, followup };
  }

  // ---- management (conversation: list / pause / cancel) ------------------------------------------

  /** cancel_schedule: a routine id or a follow-up id; user runs only (enforced by the tool). */
  async cancel(scheduleId: string): Promise<{ ok: true; what: string } | { ok: false; reason: string }> {
    const routine = this.ledger.routines.get(scheduleId);
    if (routine) {
      if (!this.ledger.routines.setStatus(scheduleId, "cancelled")) return { ok: false, reason: `例行任务 ${scheduleId} 不存在。` };
      await this.#cancelScheduleOf(routine.scheduleId);
      this.ledger.timeline.add(routine.threadId, "routine", `取消例行任务 ${scheduleId}（用户要求）`, { routineId: scheduleId });
      return { ok: true, what: `例行任务 ${scheduleId} 已取消。` };
    }
    const followup = this.ledger.followups.get(scheduleId);
    if (followup) {
      if (!this.ledger.followups.setStatus(scheduleId, "cancelled")) return { ok: false, reason: `定时回看 ${scheduleId} 不存在。` };
      await this.#cancelScheduleOf(followup.scheduleId);
      this.ledger.timeline.add(followup.threadId, "followup", `取消定时回看 ${scheduleId}（用户要求）`, { followupId: scheduleId });
      return { ok: true, what: `定时回看 ${scheduleId} 已取消。` };
    }
    return { ok: false, reason: `没有找到计划 ${scheduleId}；先用 list_schedules 查看编号。` };
  }

  /** pause_schedule (routines only — a follow-up is one-shot; cancelling is its pause). */
  async pause(routineId: string, paused: boolean): Promise<{ ok: true; what: string } | { ok: false; reason: string }> {
    const routine = this.ledger.routines.get(routineId);
    if (!routine) return { ok: false, reason: `例行任务 ${routineId} 不存在；先用 list_schedules 查看编号。` };
    if (routine.status === "cancelled" || routine.status === "done") {
      return { ok: false, reason: `例行任务 ${routineId} 已${routine.status === "done" ? "结束" : "取消"}，不能暂停/恢复。` };
    }
    const target = paused ? "paused" : "active";
    if (!this.ledger.routines.setStatus(routineId, target)) return { ok: false, reason: "状态更新失败。" };
    await this.#cancelScheduleOf(routine.scheduleId);
    if (!paused) {
      try {
        await this.#arm(routine); // idempotent: a live cron dedups onto its existing schedule
      } catch (err) {
        return { ok: false, reason: `恢复调度失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    this.ledger.timeline.add(routine.threadId, "routine", `${paused ? "暂停" : "恢复"}例行任务 ${routineId}（用户要求）`, { routineId });
    return { ok: true, what: `例行任务 ${routineId} 已${paused ? "暂停" : "恢复"}。` };
  }

  // ---- the scheduled callbacks -------------------------------------------------------------------

  /**
   * The Agents SDK cron/once callback (steward.md §8.2). `fireTime` is the fire's scheduled
   * second — the operationId `routine:<id>:<fireTime>` is the dedup: duplicate job dispatches
   * (SDK retries, alarm replays) process exactly once. Digests render here with NO LLM;
   * instruction routines queue a ⟦routine⟧ wake.
   */
  async fire(routineId: string, schedule?: { id?: string; time?: number }): Promise<void> {
    const routine = this.ledger.routines.get(routineId);
    if (!routine) {
      // The row is gone (only tests delete routines) — don't let the schedule linger.
      await this.#cancelScheduleOf(schedule?.id);
      return;
    }
    if (routine.status !== "active") {
      // A paused/cancelled routine must not fire again — kill the recurring schedule.
      await this.#cancelScheduleOf(schedule?.id ?? routine.scheduleId);
      return;
    }
    const fireTime = schedule?.time ?? Math.floor(this.now() / 1000);
    const operationId = `routine:${routineId}:${fireTime}`;
    if (routine.kind === "digest") {
      await this.#fireDigest(routine, operationId);
      return;
    }
    if (!this.ledger.routines.beginFire(routineId, operationId, "fired")) return; // duplicate fire
    const thread = routine.threadId ? this.ledger.threads.get(routine.threadId) : null;
    this.ledger.wakes.queue(
      "routine",
      operationId,
      routineWakeText(routineId, routine.instruction, {
        schedule: describeSchedule(routine),
        createdFromMsg: routine.createdFromMsg,
        thread: thread ? { threadId: thread.threadId, title: thread.title } : null,
      }),
      { operationId },
    );
    this.ledger.timeline.add(
      routine.threadId,
      "routine",
      `例行任务 ${routineId} 触发（${describeSchedule(routine)}），已交给总管执行`,
      { routineId, operationId, instruction: routine.instruction },
    );
    this.#deps.onWakeQueued();
  }

  /** The deterministic digest (spike-conclusions §2): running/questions/unread → card, else silence. */
  async #fireDigest(routine: RoutineRow, operationId: string): Promise<void> {
    if (!this.ledger.routines.beginFire(routine.routineId, operationId, "fired")) return; // duplicate fire
    const data = this.collectDigest();
    if (digestIsEmpty(data)) {
      this.ledger.routines.recordOutcome(routine.routineId, "silent:无事可说，保持沉默");
      this.ledger.timeline.add(routine.threadId, "routine", `例行任务 ${routine.routineId} 触发：无事可说，保持沉默`, {
        routineId: routine.routineId,
        operationId,
      });
      return;
    }
    const owner = this.#deps.ownerOpenId();
    if (!owner) {
      // Nobody to tell — record the skip instead of claiming a card went out.
      this.ledger.routines.recordOutcome(routine.routineId, "silent:尚未绑定主人，未发送");
      this.ledger.timeline.add(routine.threadId, "routine", `例行任务 ${routine.routineId} 触发：尚未绑定主人，保持沉默`, {
        routineId: routine.routineId,
        operationId,
      });
      return;
    }
    // spec §7.6: only "waiting on you" justifies buzzing the phone; a quiet digest does not.
    const urgency = data.waiting.length > 0 ? "push" : "quiet";
    const digestFooter = `例行任务 ${routine.routineId} · ${describeSchedule(routine)} · 引用回复可继续对应 Thread`;
    await this.#deps.enqueueOutbound({
      // Stable id: a re-dispatched fire converges on the one card (§11).
      id: `digest:${operationId}`,
      kind: "card",
      to: owner,
      card: digestCard(data, digestFooter),
      threadId: routine.threadId,
      urgency,
      // The merge section (issue #11): a quiet digest can fold into a shared window's card.
      ...(urgency === "quiet" ? { part: digestSection(data, digestFooter) satisfies QuietSection } : {}),
    });
    this.ledger.routines.recordOutcome(routine.routineId, `card:${data.running.length} 跑/${data.waiting.length} 等/${data.unreadIdle.length} 未读`);
    this.ledger.timeline.add(
      routine.threadId,
      "routine",
      `例行任务 ${routine.routineId} 触发：已发送汇总卡片（${data.running.length} 在跑、${data.waiting.length} 等你、${data.unreadIdle.length} 未读）`,
      { routineId: routine.routineId, operationId },
    );
  }

  /** fireFollowup (steward.md §8.3): due follow-ups submit ⟦followup F⟧. */
  async fireFollowup(followupId: string): Promise<void> {
    const followup = this.ledger.followups.get(followupId);
    if (!followup || followup.status !== "open") return;
    if (!this.ledger.followups.beginFire(followupId, "fired")) return; // duplicate fire
    const thread = this.ledger.threads.get(followup.threadId);
    this.ledger.wakes.queue(
      "followup",
      `followup:${followupId}`,
      followupWakeText(followupId, followup.reason, {
        thread: thread ? { threadId: thread.threadId, title: thread.title } : null,
        sourceRef: followup.sourceRef,
        createdBy: followup.createdBy,
      }),
      { operationId: `followup:${followupId}` },
    );
    this.ledger.timeline.add(
      followup.threadId,
      "followup",
      `定时回看 ${followupId} 到期：${followup.reason}`,
      { followupId, sourceRef: followup.sourceRef, createdBy: followup.createdBy },
    );
    this.#deps.onWakeQueued();
  }

  /**
   * onStart reconciliation: the sh_routine row and the SDK schedule row live in different
   * stores — a crash between INSERT and schedule() must not silently kill a routine. Active
   * rows get their schedule re-armed (cron dedups by expression+payload; a once dedups by
   * callback+payload); everything else has its schedule cancelled.
   */
  async reconcile(schedules: Array<{ id: string; callback: string; type: string; time: number; payload: unknown }>): Promise<void> {
    const byRoutine = new Map<string, string[]>();
    const byFollowup = new Map<string, string[]>();
    for (const s of schedules) {
      const payload = (s.payload ?? {}) as { routineId?: string; followupId?: string };
      if (s.callback === "fireRoutine" && payload.routineId) {
        byRoutine.set(payload.routineId, [...(byRoutine.get(payload.routineId) ?? []), s.id]);
      } else if (s.callback === "fireFollowup" && payload.followupId) {
        byFollowup.set(payload.followupId, [...(byFollowup.get(payload.followupId) ?? []), s.id]);
      }
    }
    for (const routine of this.ledger.routines.list()) {
      const ids = byRoutine.get(routine.routineId) ?? [];
      if (routine.status === "active") {
        // No schedule at all = the crash window between INSERT and schedule() (a fired
        // once-routine is already `done`, so this cannot double-fire one). Re-arm; the
        // idempotent insert dedups onto any row that actually exists.
        if (ids.length === 0) {
          try {
            await this.#arm(routine);
            this.#deps.audit("routine_rearmed", routine.routineId);
          } catch (err) {
            this.#deps.audit("routine_rearm_failed", `${routine.routineId} ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        for (const id of ids) await this.#deps.cancelSchedule(id).catch(() => {});
      }
    }
    for (const followup of this.ledger.followups.list()) {
      const ids = byFollowup.get(followup.followupId) ?? [];
      if (followup.status === "open" && ids.length === 0) {
        // Late is better than stranded (review #47-3): re-arm at the ORIGINAL dueAt — a past
        // moment fires immediately — instead of leaving the row wedged open forever. This is
        // exactly the crash window reconcile exists for (short afterMinutes make it certain).
        try {
          const sched = await this.#deps.schedule(new Date(followup.dueAt), "fireFollowup", { followupId: followup.followupId }, { idempotent: true });
          this.ledger.followups.setScheduleId(followup.followupId, sched.id);
          this.#deps.audit("followup_rearmed", followup.followupId);
        } catch {
          // The wake would never fire; log and let it be visible in list_schedules.
          this.#deps.audit("followup_rearm_failed", followup.followupId);
        }
      } else if (followup.status !== "open") {
        for (const id of ids) await this.#deps.cancelSchedule(id).catch(() => {});
      }
    }
  }

  /** The digest's ledger view (spike-conclusions §2): running / questions / unread → lines. */
  collectDigest(): DigestData {
    const data: DigestData = { running: [], waiting: [], unreadIdle: [] };
    for (const thread of this.ledger.threads.list()) {
      if (thread.state === "running") {
        const worker = this.ledger.workers.latestOnThread(thread.threadId);
        const machine = worker ? this.ledger.machines.get(worker.deviceId) : null;
        data.running.push({
          threadId: thread.threadId,
          title: thread.title,
          machineName: machine?.name ?? "未知机器",
          agent: worker?.agent ?? "?",
        });
      }
      const question = this.ledger.questions.openForThread(thread.threadId);
      if (question) data.waiting.push({ threadId: thread.threadId, title: thread.title, question: question.text });
      if (thread.state === "idle" && thread.unread) {
        data.unreadIdle.push({ threadId: thread.threadId, title: thread.title, summary: thread.summary });
      }
    }
    return data;
  }

  // ---- internals -----------------------------------------------------------------------------------

  async #arm(routine: RoutineRow): Promise<void> {
    const when: Date | string = routine.scheduleKind === "cron" ? routine.cron! : new Date(routine.onceAt ?? Date.now());
    const sched = await this.#deps.schedule(when, "fireRoutine", { routineId: routine.routineId }, { idempotent: true });
    this.ledger.routines.setScheduleId(routine.routineId, sched.id);
  }

  async #cancelScheduleOf(scheduleId: string | null | undefined): Promise<void> {
    if (!scheduleId) return;
    await this.#deps.cancelSchedule(scheduleId).catch(() => {});
  }

  async #sendOwner(text: string, threadId?: string | null): Promise<void> {
    const owner = this.#deps.ownerOpenId();
    if (!owner) return;
    await this.#deps.enqueueOutbound({ kind: "text", to: owner, text, threadId: threadId ?? null, urgency: "push" });
  }
}

function describeScheduleFromSpec(spec: RoutineSpecInput): string {
  return describeSchedule({
    scheduleKind: spec.cron !== undefined ? "cron" : "once",
    cron: spec.cron ?? null,
    onceAt: spec.onceAt ?? null,
  });
}
