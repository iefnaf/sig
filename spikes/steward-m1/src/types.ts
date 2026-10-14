// Event shapes arriving from connectors (connector-pi.md §11.1). M1 subset.
export type WorkerId = string;
export type ThreadId = string;

export interface ReportPayload {
	status: "done" | "blocked" | "needs_decision";
	summary: string;
	changes?: string[];
	decisions?: string[];
	leftovers?: string[];
	tests?: { ran: boolean; passed?: boolean; note?: string };
	question?: string;
	next?: string;
	git?: { branch?: string; ahead?: number; dirty?: number; pushed?: boolean };
}

export type WorkerEvent =
	| { workerId: WorkerId; seq: number; ts: number; type: "started"; sessionId?: string; branch?: string }
	| { workerId: WorkerId; seq: number; ts: number; type: "progress"; phase?: string; tool?: string; target?: string; turn?: number }
	| ({ workerId: WorkerId; seq: number; ts: number; type: "report" } & ReportPayload)
	| { workerId: WorkerId; seq: number; ts: number; type: "settled"; outcome: "reported" | "aborted" | "error" | "unreported"; errorClass?: "auth" | "transient" | "context" | "unknown"; lastText?: string; usage?: unknown }
	| { workerId: WorkerId; seq: number; ts: number; type: "lost"; reason?: string }
	| { workerId: WorkerId; seq: number; ts: number; type: "resumed"; attempt?: number }
	| { workerId: WorkerId; seq: number; ts: number; type: "broken"; reason?: string }
	| { workerId: WorkerId; seq: number; ts: number; type: "external_activity"; entries?: number; note?: string };

// What the reducer asks the rest of the system to do (steward.md §5.1 step 4).
export interface Intent {
	type: "notify" | "decision_window" | "wake";
	template?: string; // for notify: which template renders it
	threadId?: ThreadId;
	workerId?: WorkerId;
	questionId?: string; // decision_window
	dueAt?: number; // decision_window
	priority?: "high" | "normal" | "low"; // wake
	payload?: Record<string, unknown>;
}

export interface ApplyResult {
	applied: number; // events newly applied
	duplicated: number;
	intents: Intent[];
}
