// Sig's injected pi extension, docs/design/connector-pi.md §7.1 and ADR-0001.
//
// The connector writes this file into ~/.sig/ext/ with each version and loads it via
// `--extension`; it never references in-repo files, so project content cannot swap it out.
// It does exactly three things:
//
// 1. Register the `report` tool (§7.2 fields).
// 2. In `agent_before_settle`, when this run window completed without any `report` call and
//    has not been reminded yet, append a `sig.report-reminder` custom message with
//    `continue: true`, forcing one more model request. At most one reminder per window.
//    (Measured: 5/6 → 6/6 report call rate, no duplicate calls — research #11.)
// 3. Write the steward `commandId` into a `custom` session entry (ADR-0001), replacing the
//    old "last user message text matches" ambiguity heuristic (connector-pi.md §15.2).
//    The connector delivers prompts as `/sig <commandId>\n<text>`; this command records
//    the marker and re-sends the clean text as a normal user message. Steer/follow_up
//    deliveries cannot be extension commands, so they carry a `[sig:command <id>]`
//    preamble that the input handler below strips and persists as the same custom entry.

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** `custom` entry customType for the command marker (ADR-0001). */
export const COMMAND_ENTRY_TYPE = "sig.command";
/** `custom_message` customType for the forced re-report reminder (§7.1). */
export const REMINDER_ENTRY_TYPE = "sig.report-reminder";
/** Extension command name; prompts are delivered as `/<name> <commandId>\n<text>`. */
export const COMMAND_NAME = "sig";

/** §6.3 steer/follow_up marker preamble: `[sig:command <commandId>]\n<text>`. */
export const MARKER_PREAMBLE = "[sig:command ";

function appendCommandEntry(pi: ExtensionAPI, commandId: string): void {
  pi.appendEntry(COMMAND_ENTRY_TYPE, { commandId, at: Date.now() });
}

const REMINDER_TEXT =
  "[Sig] You finished without calling the `report` tool. Call `report` now as your " +
  "final action: status (done | blocked | needs_decision), summary, changes " +
  "(or `answer` when nothing was modified), decisions, " +
  "leftovers, and — when blocked or needs_decision — the question for the user in `question`. " +
  "Do not answer this reminder in plain text.";

const reportParameters = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs_decision")], {
    description: "done: task complete. blocked: cannot proceed. needs_decision: the user must choose.",
  }),
  summary: Type.String({ description: "One-line conclusion." }),
  changes: Type.Optional(Type.Array(Type.String(), { description: "What was done, including locations." })),
  decisions: Type.Optional(
    Type.Array(Type.String(), { description: "Key decisions and reasons (handoff-brief material)." }),
  ),
  leftovers: Type.Optional(Type.Array(Type.String(), { description: "Leftover issues." })),
  tests: Type.Optional(
    Type.Object({
      ran: Type.Boolean(),
      passed: Type.Optional(Type.Boolean()),
      note: Type.Optional(Type.String()),
    }),
  ),
  question: Type.Optional(Type.String({ description: "Required when status is blocked or needs_decision." })),
  next: Type.Optional(Type.String({ description: "Suggested next step." })),
  answer: Type.Optional(
    Type.String({
      description:
        "The full answer or finding, when this task was informational (a question, an explanation, an investigation) rather than a code change. Use this instead of `changes` when nothing was modified.",
    }),
  ),
});

interface WindowState {
  reportCalled: boolean;
  reminded: boolean;
}

export default function sigExtension(pi: ExtensionAPI): void {
  // In-memory run-window state. A new user prompt opens a new window; the reminder's forced
  // continuation deliberately does not (it is part of the same window, so `reportCalled` and
  // `reminded` persist across it — that is what makes the reminder fire at most once).
  let window: WindowState = { reportCalled: false, reminded: false };

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") window = { reportCalled: false, reminded: false };
    return undefined;
  });

  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Report the outcome of this task to the user via Sig. This must be your LAST " +
      "action when the task is finished, blocked, or needs a user decision. Put questions " +
      "for the user in `question` (with status needs_decision); do not ask in plain text.",
    parameters: reportParameters,
    async execute(_toolCallId, params) {
      window.reportCalled = true;
      if ((params.status === "blocked" || params.status === "needs_decision") && !params.question) {
        throw new Error("`question` is required when status is blocked or needs_decision");
      }
      return {
        content: [{ type: "text", text: `Report received (status: ${params.status}). You can end your turn now.` }],
        details: { status: params.status },
      };
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Internal: deliver a Sig-dispatched prompt with its command marker.",
    handler: async (args: string) => {
      const newline = args.indexOf("\n");
      const commandId = newline === -1 ? null : args.slice(0, newline).trim();
      const text = newline === -1 ? args : args.slice(newline + 1);
      if (commandId) appendCommandEntry(pi, commandId);
      pi.sendUserMessage(text, { expandPromptTemplates: false });
    },
  });

  // §6.3: steer/follow_up deliveries arrive with a marker preamble (extension commands are
  // not allowed there). The input handler runs before the message is queued or persisted, so
  // it strips the preamble and appends the commandId custom entry in the same synchronous
  // step — when the connector later crashes mid-`sending`, the presence of this entry in the
  // session tail means the queued message was delivered, and its absence is evidence too.
  pi.on("input", (event) => {
    const text = typeof event.text === "string" ? event.text : null;
    if (!text || !text.startsWith(MARKER_PREAMBLE)) return undefined;
    const newline = text.indexOf("\n");
    const commandId = newline === -1 ? null : text.slice(MARKER_PREAMBLE.length, newline).replace(/\]$/, "").trim();
    if (!commandId || /[\r\n]/.test(commandId)) return undefined;
    appendCommandEntry(pi, commandId);
    return { action: "transform" as const, text: newline === -1 ? "" : text.slice(newline + 1) };
  });

  pi.on("agent_before_settle", (event) => {
    // Fire at most once per window, and only for a run that completed without an error and
    // without a report call (§7.1: outcome == completed; `outcome` is provided by pi).
    if (event.outcome !== "completed" || window.reportCalled || window.reminded) return undefined;
    if (!event.context.canContinue) return undefined;
    window.reminded = true;
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: REMINDER_ENTRY_TYPE, content: REMINDER_TEXT, display: false },
      ],
      continue: true,
    };
  });
}
