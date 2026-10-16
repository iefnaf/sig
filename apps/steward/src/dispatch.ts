// The deterministic dispatch service (ADR-0001 decision 6, spike bug 4): machine choice,
// Thread create/attach, worker registration, and the `start_worker` command — everything the
// steward's `start_worker` tool (issue #6) and the card callbacks drive. The M1 command
// phrases are gone: natural language reaches the LLM, whose tool calls land here. Two chat
// commands stay deterministic (issue #22): `/加机器` and `/网页` mint credentials and one-time
// links — security-sensitive, and they must work without the model. Card button callbacks
// stay deterministic too (steward.md §3.1 signal 1): the Thread is resolved from the card's
// providerMsgId, never from data stuffed into the button.
import { ulid } from "@shepherd/protocol";
import type { Ledger, ThreadRow } from "./ledger.ts";
import { offlineAskCard } from "./report-template.ts";

const ADD_MACHINE_RE = /^\/(?:加机器|添加机器|add-machine|addmachine)\s*$/;
const WEB_RE = /^\/(?:网页|web|login)\s*$/;

export type OwnerCommand = { kind: "add_machine" } | { kind: "web_link" };

/** Parses `/加机器` and `/网页` (exact phrases). Everything else → null, i.e. the LLM's. */
export function parseOwnerCommand(text: string): OwnerCommand | null {
  const trimmed = text.trim();
  if (ADD_MACHINE_RE.test(trimmed)) return { kind: "add_machine" };
  if (WEB_RE.test(trimmed)) return { kind: "web_link" };
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
  const { candidates, machineHint, lastMachine, continuation } = input;
  if (candidates.length === 0) return { kind: "no_match" };

  if (machineHint) {
    const named = candidates.find((c) => c.name === machineHint || c.deviceId === machineHint);
    if (!named) return { kind: "no_match" };
    return { kind: "machine", deviceId: named.deviceId, queued: !named.online };
  }

  if (continuation && lastMachine) {
    const remembered = candidates.find((c) => c.deviceId === lastMachine);
    if (remembered) return { kind: "machine", deviceId: remembered.deviceId, queued: !remembered.online };
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
  /** The authorizing run: `user:<msgId>` / `evt:…` / `routine:…` (steward.md §7.1). */
  provenance: string;
  /** `tool:<taskId>` — the idempotency key for replays (protocol §7.1). */
  cmdId: string;
  /** Channel message id that started it all, when the provenance is a user message. */
  createdFromMsg?: string | null;
}

export type StartWorkerOutcome =
  | { kind: "dispatched"; workerId: string; threadId: string; machineName: string; repoId: string; queued: boolean; created: boolean }
  /** The only machine with the repo is offline: the wait/cancel card went out (spec §9). */
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
    opts: { workerId?: string; notAfter?: number | null; cmdId?: string },
  ) => Promise<{ cmdId: string }>;
  /** Withdraws a still-queued command; false once it has left the DO. */
  cancelQueuedCommand: (cmdId: string) => boolean;
  /** Whether a command with this id already exists (replay dedup, protocol §7.1). */
  commandExists: (cmdId: string) => boolean;
  sendText: (text: string, threadId?: string | null) => Promise<void>;
  sendCard: (card: unknown, threadId: string) => Promise<void>;
  /** Issues a one-time pairing code (protocol §5.2) for `/加机器`. */
  createPairing: () => Promise<{ code: string }>;
  /** The deployment's public origin for the connect command; null until a request revealed it. */
  deployOrigin: () => string | null;
  /** Mints an absolute one-time web URL, or null when no origin is known yet. */
  webLinkUrl: (target: string) => Promise<string | null>;
}

const AGENT = "pi"; // the only agent the connector drives in the MVP (ADR-0001 decision 3)

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
    const attach = input.threadId ? this.ledger.threads.get(input.threadId) : null;
    if (input.threadId && !attach) return { kind: "refused", reason: `Thread ${input.threadId} 不存在（可能已归档）` };
    if (!attach && !input.newTitle) {
      return { kind: "refused", reason: "需要 threadId（接续）或 newTitle（新开一件事）" };
    }

    const repoRows = this.ledger.repos.machinesHaving(input.repoRef);
    if (repoRows.length === 0) {
      return {
        kind: "refused",
        reason: `没有机器登记过仓库「${input.repoRef}」。请告诉用户先在那台机器上 shepherd add-repo 并重连，或换一个他提过的仓库。`,
      };
    }
    const candidates: MachineCandidate[] = repoRows.map((row) => {
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
          reason: `机器「${input.machineHint}」上没有仓库「${input.repoRef}」。可用的机器：${candidates.map((c) => c.name).join("、")}。`,
        };
      case "ask_which": {
        const listing = choice.candidates.map((c) => `${c.name}${c.online ? "" : "（离线）"}`).join("、");
        return {
          kind: "refused",
          reason: `多台机器都有「${input.repoRef}」：${listing}。请用 ask_user 让用户指定一台（或让他在任务里带上 @机器名）。`,
        };
      }
      case "ask_offline": {
        // spec §9: offline at dispatch time is the user's call — ask with buttons, never
        // decide silently. The Thread exists from here on; affinity is set for the callback.
        const machine = this.ledger.machines.get(choice.deviceId)!;
        const thread =
          attach ??
          this.ledger.threads.create({
            title: input.newTitle!,
            goal: input.goal ?? input.prompt,
            createdFromMsg: input.createdFromMsg ?? undefined,
            repoIds: [repoRows.find((r) => r.deviceId === choice.deviceId)!.repoId],
          });
        if (!attach) {
          this.ledger.timeline.add(thread.threadId, "user_instruction", input.prompt, { provenance: input.provenance });
        }
        this.ledger.threads.setLastMachine(thread.threadId, choice.deviceId);
        this.ledger.recomputeThreadState(thread.threadId);
        await this.#deps.sendCard(offlineAskCard(input.repoRef, machine.name, thread.title), thread.threadId);
        return { kind: "asked_offline", threadId: thread.threadId, machineName: machine.name };
      }
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
        await this.dispatchTo(thread, choice.deviceId, repoId, input.prompt, choice.queued, input.provenance, input.cmdId);
        return {
          kind: "dispatched",
          workerId: this.ledger.workers.latestOnThread(thread.threadId)!.workerId,
          threadId: thread.threadId,
          machineName: machine.name,
          repoId,
          queued: choice.queued,
          created,
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
    const delivery =
      worker.state === "running" || worker.state === "recovering"
        ? input.intent === "after"
          ? "follow_up"
          : "steer"
        : worker.state === "starting" || worker.state === "lost"
          ? "queued"
          : "prompt"; // idle — and a broken worker's sends fail loudly at the connector
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
    const url = await this.#deps.webLinkUrl("home");
    await this.#deps.sendText(
      url
        ? `一次性登录链接（15 分钟内有效，只能打开一次）：\n${url}`
        : "暂时不知道本部署的对外地址，发过一条消息后再试。",
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
        `npx @iefnaf/shepherd connect ${origin} ${code}`,
        "（配对码 10 分钟内有效，只能使用一次；接好后它会自动上线，直接问我就能看到。）",
      ].join("\n"),
    );
  }

  /** A card button callback (already deduped); the Thread comes from the card's message id. */
  async handleCardAction(input: { operatorId: string; action: string; cardMsgId: string }): Promise<void> {
    const threadId = this.ledger.outbound.threadIdForProviderMsg(input.cardMsgId);
    const thread = threadId ? this.ledger.threads.get(threadId) : null;
    if (!thread) {
      await this.#deps.sendText("这张卡片关联的 Thread 不存在了。");
      return;
    }
    this.ledger.threads.markRead(threadId!); // a click is both read and a reply (§6.5)

    if (input.action === "wait_online") {
      if (this.hasLiveWorker(threadId!)) {
        await this.#deps.sendText("已经在跑或已在排队了，不用再点。", threadId);
        return;
      }
      const repoId = this.ledger.threads.repoIds(threadId!)[0];
      const machine = thread.lastMachine ? this.ledger.machines.get(thread.lastMachine) : null;
      if (!repoId || !machine) {
        await this.#deps.sendText("排队信息不完整，请重新派发一次。", threadId);
        return;
      }
      const prompt = thread.goal ?? thread.title;
      await this.dispatchTo(thread, machine.deviceId, repoId, prompt, true, `card:${input.cardMsgId}`);
      await this.#deps.sendText(`已排队：${machine.name} 上线后自动开始，完成后汇报。`, threadId);
      return;
    }

    if (input.action === "cancel") {
      const latest = this.ledger.workers.latestOnThread(threadId!);
      if (!latest) {
        // The ask card's cancel: nothing was ever enqueued, the Thread just stays put.
        this.ledger.timeline.add(threadId!, "note", "用户取消：等机器上线的派发已撤回", null);
        await this.#deps.sendText("已取消。想再派发时直接说即可。", threadId);
        return;
      }
      if (latest.cmdId && this.#deps.cancelQueuedCommand(latest.cmdId)) {
        this.ledger.timeline.add(threadId!, "note", "用户取消：命令在送出前撤回", null);
        await this.#deps.sendText("已取消。想再派发时直接说即可。", threadId);
        return;
      }
      await this.#deps.sendText("它已经上路了，撤不回运行中的任务；等它跑完看汇报吧。", threadId);
      return;
    }

    await this.#deps.sendText(`已收到按钮「${input.action}」。`, threadId);
  }

  private hasLiveWorker(threadId: string): boolean {
    return this.ledger.workers
      .listByThread(threadId)
      .some((w) => w.state === "starting" || w.state === "running" || w.state === "recovering");
  }

  /**
   * Registers the worker, then enqueues `start_worker`. Registration must precede the command:
   * the reducer skips events for unknown workers (advancing the watermark), so the row has to
   * exist before the connector can possibly emit `started`.
   */
  private async dispatchTo(
    thread: ThreadRow,
    deviceId: string,
    repoId: string,
    prompt: string,
    queued: boolean,
    provenance: string,
    cmdId?: string,
  ): Promise<void> {
    // Review (other findings): a replayed call carrying a cmdId that already exists must not
    // register a second worker row (the outbox dedupes the command, but the ghost `starting`
    // worker would sit on the Thread forever). Re-entering an existing command is a no-op.
    if (cmdId !== undefined && this.#deps.commandExists(cmdId)) return;
    const workerId = `w_${ulid()}`;
    // Relay (spec §5.3): a later worker on the same Thread continues from the previous branch.
    const previous = this.ledger.workers.latestOnThread(thread.threadId);
    const base = previous?.branch ?? undefined;
    this.ledger.questions.closeOpen(thread.threadId, "用户重新派发");
    this.ledger.workers.register({ workerId, threadId: thread.threadId, deviceId, repoId, agent: AGENT, mode: "write" });
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
        mode: "write",
        prompt,
        ...(base ? { base } : {}),
      },
      // Offline queueing is exactly `notAfter: null` (protocol §4.2): no expiry, delivered at
      // the next hello; the idle sweep still fails it after ~30 min of the machine not returning.
      { workerId, notAfter: queued ? null : undefined, cmdId },
    );
    this.ledger.workers.setCmdId(workerId, finalCmdId);
    this.ledger.timeline.add(
      thread.threadId,
      "dispatch",
      `派发给 ${machineName}${queued ? "（离线排队）" : ""}：${prompt}`,
      { workerId, cmdId: finalCmdId, repoId, provenance },
    );
  }
}

/** Thread titles stay scannable in cards and the brief: first line of the prompt, clipped. */
export function titleOf(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]!;
  return firstLine.length <= 24 ? firstLine : `${firstLine.slice(0, 23)}…`;
}
