// Outcome adjudication, docs/design/connector-pi.md §5.2. Pure logic over one run window
// (from the first `agent_start` after a command is accepted to the next `agent_settled`).
//
// Order matters: aborted → error class → reported → unreported. `report` is consulted only
// after 1 and 2: a report earlier in a failed run must not mask the failure.
import type { ErrorClass, ReportPayload, SettledOutcome } from "./agent.ts";

export interface AssistantFacts {
  stopReason?: string;
  errorMessage?: string;
  text: string;
}

export interface RetryFacts {
  success: boolean;
  finalError?: string;
}

/** Everything adjudication needs from one run window. */
export interface RunWindow {
  aborted: boolean;
  lastAssistant?: AssistantFacts;
  lastRetry?: RetryFacts;
  report?: ReportPayload;
}

export interface Adjudication {
  outcome: SettledOutcome;
  errorClass?: ErrorClass;
  report?: ReportPayload;
  /** Only for `unreported`: handed to the steward for fallback classification. */
  lastText?: string;
}

export function adjudicate(window: RunWindow): Adjudication {
  // 1. aborted == true → aborted.
  if (window.aborted) return { outcome: "aborted" };

  // 2. Last assistant message in the window has stopReason == "error", or the last
  //    auto_retry_end.success == false → error, classified (research #13: a model call
  //    failure produces no error event, only stopReason/errorMessage on the message).
  const errored = window.lastAssistant?.stopReason === "error" || window.lastRetry?.success === false;
  if (errored) {
    const message = window.lastAssistant?.errorMessage ?? window.lastRetry?.finalError ?? "";
    return { outcome: "error", errorClass: classifyError(message) };
  }

  // 3. `report` was called within the window → reported; take the LAST call.
  if (window.report) return { outcome: "reported", report: window.report };

  // 4. Otherwise → unreported: the forced re-report already ran and there is still no
  //    report; hand the last assistant text to the steward for fallback classification.
  return { outcome: "unreported", lastText: window.lastAssistant?.text || undefined };
}

/** Error classification, connector-pi.md §5.2 item 2. */
export function classifyError(message: string): ErrorClass {
  const msg = message.toLowerCase();
  // auth (401/403): no automatic retry; the user must fix the model credentials.
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api key/.test(msg)) return "auth";
  // context: context overflow; suggest a new session with a handoff brief.
  if (/context|token limit|maximum context|context_length|too many tokens|overflow/.test(msg)) return "context";
  // transient (429, 5xx, overload, network): one automatic resume allowed.
  if (/\b429\b|rate.?limit|\b5\d\d\b|overload|network|econn|timeout|timed out|fetch failed|socket/.test(msg)) {
    return "transient";
  }
  return "unknown";
}
