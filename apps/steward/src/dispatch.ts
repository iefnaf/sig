// The deterministic dispatch service (ADR-0001 decision 6, spike bug 4): machine choice,
// Thread create/attach, worker registration, and the `start_worker` command — everything the
// steward's `start_worker` tool (issue #6) and the card callbacks drive. The M1 command
// phrases are gone: natural language reaches the LLM, whose tool calls land here. Two chat
// commands stay deterministic (issue #22): `/加机器` and `/网页` mint credentials and one-time
// links — security-sensitive, and they must work without the model. Card button callbacks
// stay deterministic too (steward.md §3.1 signal 1): the Thread is resolved from the card's
// providerMsgId, never from data stuffed into the button.
import { ulid } from "@alexlikevibe/protocol";
import { isSpendQuery } from "./budget.ts";
import { decideContinuation, renderHandoffBrief, type NewSessionReason } from "./handoff.ts";
import type { Ledger, OfflineDispatchRow, ThreadRow, WorkerRow } from "./ledger.ts";
import { offlineAskCard, askUserCard } from "./report-template.ts";

const ADD_MACHINE_RE = /^\/(?:加机器|添加机器|add-machine|addmachine)\s*$/;
const WEB_RE = /^\/(?:网页|web|login)\s*$/;

export type OwnerCommand = { kind: "add_machine" } | { kind: "web_link" } | { kind: "spend" };

/** Parses `/加机器`, `/网页` (exact phrases), and the spend query (budget.ts — `/花费` plus
 *  whole-message natural forms). Everything else → null, i.e. the LLM's. */
export function parseOwnerCommand(text: string): OwnerCommand | null {
  const trimmed = text.trim();
  if (ADD_MACHINE_RE.test(trimmed)) return { kind: "add_machine" };
  if (WEB_RE.test(trimmed)) return { kind: "web_link" };
  if (isSpendQuery(trimmed)) return { kind: "spend" };
  return null;
}

export interface MachineCandidate {
  deviceId: string;
  name: string;
  online: boolean;
  /** maxWorkers minus running workers. */
  freeSlots: number;
}

export type MachineChoice =
  | { kind: "machine"; deviceId: string; queued: boolean }
  | { kind: "ask_offline"; deviceId: string }
  | { kind: "ask_which"; candidates: MachineCandidate[] }
  | { kind: "no_match" };

/**
 * ADR-0001 decision 6: among machines that have the repo, prefer the user-named machine >
 * the Thread's last machine > online > most free worker slots. A unique winner is dispatched;
 * a tie or no online machine goes back to the user. `continuation` runs the bug-4 rule: the
 * Thread's last machine is remembered and the command queues while it is offline.
 */
export function chooseMachine(input: {
  candidates: MachineCandidate[];
  machineHint: string | null;
  lastMachine: string | null;
  continuation: boolean;
}): MachineChoice {
  const { machineHint, lastMachine, continuation } = input;
  const candidates = [...new Map(input.candidates.map((c) => [c.deviceId, c])).values()];
  const selected = (c: MachineCandidate): MachineChoice => c.online
    ? { kind: "machine", deviceId: c.deviceId, queued: false }
    : { kind: "ask_offline", deviceId: c.deviceId };
  if (candidates.length === 0) return { kind: "no_match" };

  if (machineHint) {
    const byId = candidates.find((c) => c.deviceId === machineHint);
    if (byId) return selected(byId);
    const named = candidates.filter((c) => c.name === machineHint);
    if (named.length === 0) return { kind: "no_match" };
    // One repo row per machine: a name hit can list the same machine twice (multi-repo
    // rows), which is one machine — dedupe on deviceId before treating it as a tie.
    const namedDevices = [...new Set(named.map((c) => c.deviceId))];
    if (namedDevices.length > 1) return { kind: "ask_which", candidates: named };
    return selected(named[0]!);
  }

  if (continuation && lastMachine) {
    const remembered = candidates.find((c) => c.deviceId === lastMachine);
    if (remembered) return selected(remembered);
  }

  const online = candidates.filter((c) => c.online);
  if (online.length === 0) {
    if (candidates.length === 1) return { kind: "ask_offline", deviceId: candidates[0]!.deviceId };
    return { kind: "ask_which", candidates };
  }
  if (online.length === 1) return { kind: "machine", deviceId: online[0]!.deviceId, queued: false };

  // Several online machines: most free slots wins; a tie is a question, never a coin flip.
  const best = Math.max(...online.map((c) => c.freeSlots));
  const winners = online.filter((c) => c.freeSlots === best);
  if (winners.length === 1) return { kind: "machine", deviceId: winners[0]!.deviceId, queued: false };
  return { kind: "ask_which", candidates: winners };
}

/** What the steward's start_worker tool asks the service to do. */
export interface StartWorkerInput {
  prompt: string;
  /** Repo name / repoId / path as the user or ledger knows it. */
  repoRef: string;
  /** Attach to this Thread (from get_thread / the situation brief). */
  threadId?: string;
  /** Create a new Thread with this title (mutually exclusive with threadId). */
  newTitle?: string;
  goal?: string;
  machineHint?: string;
  /** §11 (issue #16): research/Q&A/review tasks run readonly in the repo's own checkout;
   * anything that may change code needs a workspace. The steward decides at dispatch; the
   * default — also when unsure — is write. */
  mode?: "write" | "readonly";
  /** Issue #8 (spec §5.3 case 2): the user asked for a fresh, unbiased look (e.g. an
   *  independent review) — always a new session, never a resume of the old context. */
  freshReview?: boolean;
  /** Issue #17: which agent runs the task (hello.agents is the menu — e.g. 'claude-code').
   *  Default 'pi'; a machine without the agent never sees the command. */
  agent?: string;
  /** The authorizing run: `user:<msgId>` / `evt:…` / `routine:…` (steward.md §7.1). */
  provenance: string;
  /** `tool:<taskId>` — the idempotency key for replays (protocol §7.1). */
  cmdId: string;
  /** Channel message id that started it all, when the provenance is a user message. */
  createdFromMsg?: string | null;
}

/** How a dispatch continued the Thread (issue #8): reused session or new one. */
export interface StartWorkerContinuation {
  action: "resume" | "new_session";
  reason?: NewSessionReason;
  parentWorker: string | null;
  base?: string;
  /** The relay branch lives on another machine: it must exist there (push + fetch) or the
   *  connector's start fails with worktree_failed — worth telling the user. */
  crossMachine: boolean;
  /** The task prompt carried a handoff brief (always true for a relayed new session). */
  brief: boolean;
}

export type StartWorkerOutcome =
  | {
      kind: "dispatched";
      workerId: string;
      threadId: string;
      machineName: string;
      repoId: string;
      queued: boolean;
      created: boolean;
      /** Issue #8 (spec §5.3): how this dispatch continues the Thread. */
      continuation?: StartWorkerContinuation;
    }
  /** The target is offline: the command is held until the wait/switch answer (spec §9). */
  | { kind: "asked_offline"; threadId: string; machineName: string }
  | { kind: "refused"; reason: string };

/** What the steward's send_to_worker tool asks the service to do (issue #9, §6.1 `send`). */
export interface SendToWorkerInput {
  workerId: string;
  text: string;
  intent: "now" | "after" | "auto";
  /** The authorizing run: `user:<msgId>` / `evt:…` (steward.md §7.1). */
  provenance: string;
  /** `tool:<taskId>` — the idempotency key for replays (protocol §7.1). */
  cmdId: string;
}

export type SendToWorkerOutcome =
  | {
      kind: "sent";
      threadId: string;
      /** How the connector will deliver it — the §6.2 state table applied to the worker's
       *  ledger state; `steer` is what makes the reply mention after_current_tools. */
      delivery: "steer" | "follow_up" | "prompt" | "queued";
      machineOffline: boolean;
    }
  | { kind: "refused"; reason: string };

/** What the steward's interrupt_worker tool asks the service to do (§6.1 `interrupt`). */
export interface InterruptWorkerInput {
  workerId: string;
  /** “停，然后……” — the instruction handed to the worker right after the abort. */
  then?: string;
  provenance: string;
  cmdId: string;
}

export type InterruptWorkerOutcome =
  | { kind: "interrupted"; threadId: string; machineOffline: boolean }
  | { kind: "refused"; reason: string };

export interface DispatcherDeps {
  ledger: Ledger;
  /** Enqueues a connector command (steward.enqueue); `notAfter: null` = wait until online. */
  enqueueCommand: (
    deviceId: string,
    kind: string,
    args: Record<string, unknown>,
    opts: { workerId?: string; notAfter?: number | null; cmdId?: string; held?: boolean },
  ) => Promise<{ cmdId: string }>;
  /** Withdraws a still-queued command; false once it has left the DO. */
  cancelQueuedCommand: (cmdId: string) => boolean;
  /** Whether a command with this id already exists (replay dedup, protocol §7.1). */
  commandExists: (cmdId: string) => boolean;
  /** Releases a held command with no expiry; refuses if it already left the DO. */
  waitForCommand: (cmdId: string) => boolean;
  /** `private`: the text carries a credential (login link, pairing code) — delivered to the owner,
   *  never shown in the workspace's conversation. */
  sendText: (text: string, threadId?: string | null, opts?: { private?: boolean }) => Promise<void>;
  sendCard: (card: unknown, threadId: string, id?: string) => Promise<void>;
  /** Issues a one-time pairing code (protocol §5.2) for `/加机器`. */
  createPairing: () => Promise<{ code: string }>;
  /** The deployment's public origin for the connect command; null until a request revealed it. */
  deployOrigin: () => string | null;
  /** Mints an absolute one-time web URL, or null when no origin is known yet. */
  webLinkUrl: (target: string) => Promise<string | null>;
  /** A tap on a routine-suggestion card (`offer:` outbound ids, issue #20). */
  onOfferTap: (offerId: string, action: string) => Promise<void>;
  /** Renders the daily-spend readout for the deterministic spend query (issue #28). */
  spendStatusText: () => Promise<string>;
}

const DEFAULT_AGENT = "pi"; // ADR-0001 decision 3: pi first; Claude Code joins via issue #17 (hello.agents is the menu)

export class Dispatcher {
  readonly #deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  private get ledger(): Ledger {
    return this.#deps.ledger;
  }

  /**
   * The steward's `start_worker` lands here (issue #6). Everything deterministic stays
   * deterministic: the machine rule, the relay base, the Thread bookkeeping. The outcome the
   * tool reports back to the model says exactly what happened — including "the user was asked
   * with buttons", so the model does not re-ask.
   */
  async startWorker(input: StartWorkerInput): Promise<StartWorkerOutcome> {
    if (input.prompt.trim().length === 0) return { kind: "refused", reason: "prompt 为空" };
    const existing = this.ledger.workers.byCommand(input.cmdId);
    if (existing) {
      const machineName = this.ledger.machines.get(existing.deviceId)?.name ?? existing.deviceId;
      const ask = this.ledger.offlineDispatches.get(input.cmdId);
      if (ask?.status === "offered") {
        if (existing.repoId !== null) {
          // The card is idempotent on its `offline:<cmdId>` outbound id: an insert that
          // finds the row sent does nothing, and the crash window (row written, card never
          // enqueued) heals instead of stranding a held command nobody was asked about
          // (PR #51 review finding 9).
          await this.#deps.sendCard(
            offlineAskCard(ask.input.repoRef, machineName, this.ledger.threads.get(existing.threadId)?.title ?? existing.threadId,
              this.alternativeNames(ask.input.repoRef, ask.deviceId)),
            existing.threadId,
            `offline:${input.cmdId}`,
          );
        }
        return { kind: "asked_offline", threadId: existing.threadId, machineName };
      }
      return { kind: "dispatched", workerId: existing.workerId, threadId: existing.threadId,
        machineName, repoId: existing.repoId!, queued: !this.ledger.machines.get(existing.deviceId)?.online, created: false };
    }
    const attach = input.threadId ? this.ledger.threads.get(input.threadId) : null;
    if (input.threadId && !attach) return { kind: "refused", reason: `Thread ${input.threadId} 不存在（可能已归档）` };
    if (!attach && !input.newTitle) {
      return { kind: "refused", reason: "需要 threadId（接续）或 newTitle（新开一件事）" };
    }

    const repoRows = this.ledger.repos.machinesHaving(input.repoRef);
    if (repoRows.length === 0) {
      return {
        kind: "refused",
        reason: `没有机器登记过仓库「${input.repoRef}」。请告诉用户在 Web 工作台打开「机器」，找到对应的在线机器并通过「添加目录」登记仓库，或换一个他提过的仓库。`,
      };
    }
    // Issue #17: the steward can target an agent (hello.agents is the menu) — but only
    // machines that actually have it are candidates; an honest refusal beats a command the
    // connector would bounce with unknown_agent.
    const agent = input.agent ?? DEFAULT_AGENT;
    const agentRows = repoRows.filter((row) => {
      const machine = this.ledger.machines.get(row.deviceId);
      return (machine?.agents.length ? machine.agents : [DEFAULT_AGENT]).includes(agent);
    });
    if (agentRows.length === 0) {
      const listing = repoRows
        .map((row) => {
          const machine = this.ledger.machines.get(row.deviceId);
          const agents = machine?.agents.length ? machine.agents : [DEFAULT_AGENT];
          return `${machine?.name ?? row.deviceId}（${agents.join("、")}）`;
        })
        .join("；");
      return {
        kind: "refused",
        reason: `有仓库「${input.repoRef}」的机器都没安装 ${agent}：${listing}。请换回已装的 agent，或让用户先安装再重连。`,
      };
    }
    const candidates: MachineCandidate[] = agentRows.map((row) => {
      const machine = this.ledger.machines.get(row.deviceId);
      return {
        deviceId: row.deviceId,
        name: machine?.name ?? row.deviceId,
        online: machine?.online ?? false,
        freeSlots: Math.max(0, (machine?.maxWorkers ?? 1) - this.ledger.machines.runningCount(row.deviceId)),
      };
    });
    const choice = chooseMachine({
      candidates,
      machineHint: input.machineHint ?? null,
      lastMachine: attach?.lastMachine ?? null,
      continuation: attach !== null,
    });

    switch (choice.kind) {
      case "no_match":
        return {
          kind: "refused",
          reason:
            `机器「${input.machineHint}」上没有仓库「${input.repoRef}」` +
            (agent !== DEFAULT_AGENT ? `或不支持 agent ${agent}` : "") +
            `。可用的机器：${candidates.map((c) => c.name).join("、")}。`,
        };
      case "ask_which": {
        const listing = choice.candidates.map((c) => `${c.name}${c.online ? "" : "（离线）"}`).join("、");
        return {
          kind: "refused",
          reason: `多台机器都有「${input.repoRef}」：${listing}。请用 ask_user 让用户指定一台（或让他在任务里带上 @机器名）。`,
        };
      }
      case "ask_offline":
      case "machine": {
        const machine = this.ledger.machines.get(choice.deviceId)!;
        const repoId = repoRows.find((r) => r.deviceId === choice.deviceId)!.repoId;
        let thread = attach;
        let created = false;
        if (!thread) {
          thread = this.ledger.threads.create({
            title: input.newTitle!,
            goal: input.goal ?? input.prompt,
            createdFromMsg: input.createdFromMsg ?? undefined,
            repoIds: [repoId],
          });
          this.ledger.timeline.add(thread.threadId, "user_instruction", input.prompt, { provenance: input.provenance });
          created = true;
        }
        const offline = choice.kind === "ask_offline";
        if (offline) this.ledger.offlineDispatches.create(input, thread.threadId, choice.deviceId);
        // `queued` here is the offline ask: continueThread parks the command HELD (issue #14,
        // protocol §7.3) instead of main's silent notAfter-null queue.
        const continuation = await this.continueThread(
          thread,
          choice.deviceId,
          repoId,
          input.prompt,
          offline,
          input.provenance,
          input.cmdId,
          input.mode ?? "write",
          input.freshReview === true,
          agent,
        );
        if (offline) {
          this.ledger.questions.insert({
            qid: `offline:${input.cmdId}`,
            threadId: thread.threadId,
            text: `${machine.name} 不在线：等它上线，还是换台机器？`,
          });
          this.ledger.recomputeThreadState(thread.threadId);
          const alternatives = candidates.filter((c) => c.deviceId !== choice.deviceId).map((c) => c.name);
          await this.#deps.sendCard(
            offlineAskCard(input.repoRef, machine.name, thread.title, alternatives),
            thread.threadId,
            `offline:${input.cmdId}`,
          );
          return { kind: "asked_offline", threadId: thread.threadId, machineName: machine.name };
        }
        return {
          kind: "dispatched",
          workerId: this.ledger.workers.latestOnThread(thread.threadId)!.workerId,
          threadId: thread.threadId,
          machineName: machine.name,
          repoId,
          queued: false,
          created,
          ...(continuation !== undefined ? { continuation } : {}),
        };
      }
    }
  }

  /**
   * The steward's `send_to_worker` lands here (issue #9): the deterministic half is the
   * §6.2 state table applied to the ledger's worker state (which delivery the connector
   * will pick), the command enqueue with the tool's idempotency key, and the timeline
   * entry. The tool tells the model what delivery to expect — including the
   * after_current_tools effect for a running worker.
   */
  async sendToWorker(input: SendToWorkerInput): Promise<SendToWorkerOutcome> {
    if (input.text.trim().length === 0) return { kind: "refused", reason: "text 为空" };
    const worker = this.ledger.workers.get(input.workerId);
    if (!worker) {
      return { kind: "refused", reason: `worker ${input.workerId} 不存在。先 get_thread 拿到最新的 workerId。` };
    }
    const machine = this.ledger.machines.get(worker.deviceId);
    const offline = !(machine?.online ?? false);
    // PR #45 review #6: the connector rejects a broken worker's sends (broken_worker) —
    // refuse here, before the enqueue, so the tool reply cannot claim a delivery (「已发送」)
    // the connector is guaranteed to reject.
    if (worker.state === "broken") {
      return {
        kind: "refused",
        reason: `worker ${input.workerId} 已损坏（需要人工决定），指令不会被送达。先和用户确认下一步。`,
      };
    }
    const delivery =
      worker.state === "running" || worker.state === "recovering"
        ? input.intent === "after"
          ? "follow_up"
          : "steer"
        : worker.state === "starting" || worker.state === "lost"
          ? "queued"
          : "prompt"; // idle — broken was refused above
    // Replay dedup (protocol §7.1): the same tool task re-running after a crash converges on
    // the existing outbox row instead of writing a second timeline entry.
    if (this.#deps.commandExists(input.cmdId)) {
      return { kind: "sent", threadId: worker.threadId, delivery, machineOffline: offline };
    }
    const { cmdId } = await this.#deps.enqueueCommand(
      worker.deviceId,
      "send",
      { workerId: worker.workerId, text: input.text, intent: input.intent },
      { workerId: worker.workerId, cmdId: input.cmdId },
    );
    this.ledger.timeline.add(
      worker.threadId,
      "intervention",
      `追加指令（intent=${input.intent}，将按 ${delivery} 送达）：${input.text}`,
      { workerId: worker.workerId, cmdId, provenance: input.provenance },
    );
    return { kind: "sent", threadId: worker.threadId, delivery, machineOffline: offline };
  }

  /**
   * The steward's `interrupt_worker` lands here (issue #9): enqueue the `interrupt` command
   * (§6.1 — clear_queue → abort → optional then) and record it on the Thread's timeline.
   * The hook in the extension is what gates autonomy (§7.2: user_explicit/user_reply_to
   * only); this method stays mechanical.
   */
  async interruptWorker(input: InterruptWorkerInput): Promise<InterruptWorkerOutcome> {
    const worker = this.ledger.workers.get(input.workerId);
    if (!worker) {
      return { kind: "refused", reason: `worker ${input.workerId} 不存在。先 get_thread 拿到最新的 workerId。` };
    }
    const machine = this.ledger.machines.get(worker.deviceId);
    const offline = !(machine?.online ?? false);
    // PR #45 review #6: nothing runs on a broken worker — refuse before the enqueue so the
    // model cannot promise「会尽快停下」for a command the connector will reject.
    if (worker.state === "broken") {
      return { kind: "refused", reason: `worker ${input.workerId} 已损坏（需要人工决定），没有运行中的任务可停。` };
    }
    if (this.#deps.commandExists(input.cmdId)) {
      return { kind: "interrupted", threadId: worker.threadId, machineOffline: offline };
    }
    const { cmdId } = await this.#deps.enqueueCommand(
      worker.deviceId,
      "interrupt",
      {
        workerId: worker.workerId,
        ...(input.then !== undefined ? { then: { text: input.then } } : {}),
      },
      { workerId: worker.workerId, cmdId: input.cmdId },
    );
    this.ledger.timeline.add(
      worker.threadId,
      "intervention",
      input.then !== undefined ? `中断指令（停后继续）：${input.then}` : "中断指令（停止运行）",
      { workerId: worker.workerId, cmdId, provenance: input.provenance },
    );
    return { kind: "interrupted", threadId: worker.threadId, machineOffline: offline };
  }

  /**
   * The two chat commands that never reach the LLM (issue #22): they mint a pairing code and
   * a one-time login link — deterministic by design, and available even without a model.
   */
  async handleOwnerCommand(command: OwnerCommand): Promise<void> {
    if (command.kind === "add_machine") {
      await this.addMachine();
      return;
    }
    if (command.kind === "spend") {
      // Counter readout, no LLM (steward.md §0.2/§12): free to ask, exact by construction,
      // and it answers even when the model is unreachable or the day is capped.
      await this.#deps.sendText(await this.#deps.spendStatusText());
      return;
    }
    const url = await this.#deps.webLinkUrl("home");
    await this.#deps.sendText(
      url
        ? `一次性登录链接（15 分钟内有效，只能打开一次）：\n${url}`
        : "暂时不知道本部署的对外地址，发过一条消息后再试。",
      null,
      { private: true },
    );
  }

  /** `/加机器` (protocol §5.2): mint a one-time code, reply with the connect command. */
  private async addMachine(): Promise<void> {
    const origin = this.#deps.deployOrigin();
    if (!origin) {
      // Unreachable in practice — this reply itself rides a webhook that revealed the origin —
      // but never hand out a code whose command cannot be built.
      await this.#deps.sendText("暂时不知道本部署的对外地址，发过一条消息后再试。");
      return;
    }
    const { code } = await this.#deps.createPairing();
    await this.#deps.sendText(
      [
        "在要接入的那台电脑的终端里运行：",
        `npx @alexlikevibe/sig connect ${origin} ${code}`,
        "（配对码 10 分钟内有效，只能使用一次；接好后它会自动上线，直接问我就能看到。）",
      ].join("\n"),
      null,
      { private: true },
    );
  }

  /** Replies into the Thread a card belongs to (ask-card edge cases, issue #7). */
  async replyToCard(cardMsgId: string, text: string, threadId?: string | null): Promise<void> {
    const resolved = threadId ?? this.ledger.outbound.threadIdForProviderMsg(cardMsgId);
    await this.#deps.sendText(text, resolved ?? null);
  }

  /** A card button callback (already deduped); the Thread comes from the card's message id. */
  async handleCardAction(input: { operatorId: string; action: string; cardMsgId: string }): Promise<void> {
    // Routine suggestion cards (steward.md §8.5): resolved via the outbound row's `offer:` id —
    // the tap is the consent that creates the routine; no Thread is required.
    const outboundRow = this.ledger.outbound.rowForProviderMsg(input.cardMsgId);
    if (outboundRow && outboundRow.id.startsWith("offer:")) {
      await this.#deps.onOfferTap(outboundRow.id.slice("offer:".length), input.action);
      return;
    }
    if (outboundRow?.id.startsWith("offline:") || outboundRow?.id.startsWith("switch:")) {
      const cmdId = outboundRow.id.slice(outboundRow.id.indexOf(":") + 1);
      await this.handleOfflineAction(cmdId, input.action);
      return;
    }
    const threadId = this.ledger.outbound.threadIdForProviderMsg(input.cardMsgId);
    const thread = threadId ? this.ledger.threads.get(threadId) : null;
    if (!thread) {
      await this.#deps.sendText("这张卡片关联的 Thread 不存在了。");
      return;
    }
    this.ledger.threads.markRead(threadId!); // a click is both read and a reply (§6.5)

    if (input.action === "wait_online" || input.action === "switch_machine" || input.action === "cancel") {
      await this.#deps.sendText("这张旧卡片已失效，请重新说明要派发的任务。", threadId);
      return;
    }

    await this.#deps.sendText(`已收到按钮「${input.action}」。`, threadId);
  }

  /** Retires the worker behind a withdrawn HELD command, routing by what the command was
   *  (PR #54 review, blocker 2, applied to the offline ask): a start_worker withdrawal
   *  closes the never-started worker (settleWithdrawnStart — the Thread frees immediately);
   *  a resume-send withdrawal reverts the resume-pending worker quietly (the session itself
   *  is intact). A never-started worker has no sessionId; a resumed one always does. */
  private retireHeld(worker: { workerId: string; sessionId: string | null }, cmdId: string, note: string): void {
    if (worker.sessionId === null) this.ledger.workers.settleWithdrawnStart(worker.workerId);
    else this.ledger.workers.markResumeCancelled(worker.workerId, cmdId);
    this.ledger.timeline.add(this.ledger.workers.get(worker.workerId)?.threadId ?? "", "note", note, { cmdId });
  }

  /** Machine names (other than `except`) that currently register `repoRef` — the switch button's label. */
  private alternativeNames(repoRef: string, except: string): string[] {
    return [
      ...new Set(this.ledger.repos.machinesHaving(repoRef).filter((r) => r.deviceId !== except).map((r) => r.deviceId)),
    ].map((id) => this.ledger.machines.get(id)?.name ?? id);
  }

  /** Card identity selects the command; Thread changes and old/racing taps cannot retarget it. */
  private async handleOfflineAction(cmdId: string, action: string): Promise<void> {
    const offer = this.ledger.offlineDispatches.get(cmdId);
    const worker = this.ledger.workers.byCommand(cmdId);
    if (!offer || !worker) return;
    const threadId = offer.threadId;
    this.ledger.threads.markRead(threadId);
    if (action === "wait_online" && offer.status === "offered") {
      if (!this.#deps.waitForCommand(cmdId)) {
        await this.#deps.sendText("这条派发已经失效，请重新派发。", threadId);
        return;
      }
      this.ledger.offlineDispatches.transition(cmdId, "offered", "waiting");
      this.ledger.questions.close(`offline:${cmdId}`, "等机器上线");
      await this.#deps.sendText(`已排队：${this.ledger.machines.get(offer.deviceId)?.name ?? offer.deviceId} 上线后自动开始。`, threadId);
      return;
    }
    if (action === "wait_online" && offer.status === "waiting") {
      await this.#deps.sendText("已在排队等它上线，不用再点。", threadId);
      return;
    }
    if (action === "cancel" && (offer.status === "offered" || offer.status === "waiting")) {
      if (!this.#deps.cancelQueuedCommand(cmdId)) {
        // The command already left the DO (wait tapped, machine returned, start delivered):
        // mirroring the switch branch — never claim a cancellation that did not happen
        // (PR #51 review finding 6).
        await this.#deps.sendText("它已经上路了，撤不回运行中的任务；等它跑完看汇报吧。", threadId);
        return;
      }
      // `expired` is exactly the user-withdrawal state (main's #46 semantics): the sweep
      // closes the never-started worker quietly via settleWithdrawnStart.
      this.ledger.workers.settleWithdrawnStart(worker.workerId);
      this.ledger.offlineDispatches.transition(cmdId, offer.status, "cancelled");
      this.ledger.questions.close(`offline:${cmdId}`, "算了");
      await this.#deps.sendText("已取消。想再派发时直接说即可。", threadId);
      return;
    }
    if (action === "switch_machine" && (offer.status === "offered" || offer.status === "waiting")) {
      const rows = this.ledger.repos.machinesHaving(offer.input.repoRef).filter((r) => r.deviceId !== offer.deviceId);
      const candidates = [...new Set(rows.map((r) => r.deviceId))].map((id) => {
        const m = this.ledger.machines.get(id)!;
        return { deviceId: id, name: m.name, online: m.online, freeSlots: Math.max(0, m.maxWorkers - this.ledger.machines.runningCount(id)) };
      });
      if (candidates.length === 0) {
        // Nothing to switch to (protocol §7.3): keep the held command untouched — the
        // owner can still wait — and say so instead of destroying the only dispatch.
        await this.#deps.sendText(
          "暂时没有别的机器登记这个仓库，没法换。原任务仍扣着：点「等它上线」继续等，或「算了」撤回。",
          threadId,
        );
        return;
      }
      if (!this.#deps.cancelQueuedCommand(cmdId)) {
        await this.#deps.sendText("任务已经送到机器，不能再换机重派；请先确认运行状态。", threadId);
        return;
      }
      this.ledger.workers.settleWithdrawnStart(worker.workerId);
      const choice = chooseMachine({ candidates, machineHint: null, lastMachine: null, continuation: false });
      const choices = choice.kind === "ask_which" ? choice.candidates : candidates;
      this.ledger.offlineDispatches.transition(cmdId, offer.status, "switching", choices.map((c) => c.deviceId));
      this.ledger.questions.close(`offline:${cmdId}`, "换机器");
      if (choice.kind === "machine") {
        await this.switchTo(offer, choice.deviceId);
        return;
      }
      this.ledger.questions.insert({ qid: `switch:${cmdId}`, threadId, text: "原派发已撤回，请选择另一台机器。" });
      this.ledger.recomputeThreadState(threadId);
      await this.#deps.sendCard(askUserCard({ question: "原派发已撤回。要换到哪台机器？离线的机器仍需选择是否等待。",
        buttons: choices.slice(0, 3).map((c, i) => ({ label: `${c.name}${c.online ? "" : "（离线）"}`, action: `machine:${i}` })),
      }), threadId, `switch:${cmdId}`);
      return;
    }
    if (action.startsWith("machine:") && offer.status === "switching") {
      const index = Number(action.slice("machine:".length));
      const deviceId = Number.isInteger(index) ? offer.choices[index] : undefined;
      if (deviceId) { await this.switchTo(offer, deviceId); return; }
    }
    await this.#deps.sendText("这个选择已经处理过了。", threadId);
  }

  private async switchTo(offer: OfflineDispatchRow, deviceId: string): Promise<void> {
    // markSwitched/reopen never rewrite `choices`: the picker's buttons index into them.
    if (!this.ledger.offlineDispatches.markSwitched(offer.cmdId)) return;
    const result = await this.startWorker({ ...offer.input, threadId: offer.threadId, newTitle: undefined,
      machineHint: deviceId, cmdId: `switch:${offer.cmdId}` });
    if (result.kind === "dispatched") {
      this.ledger.questions.close(`switch:${offer.cmdId}`, "已换机器");
      await this.#deps.sendText(`已放到 ${result.machineName} 上。`, offer.threadId);
    } else if (result.kind === "refused") {
      // The repo snapshot changed since the card was sent. Re-open the choice so the tap
      // can be answered again once the world changed back — otherwise the offer sits
      // `switched` with its command already expired and only a from-scratch dispatch
      // remains (PR #51 review finding 8).
      this.ledger.offlineDispatches.markSwitched(offer.cmdId, "switching"); // choices stay for the re-tap
      await this.#deps.sendText(result.reason, offer.threadId);
    }
  }

  /**
   * Registers the worker, then enqueues `start_worker`. Registration must precede the command:
   * the reducer skips events for unknown workers (advancing the watermark), so the row has to
   * exist before the connector can possibly emit `started`.
   *
   * Issue #8 (spec §5.3) — a continuation first decides resume vs new session:
   * - resume: same agent + same machine (+ a usable session, same repo, same mode, context
   *   not high) → the task lands in the EXISTING session as a send (the connector's §6.2
   *   idle-cold relaunch is the resume mechanism); no brief — the session has its own context.
   * - new session: otherwise, on the previous worker's branch, with the deterministic
   *   handoff brief (pointers, not content) prefixed to the task; `parentWorker` records the
   *   relay relationship.
   */
  private async continueThread(
    thread: ThreadRow,
    deviceId: string,
    repoId: string,
    prompt: string,
    queued: boolean,
    provenance: string,
    cmdId: string,
    mode: "write" | "readonly",
    freshReview: boolean,
    agent: string = DEFAULT_AGENT,
  ): Promise<StartWorkerContinuation | undefined> {
    // Review (other findings): a replayed call carrying a cmdId that already exists must not
    // re-register a second worker row (the outbox dedupes the command, but the ghost `starting`
    // worker would sit on the Thread forever). Re-entering an existing command is a no-op.
    if (this.#deps.commandExists(cmdId)) return undefined;
    const decision = decideContinuation({
      previous: this.ledger.workers.latestOnThread(thread.threadId),
      next: { agent, deviceId, repoId, mode },
      freshReview,
    });
    if (decision.action === "resume") {
      return this.resumeSession(thread, decision.worker.workerId, prompt, queued, provenance, cmdId);
    }
    return this.startNewSession(thread, deviceId, repoId, prompt, queued, provenance, cmdId, mode, decision, agent);
  }

  /** The resume half: deliver the task into the existing session. `intent: "after"` when the
   *  previous run is still going — the task queues as a follow-up instead of steering it.
   *  For every other state the intent is `auto` and the CONNECTOR's state table decides: an
   *  idle worker prompts (hot or cold relaunch), a `lost` one queues behind its §9.2 resume,
   *  and a worker still `starting` (its first start in flight) has the task delivered as a
   *  steer of that first run once it comes up — the same session either way, but the task
   *  reads as a mid-run redirect rather than a queued follow-up (documented per PR #54
   *  review finding 8). */
  private async resumeSession(
    thread: ThreadRow,
    workerId: string,
    prompt: string,
    queued: boolean,
    provenance: string,
    cmdId: string,
  ): Promise<StartWorkerContinuation> {
    const worker = this.ledger.workers.get(workerId)!;
    const machineName = this.ledger.machines.get(worker.deviceId)?.name ?? worker.deviceId;
    const intent = worker.state === "running" || worker.state === "recovering" ? "after" : "auto";
    this.ledger.questions.closeOpen(thread.threadId, "用户重新派发");
    const { cmdId: finalCmdId } = await this.#deps.enqueueCommand(
      worker.deviceId,
      "send",
      { workerId, text: prompt, intent },
      // Held while the offline ask is open (issue #14, protocol §7.3) — the wait tap is
      // what clears the deadline, exactly like a held start.
      { workerId, held: queued, cmdId },
    );
    // Resume-pending bookkeeping: the Thread reads running-shaped immediately; a failed send
    // reverts through markResumeFailed (the worker row still points at this cmdId).
    this.ledger.workers.markResumePending(workerId, finalCmdId);
    this.ledger.threads.setLastMachine(thread.threadId, worker.deviceId);
    this.ledger.recomputeThreadState(thread.threadId);
    this.ledger.timeline.add(
      thread.threadId,
      "dispatch",
      `接续原会话 ${workerId}（${machineName}）${queued ? "（离线排队）" : ""}：${prompt}`,
      { workerId, cmdId: finalCmdId, provenance },
    );
    return { action: "resume", parentWorker: null, crossMachine: false, brief: false };
  }

  /** The new-session half: new worker row (parentWorker = the leg it continues from), relay
   *  base = the Thread's latest worker branch, handoff brief prefixed to the task. */
  private async startNewSession(
    thread: ThreadRow,
    deviceId: string,
    repoId: string,
    prompt: string,
    queued: boolean,
    provenance: string,
    cmdId: string,
    mode: "write" | "readonly",
    decision: { from: WorkerRow | null; reason?: NewSessionReason },
    agent: string = DEFAULT_AGENT,
  ): Promise<StartWorkerContinuation> {
    const workerId = `w_${ulid()}`;
    // Relay (spec §5.3): base = the Thread's latest worker branch — skipping legs that never
    // got one (readonly runs, never-started starts). relaySource nulls a same-machine repo
    // switch, and the base lookup carries the same repo filter (PR #54 review finding 3):
    // a repo-A branch name sent to repo-B's clone would only fail the start; a repo switch
    // is a fresh start, exactly what the comment always promised.
    const previous = this.ledger.workers.relaySource(thread.threadId, { deviceId, repoId });
    const baseWorker = previous?.branch ? previous : this.ledger.workers.latestBranchOnThread(thread.threadId, { deviceId, repoId });
    // A brief only when the previous leg produced anything (a branch or at least one event):
    // retrying after a cancelled/never-started leg must not prefix an empty 【交接简报】.
    const brief =
      previous && (previous.branch !== null || previous.lastEventAt !== null)
        ? this.ledger.handoff.build(thread.threadId, previous.workerId)
        : null;
    const fullPrompt = brief ? `${renderHandoffBrief(brief)}${prompt}` : prompt;
    this.ledger.questions.closeOpen(thread.threadId, "用户重新派发");
    this.ledger.workers.register({
      workerId,
      threadId: thread.threadId,
      deviceId,
      repoId,
      agent,
      mode,
      parentWorker: previous?.workerId,
    });
    // A machine switch lands the same repo under a different repoId (one row per machine):
    // link it so the Thread's repo set — and relaySource's repo filter — stay complete.
    // A parked offline dispatch registers like any other start (`starting`): sweepWorkers'
    // starting-branch then owns its closure — command terminal ⇒ withdrawn quietly
    // (`expired`, the user's own cancel/switch) or markStartFailed with a push
    // (`failed/not_after`/`idle`, PR #51 review findings 2/3 and 10).
    this.ledger.threads.addRepo(thread.threadId, repoId);
    this.ledger.threads.setLastMachine(thread.threadId, deviceId);
    this.ledger.recomputeThreadState(thread.threadId);
    const machineName = this.ledger.machines.get(deviceId)?.name ?? deviceId;
    const { cmdId: finalCmdId } = await this.#deps.enqueueCommand(
      deviceId,
      "start_worker",
      {
        workerId,
        threadId: thread.threadId,
        repoId,
        mode,
        prompt: fullPrompt,
        ...(agent !== DEFAULT_AGENT ? { agent } : {}),
        ...(baseWorker ? { base: baseWorker.branch! } : {}),
      },
      // A held offline command cannot run on reconnect before the owner answers. Only the
      // wait callback removes the deadline (protocol §7.3).
      { workerId, held: queued, cmdId },
    );
    this.ledger.workers.setCmdId(workerId, finalCmdId);
    const reasonText =
      decision.from === null
        ? ""
        : `（接续 ${decision.from.workerId}${decision.reason ? `，原因 ${decision.reason}` : ""}${brief ? "，已附交接简报" : ""}${baseWorker ? `，新会话从分支 ${baseWorker.branch} 起跑` : "，首棒无前序分支"}）`;
    this.ledger.timeline.add(
      thread.threadId,
      "dispatch",
      `派发给 ${machineName}${queued ? "（离线：命令已扣住，等用户选「等它上线／换台机器／算了」" : ""}${reasonText}：${prompt}`,
      { workerId, cmdId: finalCmdId, repoId, provenance, ...(baseWorker ? { base: baseWorker.branch } : {}) },
    );
    return {
      action: "new_session",
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      parentWorker: previous?.workerId ?? null,
      ...(baseWorker ? { base: baseWorker.branch! } : {}),
      crossMachine: baseWorker !== null && baseWorker.deviceId !== deviceId,
      brief: brief !== null,
    };
  }
}

/** Thread titles stay scannable in cards and the brief: first line of the prompt, clipped. */
export function titleOf(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]!;
  return firstLine.length <= 24 ? firstLine : `${firstLine.slice(0, 23)}…`;
}
