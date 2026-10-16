// Fixed-phrase dispatch, no LLM (issue #5, steward.md §14 M1): the owner sends a fixed
// command phrase in Feishu naming a repo (and optionally a machine) plus a prompt; a Thread is
// created, a `start_worker` command is enqueued over the connector protocol, and the done
// report comes back through the deterministic reducer + template. Quote-replies and card
// callbacks resolve the Thread via providerMsgId (steward.md §3.1 signal 1). Machine choice is
// the deterministic rule of ADR-0001 decision 6; a Thread keeps its last machine and the
// command queues while that machine is offline (spike bug 4).
import { ulid } from "@shepherd/protocol";
import type { Ledger, ThreadRow } from "./ledger.ts";
import { HELP_TEXT, offlineAskCard, statusText } from "./report-template.ts";

/** The M1 fixed phrases. Natural language arrives with the M2 steward LLM. */
const DISPATCH_RE = /^\/(?:派发|dispatch|run)\s+(\S+)(?:\s+([\s\S]+))?$/;
const STATUS_RE = /^\/(?:状态|status)\s*$/;

export type OwnerCommand =
  | { kind: "dispatch"; repoRef: string; machineHint: string | null; prompt: string }
  | { kind: "status" };

/** Parses `/派发 <repo>[@<machine>] <prompt>` and `/状态`. Anything else returns null. */
export function parseOwnerText(text: string): OwnerCommand | null {
  const trimmed = text.trim();
  if (STATUS_RE.test(trimmed)) return { kind: "status" };
  const match = DISPATCH_RE.exec(trimmed);
  if (!match) return null;
  const prompt = (match[2] ?? "").trim();
  if (prompt.length === 0) return null;
  const repoToken = match[1]!;
  const at = repoToken.indexOf("@");
  const repoRef = at === -1 ? repoToken : repoToken.slice(0, at);
  const machineHint = at === -1 ? null : repoToken.slice(at + 1);
  if (repoRef.length === 0 || machineHint === "") return null;
  return { kind: "dispatch", repoRef, machineHint, prompt };
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

export interface DispatcherDeps {
  ledger: Ledger;
  /** Enqueues a connector command (steward.enqueue); `notAfter: null` = wait until online. */
  enqueueCommand: (
    deviceId: string,
    kind: string,
    args: Record<string, unknown>,
    opts: { workerId?: string; notAfter?: number | null },
  ) => Promise<{ cmdId: string }>;
  /** Withdraws a still-queued command; false once it has left the DO. */
  cancelQueuedCommand: (cmdId: string) => boolean;
  sendText: (text: string, threadId?: string | null) => Promise<void>;
  sendCard: (card: unknown, threadId: string) => Promise<void>;
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

  /** An owner text message (already deduped / owner-checked by the channel layer). */
  async handleOwnerText(input: { text: string; parentId?: string; msgId: string }): Promise<void> {
    // Signal 1 (§3.1): a quote-reply to one of our messages routes to that Thread directly —
    // never through any text interpretation.
    if (input.parentId) {
      const threadId = this.ledger.outbound.threadIdForProviderMsg(input.parentId);
      if (threadId) {
        const thread = this.ledger.threads.get(threadId);
        if (thread) {
          this.ledger.threads.markRead(threadId); // a reply means the report was seen (§6.5)
          const command = parseOwnerText(input.text);
          if (command?.kind === "dispatch") {
            await this.dispatch(command, { thread, fromMsgId: input.msgId });
          } else {
            await this.#deps.sendText(`已路由到 Thread「${thread.title}」。目前只认固定指令：\n${HELP_TEXT}`, threadId);
          }
          return;
        }
      }
      // A quote of something that is not ours (or an unknown id): fall through to fresh parse.
    }

    const command = parseOwnerText(input.text);
    if (command === null) {
      await this.#deps.sendText(HELP_TEXT);
      return;
    }
    if (command.kind === "status") {
      await this.#deps.sendText(statusText(this.ledger.threads.list(), this.ledger.machines.list()));
      return;
    }
    await this.dispatch(command, { thread: null, fromMsgId: input.msgId });
  }

  /** A card button callback (already deduped); the Thread comes from the card's message id. */
  async handleCardAction(input: { operatorId: string; action: string; cardMsgId: string }): Promise<void> {
    const threadId = this.ledger.outbound.threadIdForProviderMsg(input.cardMsgId);
    if (!threadId) {
      await this.#deps.sendText("这张卡片关联的 Thread 不存在了。");
      return;
    }
    const thread = this.ledger.threads.get(threadId);
    if (!thread) {
      await this.#deps.sendText("这张卡片关联的 Thread 不存在了。");
      return;
    }
    this.ledger.threads.markRead(threadId); // a click is both read and a reply (§6.5)

    if (input.action === "wait_online") {
      if (this.hasLiveWorker(threadId)) {
        await this.#deps.sendText("已经在跑或已在排队了，不用再点。", threadId);
        return;
      }
      const repoId = this.ledger.threads.repoIds(threadId)[0];
      const machine = thread.lastMachine ? this.ledger.machines.get(thread.lastMachine) : null;
      if (!repoId || !machine) {
        await this.#deps.sendText("排队信息不完整，请重新 /派发 一次。", threadId);
        return;
      }
      const prompt = thread.goal ?? thread.title;
      await this.dispatchTo(thread, machine.deviceId, repoId, prompt, true);
      await this.#deps.sendText(`已排队：${machine.name} 上线后自动开始，完成后汇报。`, threadId);
      return;
    }

    if (input.action === "cancel") {
      const latest = this.ledger.workers.latestOnThread(threadId);
      if (!latest) {
        // The ask card's cancel: nothing was ever enqueued, the Thread just stays put.
        this.ledger.timeline.add(threadId, "note", "用户取消：等机器上线的派发已撤回", null);
        await this.#deps.sendText("已取消。想再派发时重新发 /派发 即可。", threadId);
        return;
      }
      if (latest.cmdId && this.#deps.cancelQueuedCommand(latest.cmdId)) {
        this.ledger.timeline.add(threadId, "note", "用户取消：命令在送出前撤回", null);
        await this.#deps.sendText("已取消。想再派发时重新发 /派发 即可。", threadId);
        return;
      }
      await this.#deps.sendText("它已经上路了，M1 撤不回运行中的任务；等它跑完看汇报吧。", threadId);
      return;
    }

    await this.#deps.sendText(`已收到按钮「${input.action}」。`, threadId);
  }

  private hasLiveWorker(threadId: string): boolean {
    return this.ledger.workers
      .listByThread(threadId)
      .some((w) => w.state === "starting" || w.state === "running" || w.state === "recovering");
  }

  /** Fresh dispatch (creates the Thread) or continuation (attaches to the quoted Thread). */
  private async dispatch(
    command: Extract<OwnerCommand, { kind: "dispatch" }>,
    ctx: { thread: ThreadRow | null; fromMsgId: string },
  ): Promise<void> {
    const repoRows = this.ledger.repos.machinesHaving(command.repoRef);
    if (repoRows.length === 0) {
      await this.#deps.sendText(`没有机器登记过仓库「${command.repoRef}」。先在那台机器上 shepherd add-repo 并重连。`);
      return;
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
      machineHint: command.machineHint,
      lastMachine: ctx.thread?.lastMachine ?? null,
      continuation: ctx.thread !== null,
    });

    switch (choice.kind) {
      case "no_match":
        await this.#deps.sendText(
          `机器「${command.machineHint}」上没有仓库「${command.repoRef}」。用 /状态 查看机器与仓库。`,
        );
        return;
      case "ask_which": {
        const listing = choice.candidates.map((c) => `${c.name}${c.online ? "" : "（离线）"}`).join("、");
        await this.#deps.sendText(`多台机器都有「${command.repoRef}」：${listing}。用 /派发 ${command.repoRef}@<machine> 指定一台。`);
        return;
      }
      case "ask_offline": {
        // spec §9: offline at dispatch time is the user's call — ask, never decide silently.
        const machine = this.ledger.machines.get(choice.deviceId)!;
        const thread =
          ctx.thread ??
          this.ledger.threads.create({
            title: titleOf(command.prompt),
            goal: command.prompt,
            createdFromMsg: ctx.fromMsgId,
            repoIds: [repoRows.find((r) => r.deviceId === choice.deviceId)!.repoId],
          });
        if (!ctx.thread) {
          this.ledger.timeline.add(thread.threadId, "user_instruction", command.prompt, { msgId: ctx.fromMsgId });
        }
        // Affinity from the start: the ask is about this machine, remember it for the callback.
        this.ledger.threads.setLastMachine(thread.threadId, choice.deviceId);
        this.ledger.recomputeThreadState(thread.threadId);
        await this.#deps.sendCard(offlineAskCard(command.repoRef, machine.name, thread.title), thread.threadId);
        return;
      }
      case "machine": {
        const machine = this.ledger.machines.get(choice.deviceId)!;
        const repoId = repoRows.find((r) => r.deviceId === choice.deviceId)!.repoId;
        let thread = ctx.thread;
        let created = false;
        if (!thread) {
          thread = this.ledger.threads.create({
            title: titleOf(command.prompt),
            goal: command.prompt,
            createdFromMsg: ctx.fromMsgId,
            repoIds: [repoId],
          });
          this.ledger.timeline.add(thread.threadId, "user_instruction", command.prompt, { msgId: ctx.fromMsgId });
          created = true;
        }
        await this.dispatchTo(thread, choice.deviceId, repoId, command.prompt, choice.queued);
        const head = created ? `已创建「${thread.title}」并派发` : `已续派`;
        const tail = choice.queued
          ? `${machine.name} 当前不在线，已排队，上线后自动开始。`
          : `派给 ${machine.name}（${command.repoRef}，${AGENT}）。完成后我会汇报。`;
        await this.#deps.sendText(`${head}：${tail}`, thread.threadId);
        return;
      }
    }
  }

  /**
   * Registers the worker, then enqueues `start_worker`. Registration must precede the command:
   * the reducer skips events for unknown workers (advancing the watermark), so the row has to
   * exist before the connector can possibly emit `started`.
   */
  private async dispatchTo(thread: ThreadRow, deviceId: string, repoId: string, prompt: string, queued: boolean): Promise<void> {
    const workerId = `w_${ulid()}`;
    // Relay (spec §5.3): a later worker on the same Thread continues from the previous branch.
    const previous = this.ledger.workers.latestOnThread(thread.threadId);
    const base = previous?.branch ?? undefined;
    this.ledger.questions.closeOpen(thread.threadId, "用户重新派发");
    this.ledger.workers.register({ workerId, threadId: thread.threadId, deviceId, repoId, agent: AGENT, mode: "write" });
    this.ledger.threads.setLastMachine(thread.threadId, deviceId);
    this.ledger.recomputeThreadState(thread.threadId);
    const machineName = this.ledger.machines.get(deviceId)?.name ?? deviceId;
    const { cmdId } = await this.#deps.enqueueCommand(
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
      { workerId, notAfter: queued ? null : undefined },
    );
    this.ledger.workers.setCmdId(workerId, cmdId);
    this.ledger.timeline.add(
      thread.threadId,
      "dispatch",
      `派发给 ${machineName}${queued ? "（离线排队）" : ""}：${prompt}`,
      { workerId, cmdId, repoId },
    );
  }
}

/** Thread titles stay scannable in cards and /状态: first line of the prompt, clipped. */
function titleOf(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]!;
  return firstLine.length <= 24 ? firstLine : `${firstLine.slice(0, 23)}…`;
}
