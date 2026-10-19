// Live replies (workspace-stream.ts) on synthetic pi events: how a message in flight turns into
// the words a workspace shows, and when the subscription is held. The wiring through a real
// Durable Object is covered in web-workspace.test.ts; here the events are written by hand so
// the shapes pi actually sends (and the awkward ones) are pinned down.
import type { AgentEvent, AgentEventStream } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { LiveReply, WorkspaceStream, type WorkspaceStreamDeps } from "../src/workspace-stream.ts";

const text = (value: string) => ({ type: "text", text: value });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const start = (...content: unknown[]): AgentEvent => ({ type: "message_start", message: assistant(...content) }) as unknown as AgentEvent;
const update = (...changes: unknown[]): AgentEvent => ({ type: "message_update", usage: {}, changes }) as unknown as AgentEvent;
const end = (message: unknown): AgentEvent => ({ type: "message_end", entry: { model: [message] } }) as unknown as AgentEvent;
const event = (type: string, extra: object = {}): AgentEvent => ({ type, ...extra }) as unknown as AgentEvent;
const delta = (contentIndex: number, value: string) => ({ type: "text_delta", contentIndex, delta: value });

describe("LiveReply", () => {
  it("builds the reply from deltas, reporting each text it passes through", () => {
    const reply = new LiveReply();
    expect(reply.apply([start()])).toEqual([]); // an empty message has nothing to show yet
    expect(reply.apply([update({ type: "text_start", contentIndex: 0, block: text("") }), update(delta(0, "Hel"))])).toEqual(["Hel"]);
    expect(reply.apply([update(delta(0, "lo"), delta(0, " there"))])).toEqual(["Hello there"]);
    expect(reply.text).toBe("Hello there");
  });

  it("shows only text: thinking and tool calls are not the reply", () => {
    const reply = new LiveReply();
    reply.apply([start()]);
    expect(reply.apply([
      update({ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } }, { type: "thinking_delta", contentIndex: 0, delta: "hmm" }),
      update({ type: "toolcall_start", contentIndex: 1, block: { type: "toolCall" } }, { type: "toolcall_delta", contentIndex: 1, path: [], delta: "{}" }),
    ])).toEqual([]);
    expect(reply.apply([update({ type: "text_start", contentIndex: 2, block: text("") }, delta(2, "Done."))])).toEqual(["Done."]);
  });

  it("lets a finished block replace what was accumulated for it, and joins blocks in order", () => {
    const reply = new LiveReply();
    reply.apply([start(), update({ type: "text_start", contentIndex: 1, block: text("") }, delta(1, "second"), { type: "text_start", contentIndex: 0, block: text("") }, delta(0, "first "))]);
    expect(reply.text).toBe("first second");
    reply.apply([update({ type: "block", contentIndex: 1, block: text("SECOND") })]);
    expect(reply.text).toBe("first SECOND");
  });

  it("takes the finished message as the whole truth, and keeps the words until the next message or the end of the run", () => {
    const reply = new LiveReply();
    reply.apply([start(), update({ type: "text_start", contentIndex: 0, block: text("") }, delta(0, "Almost"))]);
    expect(reply.apply([end(assistant(text("Almost there, fully.")))])).toEqual(["Almost there, fully."]);
    expect(reply.apply([update(delta(0, " ignored: no message is being written"))])).toEqual([]);
    expect(reply.apply([event("turn_end")])).toEqual([]); // still on screen
    expect(reply.apply([start(text("Next message"))])).toEqual(["Next message"]);
    expect(reply.apply([event("run_end")])).toEqual([""]);
  });

  it("reports the last words and the end of the run when one batch carries both", () => {
    const reply = new LiveReply();
    reply.apply([start(), update({ type: "text_start", contentIndex: 0, block: text("") }, delta(0, "So far"))]);
    expect(reply.apply([end(assistant(text("So far, and the rest."))), event("turn_end"), event("run_end")])).toEqual(["So far, and the rest.", ""]);
  });

  it("ignores messages that are not the assistant's, and starts from what is in flight on attachment", () => {
    const reply = new LiveReply();
    expect(reply.apply([event("message_start", { message: { role: "user", content: "hi" } }), event("message_start", { message: { role: "toolResult", content: [] } })])).toEqual([]);
    expect(reply.apply([event("snapshot", { generation: { attempt: 1, message: assistant(text("Midway through")) } })])).toEqual(["Midway through"]);
    expect(reply.apply([event("snapshot")])).toEqual([""]); // an overflow replaced everything and nothing is in flight
  });
});

/** A hand-driven pi event stream. */
function fakeStream() {
  let listener: ((events: readonly AgentEvent[]) => Promise<void>) | undefined;
  let stopped = 0;
  const stream = {
    snapshot: event("snapshot"),
    start: (next: typeof listener) => { listener = next; },
    stop: async () => { stopped += 1; return { kind: "stopped" }; },
    closed: new Promise(() => undefined),
  } as unknown as AgentEventStream;
  return { stream, push: (...events: AgentEvent[]) => listener!(events), get stopped() { return stopped; }, get started() { return listener !== undefined; } };
}

const pause = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(over: Partial<WorkspaceStreamDeps> = {}) {
  const fake = fakeStream();
  const frames: Array<{ t: string; text: string; threadId: string | null }> = [];
  const log: string[] = [];
  let opened = 0;
  let audience = 1;
  let runEnds = 0;
  const deps: WorkspaceStreamDeps = {
    open: async () => { opened += 1; return fake.stream; },
    audience: () => audience,
    forOwner: async () => ({ threadId: "t_1" }),
    onRunEnd: () => { runEnds += 1; },
    send: (frame) => frames.push(JSON.parse(frame)),
    log: (reason, detail) => log.push(`${reason}: ${detail}`),
    ...over,
  };
  return {
    fake, frames, log, stream: new WorkspaceStream(deps),
    setAudience: (n: number) => { audience = n; },
    get opened() { return opened; },
    get runEnds() { return runEnds; },
  };
}

describe("WorkspaceStream", () => {
  it("holds one subscription while someone watches, and none when nobody does", async () => {
    const quiet = harness();
    quiet.setAudience(0);
    quiet.stream.ensure();
    await pause(30);
    expect(quiet.opened).toBe(0);

    const watched = harness();
    watched.stream.ensure();
    watched.stream.ensure(); // concurrent callers share the attach in progress
    await pause(30);
    watched.stream.ensure();
    expect(watched.opened).toBe(1);
    expect(watched.fake.started).toBe(true);

    await watched.stream.stop();
    expect(watched.fake.stopped).toBe(1);
    watched.stream.ensure(); // the next watcher gets a fresh subscription
    await pause(30);
    expect(watched.opened).toBe(2);
  });

  it("lets go straight away when the last watcher left while it was attaching", async () => {
    const gone = harness();
    gone.stream.ensure();
    gone.setAudience(0);
    await pause(30);
    expect(gone.fake.stopped).toBe(1);
    expect(gone.fake.started).toBe(false);
  });

  it("sends the newest words a few times a second, then the last words and the clear when the run ends", async () => {
    const h = harness();
    h.stream.ensure();
    await pause(30);
    await h.fake.push(start(), update({ type: "text_start", contentIndex: 0, block: text("") }, delta(0, "One")));
    await h.fake.push(update(delta(0, " two")));
    await h.fake.push(update(delta(0, " three")));
    await pause();
    expect(h.frames).toEqual([{ t: "stream", text: "One two three", threadId: "t_1" }]); // one frame for the burst

    await h.fake.push(update(delta(0, " four")));
    await h.fake.push(end(assistant(text("One two three four, five."))), event("turn_end"), event("run_end"));
    await pause();
    expect(h.frames.slice(1)).toEqual([
      { t: "stream", text: "One two three four, five.", threadId: "t_1" },
      { t: "stream", text: "", threadId: null },
    ]);
    expect(h.runEnds).toBe(1); // the run is settled at once, not at the next poll
  });

  it("shows nothing of a run whose words are never sent to the owner", async () => {
    const h = harness({ forOwner: async () => null });
    h.stream.ensure();
    await pause(30);
    await h.fake.push(start(text("Bookkeeping the owner never receives")));
    await h.fake.push(event("run_end"));
    await pause();
    expect(h.frames).toEqual([]);
    expect(h.runEnds).toBe(1);
  });

  it("decides who a run is for when its first words appear, not when its last ones do", async () => {
    let calls = 0;
    const h = harness({ forOwner: async () => (++calls === 1 ? { threadId: "t_9" } : null) }); // the run is already settled by then
    h.stream.ensure();
    await pause(30);
    await h.fake.push(start(text("First words")));
    await pause();
    await h.fake.push(end(assistant(text("First words, last words."))), event("run_end"));
    await pause();
    expect(h.frames.map((frame) => frame.text)).toEqual(["First words", "First words, last words.", ""]);
    expect(calls).toBe(1);
    await h.fake.push(start(text("Another run")));
    await pause();
    expect(calls).toBe(2); // a new run is asked again
  });

  it("records an attach failure and tries again on the next call", async () => {
    let attempts = 0;
    const fake = fakeStream();
    const h = harness({ open: async () => { if (++attempts === 1) throw new Error("storage busy"); return fake.stream; } });
    h.stream.ensure();
    await pause(30);
    expect(h.log).toEqual(["workspace_stream_failed: storage busy"]);
    h.stream.ensure();
    await pause(30);
    expect(attempts).toBe(2);
    expect(fake.started).toBe(true);
  });
});
