// Live replies (ADR-0004): while the agent is writing an answer, an open workspace shows the words as
// they arrive. This is the only place that touches pi's experimental agent-event stream
// (`session.events()`, pinned at 1.3.0): everything else in the workspace is plain ledger data
// that a "something changed" nudge tells the page to refetch. If the stream changes shape or
// fails, replies still appear — whole, a moment later — exactly as they do without it.
import type { AgentEvent, AgentEventStream } from "@earendil-works/pi-durable";

/** What a block of an assistant message contributes: its text, when it is text. */
function textOf(block: unknown): string {
  const candidate = block as { type?: unknown; text?: unknown } | null;
  return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

/**
 * The text of the assistant message being written, rebuilt from event batches. A message is a
 * list of blocks (text, thinking, tool calls); only the text blocks are the reply, so deltas of
 * the others are ignored, and a block pi finishes replaces whatever was accumulated for it.
 */
export class LiveReply {
  #blocks = new Map<number, string>();
  #writing = false;

  get text(): string {
    return [...this.#blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
  }

  /**
   * Feeds one batch; returns every distinct text the reply passed through, in order ("" = nothing
   * being written). A run's last words and the end of the run can arrive in one batch, so the
   * intermediate states matter: the final text must be seen before the clear.
   */
  apply(events: readonly AgentEvent[]): string[] {
    const seen: string[] = [];
    let previous = this.text;
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          // Attachment, or an overflow that replaced undelivered batches: start from what is in flight.
          this.#reset();
          if (event.generation?.message) this.#begin(event.generation.message.content);
          break;
        case "message_start":
          this.#reset();
          if (event.message.role === "assistant") this.#begin(event.message.content);
          break;
        case "message_update":
          if (!this.#writing) break;
          for (const change of event.changes) {
            if (change.type === "text_start" || change.type === "block") this.#blocks.set(change.contentIndex, textOf(change.block));
            else if (change.type === "text_delta") this.#blocks.set(change.contentIndex, (this.#blocks.get(change.contentIndex) ?? "") + change.delta);
            else if (change.type === "message") this.#begin(change.message.content);
          }
          break;
        case "message_end": {
          // The finished message is the whole truth, including words the last update batch never carried.
          const finished = (event.entry as { model?: Array<{ role?: string; content?: unknown }> }).model?.[0];
          if (finished?.role === "assistant" && Array.isArray(finished.content)) this.#begin(finished.content);
          // The words stay on screen until the next message starts or the run ends: the final reply
          // takes their place a moment later, and a gap in between would only flicker.
          this.#writing = false;
          break;
        }
        case "run_end":
          this.#reset();
          break;
        default:
          break;
      }
      const now = this.text;
      if (now !== previous) seen.push(now);
      previous = now;
    }
    return seen;
  }

  #begin(content: readonly unknown[]): void {
    this.#writing = true;
    this.#blocks.clear();
    content.forEach((block, index) => {
      const text = textOf(block);
      if (text !== "") this.#blocks.set(index, text);
    });
  }

  #reset(): void {
    this.#writing = false;
    this.#blocks.clear();
  }
}

export interface WorkspaceStreamDeps {
  /** Opens pi's event stream for the steward conversation. */
  open(): Promise<AgentEventStream>;
  /** How many workspaces are connected; the stream is held only while someone is watching. */
  audience(): number;
  /** Whether what is being written reaches the owner (their conversation) or is bookkeeping that never will. */
  forOwner(): Promise<{ threadId: string | null } | null>;
  /** A run just finished: settle it now instead of waiting for the next poll, so its reply follows its last word at once. */
  onRunEnd(): void;
  send(frame: string): void;
  log(reason: string, detail: string): void;
}

/** Holds at most one subscription and turns its events into `stream` frames, a few per second. */
export class WorkspaceStream {
  readonly #deps: WorkspaceStreamDeps;
  readonly #reply = new LiveReply();
  #stream: AgentEventStream | null = null;
  #attaching = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #waiting: string[] = [];
  #owner: { value: { threadId: string | null } | null } | undefined;
  #lastSent = "";

  constructor(deps: WorkspaceStreamDeps) {
    this.#deps = deps;
  }

  /** Subscribes if someone is watching and nothing is subscribed yet. Cheap enough to call on every connection and every nudge. */
  ensure(): void {
    if (this.#stream !== null || this.#attaching || this.#deps.audience() === 0) return;
    this.#attaching = true;
    void this.#attach()
      .catch((error) => this.#deps.log("workspace_stream_failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { this.#attaching = false; });
  }

  /** Drops the subscription; the next `ensure()` opens a fresh one. */
  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#waiting = [];
    this.#owner = undefined;
    const stream = this.#stream;
    this.#stream = null;
    this.#lastSent = "";
    if (stream !== null) await stream.stop().catch(() => undefined);
  }

  async #attach(): Promise<void> {
    const stream = await this.#deps.open();
    if (this.#deps.audience() === 0) {
      await stream.stop().catch(() => undefined);
      return;
    }
    this.#stream = stream;
    this.#apply([stream.snapshot]);
    stream.start(async (events) => this.#apply(events));
    void stream.closed.then(() => {
      if (this.#stream === stream) this.#stream = null; // the next ensure() starts over
    });
  }

  #apply(events: readonly AgentEvent[]): void {
    if (events.some((event) => event.type === "run_end")) this.#deps.onRunEnd();
    const texts = this.#reply.apply(events);
    if (texts.length === 0) return;
    this.#waiting.push(...texts);
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, 90);
  }

  /** Sends the newest words, and then the clear if the reply ended meanwhile — never the ones in between. */
  async #flush(): Promise<void> {
    const texts = this.#waiting.splice(0);
    const newest = [...texts].reverse().find((text) => text !== "");
    const cleared = texts.at(-1) === "";
    if (newest !== undefined && newest !== this.#lastSent) {
      // Decided once, when the run's first words appear: by the time its last ones arrive the run may be settled already.
      this.#owner ??= { value: await this.#deps.forOwner().catch(() => null) };
      // An event or routine run writes bookkeeping that is never sent to the owner: not shown either.
      if (this.#owner.value !== null) {
        this.#lastSent = newest;
        this.#deps.send(JSON.stringify({ t: "stream", text: newest, threadId: this.#owner.value.threadId }));
      }
    }
    if (cleared) {
      this.#owner = undefined;
      if (this.#lastSent !== "") {
        this.#lastSent = "";
        this.#deps.send(JSON.stringify({ t: "stream", text: "", threadId: null }));
      }
    }
  }
}
