// The workspace's read model (ADR-0004, spec §7.3): one JSON snapshot of everything the
// browser draws — the continuous conversation, Threads, machines, and the decisions waiting
// for the owner. Pure assembly over the ledger's views; nothing here writes, and nothing the
// ledger keeps private (run text, wake text, worker transcripts, command ids) is exposed.
import type { BudgetState } from "./budget.ts";
import type { Ledger } from "./ledger.ts";

/** Where a message entered the conversation. New rows are all `local` (ADR-0003: the owner
 *  API and the web workspace are two views of one local channel); `feishu`/`web` remain only
 *  on rows written by deployments that predate the merge. */
export type OwnerChannel = "local" | "feishu" | "web";

/** A message the owner typed in the workspace. `id` is the client's request id (idempotency key). */
export interface WorkspaceInput {
  id: string;
  text: string;
  /** Routes the message to this Thread (the owner picked it in the sidebar). */
  threadId?: string;
  /** The id of the card or message being answered (an outbound row id). */
  replyTo?: string;
}

/** A button the owner pressed on a card. `cardId` is the outbound row id of that card. */
export interface WorkspaceActionInput {
  id: string;
  cardId: string;
  action: string;
}

export class WorkspaceError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

// ---- cards ----------------------------------------------------------------------------------------

export interface CardButton {
  label: string;
  /** Callback buttons carry an opaque action; link buttons carry a URL. */
  action?: string;
  url?: string;
  primary?: boolean;
}

/** What a card is about; the workspace labels and icons it by this, not by its (Chinese) title. */
export type CardKind = "question" | "consent" | "offline" | "offer" | "memory" | "report" | "update";

/** Only a card that holds a decision is drawn as a card; reports and updates are plain messages. */
const DECISION_KINDS: ReadonlySet<CardKind> = new Set(["question", "consent", "offline", "offer", "memory"]);

export interface CardView {
  tone: "success" | "attention" | "failure" | "info";
  title: string;
  body: string[];
  note: string | null;
  buttons: CardButton[];
}

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const TONES: Record<string, CardView["tone"]> = { green: "success", orange: "attention", red: "failure" };

/** The tone emoji report-template.ts prefixes its first line with. */
const TONE_EMOJI: Array<[string, CardView["tone"]]> = [
  ["✅", "success"],
  ["❓", "attention"],
  ["⚠️", "attention"],
  ["❌", "failure"],
  ["🧠", "attention"],
  ["💡", "info"],
];

/** The 详情 line is a one-time login into this very workspace — pointless inside it. */
const DETAIL_LINK_LINE = /^详情：\S*\/link\/wl1\.\S*[ \t]*$/gm;
const workspaceText = (text: string): string => text.replace(DETAIL_LINK_LINE, "").replace(/\n{3,}/g, "\n\n").trim();

/** A flat LocalMessage ({text, buttons}) → the structured view: the optional leading
 *  【Thread】 prefix becomes the note, the tone emoji sets the tone, the rest of the first
 *  line is the title and everything after it is ONE markdown body — blank lines and
 *  indentation intact, so lists, code fences and paragraphs survive. */
function localMessageView(text: string, rawButtons: unknown): CardView {
  let rest = workspaceText(text);
  let note: string | null = null;
  const prefixed = /^【([^】]{1,120})】([\s\S]*)$/.exec(rest);
  if (prefixed) {
    note = prefixed[1]!;
    rest = prefixed[2]!;
  }
  let tone: CardView["tone"] = "info";
  for (const [emoji, mapped] of TONE_EMOJI) {
    if (rest.startsWith(emoji)) {
      tone = mapped;
      rest = rest.slice(emoji.length);
      break;
    }
  }
  const [first = "", ...lines] = rest.split("\n");
  const title = first.trim();
  const markdown = lines.join("\n").trim();
  const body = markdown === "" ? [] : [markdown];
  const buttons: CardButton[] = (Array.isArray(rawButtons) ? rawButtons : []).map(obj)
    .filter((b) => typeof b.label === "string" && b.label !== "")
    .map((b) => ({
      label: str(b.label),
      ...(typeof b.action === "string" && b.action !== "" ? { action: b.action } : {}),
      // Detail links are one-time logins into this very workspace — pointless inside it.
      ...(typeof b.url === "string" && /^https?:\/\//i.test(b.url) && !b.url.includes("/link/wl1.") ? { url: b.url } : {}),
      ...(b.primary === true ? { primary: true } : {}),
    }))
    // A button that does neither (its only url was a one-time login link, or it carried
    // nothing but a label) is decoration: drop it rather than render a dead control.
    .filter((b) => b.action !== undefined || b.url !== undefined);
  return { tone, title, body, note, buttons };
}

/** Hints that only make sense inside Feishu (quote-replying); the workspace has its own composer. */
const CHAT_ONLY_HINTS = [
  /(?: · )?引用回复可继续这个 Thread/g,
  /(?: · )?点按钮即可回答；也可以直接回复这张卡片。/g,
  /(?: · )?直接回复这张卡片即可回答。/g,
  /(?: · )?点「创建」后才会保存；随时可以让我暂停或取消。/g,
];
/** A status emoji the Feishu title or footer leads with; the card's tone already says it. */
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}\uFE0F?\s*)+/u;

/** Feishu interactive-card JSON → the compact shape the workspace draws. The card templates
 *  stay the single source of truth; no Feishu element tags reach the browser. */
export function cardView(card: unknown): CardView {
  const root = obj(card);
  // The local channel's cards are flat text + opaque buttons (ADR-0003's LocalMessage);
  // the structured view the workspace draws is derived from the templates' own markers —
  // the leading 【Thread】 prefix and tone emoji are written by report-template.ts, so this
  // mapping is deterministic, not a guess at natural language.
  if (typeof root.text === "string" && !root.header) return localMessageView(root.text, root.buttons);
  // Records from the workspace's own era keep their shape; the legacy parser below preserves
  // old decisions.
  if (root.type === "pip-card") return {
    tone: ["success", "attention", "failure", "info"].includes(str(root.tone)) ? root.tone as CardView["tone"] : "info",
    title: str(root.title), body: Array.isArray(root.body) ? root.body.filter((s): s is string => typeof s === "string") : [],
    note: typeof root.note === "string" ? root.note : null,
    buttons: (Array.isArray(root.buttons) ? root.buttons : []).map(obj).filter(b => typeof b.label === "string").map(b => ({
      label: str(b.label), ...(typeof b.action === "string" ? { action: b.action } : {}),
      ...(typeof b.url === "string" && /^https?:\/\//i.test(b.url) ? { url: b.url } : {}), ...(b.primary === true ? { primary: true } : {}),
    })),
  };
  const header = obj(root.header);
  const body: string[] = [];
  const buttons: CardButton[] = [];
  let note: string | null = null;
  for (const raw of Array.isArray(root.elements) ? root.elements : []) {
    const element = obj(raw);
    if (element.tag === "div") {
      const content = str(obj(element.text).content);
      if (content) body.push(content);
    } else if (element.tag === "action") {
      for (const rawButton of Array.isArray(element.actions) ? element.actions : []) {
        const button = obj(rawButton);
        const label = str(obj(button.text).content);
        const action = str(obj(button.value).action);
        const url = str(button.url);
        if (!label) continue;
        // Detail links are one-time logins into this very workspace — pointless inside it.
        if (url && (!/^https?:\/\//i.test(url) || url.includes("/link/wl1."))) continue;
        if (!action && !url) continue;
        buttons.push({ label, ...(action ? { action } : {}), ...(url ? { url } : {}), ...(button.type === "primary" ? { primary: true } : {}) });
      }
    } else if (element.tag === "note") {
      const text = (Array.isArray(element.elements) ? element.elements : []).map((part) => str(obj(part).content)).filter(Boolean).join(" ");
      note = CHAT_ONLY_HINTS.reduce((acc, pattern) => acc.replace(pattern, ""), text).replace(LEADING_EMOJI, "").replace(/\s*·\s*$/, "").trim() || null;
    }
  }
  // The tone is drawn by the card itself; the status emoji the Feishu title leads with would only repeat it.
  const title = str(obj(header.title).content).replace(LEADING_EMOJI, "");
  return { tone: TONES[str(header.template)] ?? "info", title, body, note, buttons };
}

export function cardKind(row: Pick<CardRow, "id" | "questionId">, view: CardView): CardKind {
  const { id } = row;
  if (id.startsWith("offer:")) return "offer";
  if (id.startsWith("offline:") || id.startsWith("switch:")) return "offline";
  if (id.startsWith("noteask:")) return "memory";
  if (id.startsWith("notify:report:")) return view.buttons.some((button) => button.action === "pr_approve") ? "consent" : "report";
  if (row.questionId !== null || view.buttons.some((button) => /^ask(?:new)?:/.test(button.action ?? ""))) return "question";
  return "update";
}

/** A non-decision card read as the ordinary message it is: the template's own text, or, for
 *  records from before ADR-0003, the structured view's title and body. */
function messageText(card: unknown, view: CardView): string {
  const text = obj(card).text;
  return typeof text === "string" ? workspaceText(text) : [view.title, ...view.body].filter(Boolean).join("\n\n");
}

interface CardRow {
  id: string;
  threadId: string | null;
  questionId: string | null;
  payload: string;
  createdAt: number;
}

/** Whether a card still holds a decision for the owner. Each kind of card has its own
 *  source of truth; anything unrecognised is treated as closed, so a stale button is never
 *  offered. The same answer gates the action endpoint. */
export function cardOpen(ledger: Ledger, row: Pick<CardRow, "id" | "questionId">, view: CardView): boolean {
  const { id } = row;
  if (id.startsWith("offer:")) return ledger.offers.get(id.slice("offer:".length))?.status === "offered";
  if (id.startsWith("offline:")) return ledger.offlineDispatches.get(id.slice("offline:".length))?.status === "offered";
  if (id.startsWith("switch:")) return ledger.offlineDispatches.get(id.slice("switch:".length))?.status === "switching";
  if (id.startsWith("noteask:")) {
    const ask = /^noteask:(n_[^:]+):(\d+)$/.exec(id);
    return ask !== null && ledger.notes.askOpen(ask[1]!, Number(ask[2]));
  }
  if (id.startsWith("notify:report:")) {
    const report = /^notify:report:([^:]+):(\d+)$/.exec(id);
    if (report === null || !view.buttons.some((button) => button.action === "pr_approve")) return false;
    const consent = ledger.prConsent.get(report[1]!, Number(report[2]));
    const branch = ledger.prConsent.branchState(report[1]!);
    // Undecided, or approved and failed (the owner may retry); declined or in flight is settled.
    return !branch.url && !branch.pending && (consent === null || consent.failure !== null);
  }
  const asked = view.buttons.map((button) => /^ask(?:new)?:([^:]+)/.exec(button.action ?? "")?.[1]).find((qid) => qid !== undefined);
  const qid = asked ?? row.questionId;
  return qid !== null && qid !== undefined && ledger.questions.get(qid)?.status === "open";
}

const parsePayload = (row: { payload: string }): { text?: string; card?: unknown; private?: boolean } => {
  try {
    return obj(JSON.parse(row.payload)) as { text?: string; card?: unknown; private?: boolean };
  } catch {
    return {};
  }
};

// ---- the snapshot ---------------------------------------------------------------------------------

export interface WorkspaceDevice {
  deviceId: string;
  name: string;
  online: boolean;
  revoked: boolean;
}

export interface WorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  channel: OwnerChannel;
  at: number;
  threadId: string | null;
  text?: string;
  card?: CardView & { kind: CardKind };
  /** A card whose decision is still pending. */
  open?: boolean;
  /** Assistant delivery state; web rows are always `sent`. */
  status?: string;
}

const parseProgress = (raw: string | null): { phase?: string; tool?: string; target?: string } | null => {
  if (!raw) return null;
  try {
    const parsed = obj(JSON.parse(raw));
    const pick = (key: string): string | undefined => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
    const progress = { phase: pick("phase"), tool: pick("tool"), target: pick("target") };
    return progress.phase || progress.tool || progress.target ? progress : null;
  } catch {
    return null;
  }
};

export function workspaceSnapshot(input: { ledger: Ledger; budget: BudgetState; devices: WorkspaceDevice[]; now: number }) {
  const { ledger, budget, devices, now } = input;
  const view = ledger.views.workspace();
  const machineName = new Map(devices.map((device) => [device.deviceId, device.name]));
  const repoNamesByMachine = new Map<string, string[]>();
  for (const repo of view.repos) {
    repoNamesByMachine.set(repo.deviceId, [...(repoNamesByMachine.get(repo.deviceId) ?? []), repo.name]);
  }
  const repoName = new Map(view.repos.map((repo) => [repo.repoId, repo.name]));
  const ledgerMachines = new Map(view.machines.map((machine) => [machine.deviceId, machine]));

  const messages: WorkspaceMessage[] = [
    ...view.inputs.map((row) => ({
      id: `user:${row.id}`,
      role: "user" as const,
      channel: (row.channel as OwnerChannel) ?? "local",
      at: row.at,
      threadId: row.threadId,
      text: row.text,
    })),
    ...view.outbound.filter((row) => !parsePayload({ payload: String(row.payload) }).private).map((row): WorkspaceMessage => {
      const id = String(row.id);
      const payload = parsePayload({ payload: String(row.payload) });
      const base = {
        id,
        role: "assistant" as const,
        channel: (row.channel as OwnerChannel) ?? "local",
        at: Number(row.createdAt),
        threadId: (row.threadId as string | null) ?? null,
        status: String(row.status),
      };
      if (row.kind === "card") {
        const ref = { id, questionId: (row.questionId as string | null) ?? null };
        const card = cardView(payload.card);
        const kind = cardKind(ref, card);
        if (!DECISION_KINDS.has(kind)) return { ...base, text: messageText(payload.card, card) };
        return { ...base, card: { ...card, kind }, open: cardOpen(ledger, ref, card) };
      }
      return { ...base, text: payload.text ?? "" };
    }),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const attention = (view.decisionCards as unknown as CardRow[])
    .map((row) => {
      const card = cardView(parsePayload(row).card);
      return { row, card };
    })
    .filter(({ row, card }) => cardOpen(ledger, row, card))
    .map(({ row, card }) => ({ id: row.id, kind: cardKind(row, card), threadId: row.threadId, questionId: row.questionId, at: Number(row.createdAt), ...card }));

  return {
    now,
    busy: view.busy,
    threads: view.threads.map((thread) => ({
      id: thread.threadId,
      title: thread.title,
      goal: thread.goal,
      summary: thread.summary,
      state: thread.state,
      unread: thread.unread,
      createdAt: thread.createdAt,
      lastActivityAt: thread.lastActivityAt,
      machine: thread.lastMachine ? (machineName.get(thread.lastMachine) ?? thread.lastMachine) : null,
      repos: thread.repoIds.map((repoId) => repoName.get(repoId) ?? repoId),
      workers: thread.workers.map((worker) => {
        const git = worker.report?.git ?? null;
        return {
          id: worker.workerId,
          agent: worker.agent,
          mode: worker.mode,
          state: worker.state,
          unreachable: worker.unreachable === true,
          machine: worker.machineName,
          branch: worker.branch,
          sessionId: worker.sessionId,
          outcome: worker.lastOutcome,
          progress: parseProgress(worker.lastProgress),
          contextPercent: worker.contextPercent,
          lastEventAt: worker.lastEventAt,
          createdAt: worker.createdAt,
          git: git ? { branch: git.branch, ahead: git.ahead, pushed: git.pushed, dirty: git.dirty } : null,
          pr: worker.consent ? { decision: worker.consent.decision, url: worker.consent.url, failure: worker.consent.failure } : null,
        };
      }),
      timeline: thread.timeline.map((entry) => ({ id: entry.id, at: entry.ts, kind: entry.kind, text: entry.text })),
    })),
    machines: devices.map((device) => {
      const machine = ledgerMachines.get(device.deviceId);
      return {
        id: device.deviceId,
        name: machine?.name ?? device.name,
        online: !device.revoked && (machine?.online ?? false),
        revoked: device.revoked,
        lastSeen: machine?.lastSeen ?? null,
        agents: machine?.agents ?? [],
        slots: machine ? { running: machine.running, max: machine.maxWorkers } : null,
        repos: repoNamesByMachine.get(device.deviceId) ?? [],
      };
    }),
    messages,
    attention,
    activity: view.activity.map((entry) => ({ id: entry.id, threadId: entry.threadId, at: entry.ts, kind: entry.kind, text: entry.text })),
    budget: {
      costUsd: budget.costUsd,
      tokens: budget.tokens,
      limitUsd: budget.budgetUsd,
      over: budget.over,
      day: budget.day,
      resetsAt: budget.resetsAt,
    },
  };
}
