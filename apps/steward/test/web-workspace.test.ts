// The web workspace's server side (ADR-0004, spec §7.3): the snapshot the page draws, owner
// messages and card taps arriving over the signed session, replies that stay on the web, the
// live nudge, and the static files. Everything runs the production path — real Worker, real
// Durable Object, the scripted model — with the browser played by plain fetch.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Steward } from "../src/steward.ts";
import {
  MessageReader,
  configureAndBind,
  llmState,
  messageEvent,
  modelRequests,
  ownerDm,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  streamRepliesAt,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

const BASE = "https://example.com";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

interface Card {
  id: string;
  kind: string;
  threadId: string | null;
  questionId: string | null;
  title: string;
  buttons: Array<{ label: string; action?: string; url?: string }>;
}
interface Workspace {
  csrf: string;
  now: number;
  busy: boolean;
  threads: Array<{ id: string; title: string; unread: boolean; state: string; machine: string | null; workers: Array<{ id: string; agent: string; machine: string }>; timeline: Array<{ kind: string; text: string }> }>;
  machines: Array<{ id: string; name: string; online: boolean; agents: string[]; repos: string[]; slots: { running: number; max: number } | null }>;
  messages: Array<{ id: string; role: string; channel: string; threadId: string | null; text?: string; card?: Card; open?: boolean }>;
  attention: Card[];
  budget: { costUsd: number; limitUsd: number; over: boolean };
}

/** A signed-in browser: the cookie, the snapshot reader, and a mutation poster that carries the CSRF token. */
async function browser() {
  const cookie = await webLogin();
  const get = async (): Promise<Workspace> => (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json();
  const { csrf } = await get();
  const post = (path: string, body: unknown, init: { csrf?: string; headers?: Record<string, string>; raw?: string } = {}) =>
    SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": init.csrf ?? csrf, ...init.headers },
      body: init.raw ?? JSON.stringify(body),
    });
  return { cookie, csrf, get, post };
}

/** One machine online with a repo, and one Thread dispatched onto it. */
async function oneThread(title = "Fix the login redirect loop") {
  const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
  await fake.connect();
  await ownerStub().dispatchForTest({ prompt: "fix it", repoRef: "repo-a", newTitle: title });
  const [cmd] = await fake.waitForCmds(1);
  const threadId = String((cmd!.args as Record<string, unknown>).threadId);
  return { fake, threadId };
}

describe("the snapshot", () => {
  it("is empty but well-formed for a fresh deployment, and never cacheable", async () => {
    const { cookie } = await browser();
    const response = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const workspace = (await response.json()) as Workspace;
    expect(workspace).toMatchObject({ threads: [], machines: [], attention: [], busy: false });
    expect(workspace.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(workspace.budget).toMatchObject({ costUsd: 0, over: false });
    expect(Math.abs(workspace.now - Date.now())).toBeLessThan(60_000);
  });

  it("describes threads, workers, machines and slots for the sidebar and the details panel", async () => {
    const { fake, threadId } = await oneThread();
    const { get } = await browser();
    const workspace = await get();
    expect(workspace.threads).toHaveLength(1);
    expect(workspace.threads[0]).toMatchObject({ id: threadId, title: "Fix the login redirect loop", machine: "mac-studio" });
    expect(workspace.threads[0]!.workers[0]).toMatchObject({ agent: "pi", machine: "mac-studio" });
    expect(workspace.threads[0]!.timeline.map((entry) => entry.kind)).toContain("dispatch");
    expect(workspace.machines).toEqual([
      expect.objectContaining({ name: "mac-studio", online: true, agents: ["pi"], repos: ["repo-a"], slots: expect.objectContaining({ running: 1 }) }),
    ]);
    fake.close();
  });

  it("shows what the owner said as they said it, and keeps credentials out", async () => {
    await scriptModel(fauxAssistantMessage([fauxText("Hello from the local channel.")]));
    await postEvent(messageEvent({ msgId: "om_visible_1", text: "Plain <b>words</b> over the API" }));
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const { get } = await browser();
    const workspace = await get();
    const mine = workspace.messages.filter((message) => message.role === "user");
    expect(mine).toEqual([expect.objectContaining({ channel: "local", text: "Plain <b>words</b> over the API" })]);
    expect(workspace.messages).toContainEqual(expect.objectContaining({ role: "assistant", channel: "local", text: "Hello from the local channel." }));
    // The API's own login-link mint is a credential: delivered to the owner, never listed
    // in the conversation (the outbound payload's private flag).
    const everything = JSON.stringify(workspace);
    expect(everything).not.toContain("/link/");
  });
});

describe("owner messages", () => {
  it("are persisted once, keep their words, and are answered in the same conversation", async () => {
    const { get, post, csrf } = await browser();
    await scriptModel(fauxAssistantMessage([fauxText("Ready when you are.")]));
    const text = "Hello <script> · ⟦user text⟧";
    expect((await post("messages", { id: "message-001", text }, { csrf: "wrong" })).status).toBe(403);
    const responses = await Promise.all([post("messages", { id: "message-001", text }), post("messages", { id: "message-001", text })]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    await waitRunsSettled();
    expect((await modelRequests()).length).toBe(1);
    expect((await llmState()).runs).toHaveLength(1);
    expect((await post("messages", { id: "message-001", text: "changed content" })).status).toBe(409);
    const workspace = await get();
    expect(workspace.messages.filter((m) => m.role === "user" && m.text === text)).toEqual([expect.objectContaining({ id: "user:web:message-001", channel: "local" })]);
    expect(workspace.messages).toContainEqual(expect.objectContaining({ role: "assistant", channel: "local", text: "Ready when you are." }));
    expect((await ownerStub().outboundRows(100)).find((r) => r.id === "reply:user:web:message-001")).toMatchObject({ channel: "local", status: "sent" });
    expect(csrf).toHaveLength(64);
  });

  it("are refused unless the session, the token, the origin and the body all check out", async () => {
    const { cookie, csrf, post } = await browser();
    const url = `${BASE}/app/api/messages`;
    const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf };
    const body = JSON.stringify({ id: "message-bad-1", text: "hi" });

    expect((await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body })).status).toBe(401);
    expect((await SELF.fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body })).status).toBe(403);
    expect((await SELF.fetch(url, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body })).status).toBe(403);
    expect((await SELF.fetch(url, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body })).status).toBe(415);
    expect((await SELF.fetch(url, { method: "GET", headers: { cookie } })).status).toBe(404);

    for (const bad of [{}, { id: "short", text: "hi" }, { id: "message-bad-2", text: "   " }, { id: "message-bad-3", text: 7 }, { id: "message-bad-4", text: "x".repeat(16_001) }, { id: "message-bad-5", text: "hi", threadId: "no spaces allowed" }]) {
      expect((await post("messages", bad)).status).toBe(400);
    }
    expect((await post("messages", null, { raw: "{not json" })).status).toBe(400);
    expect((await post("messages", null, { raw: JSON.stringify({ id: "message-bad-6", text: "x".repeat(80_000) }) })).status).toBe(413);
    expect((await post("messages", { id: "message-bad-7", text: "hi", threadId: "t_missing" })).status).toBe(404);
    expect((await post("messages", { id: "message-bad-8", text: "hi", replyTo: "ask:999" })).status).toBe(404);
    expect((await llmState()).runs).toHaveLength(0); // nothing above reached the model
  });

  it("go to the Thread the owner picked, and the model is told so", async () => {
    const { fake, threadId } = await oneThread();
    const { get, post } = await browser();
    await scriptModel(fauxAssistantMessage([fauxText("Noted for that thread.")]));
    expect((await post("messages", { id: "routed-001", text: "Also check the cookie flags", threadId })).status).toBe(202);
    await waitRunsSettled();
    const run = (await llmState()).runs.find((r) => r.operationId === "user:web:routed-001");
    expect(run).toMatchObject({ kind: "user", routedThreadId: threadId });
    expect(run!.text).toContain(threadId);
    const workspace = await get();
    expect(workspace.messages.filter((m) => m.threadId === threadId).map((m) => m.text)).toEqual(["Also check the cookie flags", "Noted for that thread."]);
    fake.close();
  });

  it("answering a card routes like a quote-reply: its Thread, and its question is settled", async () => {
    const { fake, threadId } = await oneThread();
    const { get, post } = await browser();
    await scriptModel(fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which approach?", options: ["A", "B"], threadId })], { stopReason: "toolUse" }));
    expect((await post("messages", { id: "ask-first-1", text: "Fix it somehow" })).status).toBe(202);
    await waitRunsSettled();
    const [card] = (await get()).attention;
    expect(card).toMatchObject({ kind: "question", threadId });

    await scriptModel(fauxAssistantMessage([fauxText("Going with A then.")]));
    expect((await post("messages", { id: "answer-001", text: "A, but keep it small", replyTo: card!.id })).status).toBe(202);
    await waitRunsSettled();
    const answer = (await llmState()).runs.find((r) => r.operationId === "user:web:answer-001");
    expect(answer).toMatchObject({ routedThreadId: threadId });
    expect((await get()).attention).toEqual([]); // the question closed with the reply
    fake.close();
  });
});

describe("card taps", () => {
  it("answer a threadless question through its durable card and refuse forged or stale choices", async () => {
    const { get, post } = await browser();
    await scriptModel(fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which approach?", options: ["A", "B"] })], { stopReason: "toolUse" }));
    expect((await post("messages", { id: "question-001", text: "Help me choose." })).status).toBe(202);
    await waitRunsSettled();
    const [card] = (await get()).attention;
    expect(card?.buttons).toHaveLength(2);
    expect((await ownerStub().outboundRows(100)).find((r) => r.id === card!.id)).toMatchObject({ channel: "local" });
    expect((await post("actions", { id: "choice-forged", cardId: card!.id, action: "pr_approve" })).status).toBe(400);
    expect((await post("actions", { id: "choice-ghost1", cardId: "ask:424242", action: "ask:x:0" })).status).toBe(404);
    expect((await post("actions", { id: "choice-badbody", cardId: card!.id })).status).toBe(400);
    await scriptModel(fauxAssistantMessage([fauxText("A it is.")]));
    const choice = { id: "choice-001", cardId: card!.id, action: card!.buttons[0]!.action };
    expect((await post("actions", choice)).status).toBe(202);
    expect((await post("actions", choice)).status).toBe(202); // a retry of the same tap is the same tap
    await waitRunsSettled();
    const after = await get();
    expect(after.attention).toEqual([]);
    expect(after.messages.find((m) => m.id === card!.id)).toMatchObject({ open: false });
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.text)).toContain("A"); // the choice is part of the conversation
    expect((await post("actions", { ...choice, id: "choice-stale" })).status).toBe(409);
    const conflict = await post("actions", { ...choice, action: card!.buttons[1]!.action }); // the same request id may not mean another tap
    expect([conflict.status, ((await conflict.json()) as { error: string }).error]).toEqual([409, "id_conflict"]);
    expect((await llmState()).runs).toHaveLength(2);
    expect((await ownerStub().outboundRows(100)).find((r) => r.id === "reply:user:web:choice-001")).toMatchObject({ channel: "local" });
  });
});

describe("the read endpoint and signing out", () => {
  it("marks a Thread read, and only an existing one", async () => {
    const { fake, threadId } = await oneThread();
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${threadId}`;
    });
    const { get, post } = await browser();
    expect((await get()).threads[0]!.unread).toBe(true);
    expect((await post(`threads/${threadId}/read`, {})).status).toBe(200);
    expect((await get()).threads[0]!.unread).toBe(false);
    expect((await post("threads/t_missing/read", {})).status).toBe(404);
    fake.close();
  });

  it("signing out ends the session for real, not just in the browser", async () => {
    const { cookie, post } = await browser();
    const response = await post("logout", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/sig_session=;.*Max-Age=0/);
    const after = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "auth_required" });
  });
});

describe("live updates", () => {
  /** The next frame satisfying `pred`; others are skipped (MessageReader.nextWhere only filters what is already queued). */
  async function frameWhere(reader: MessageReader, pred: (frame: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await reader.next(Math.max(1, deadline - Date.now()));
      if (pred(frame)) return frame;
    }
  }

  async function socket(cookie: string, view: string) {
    const res = await SELF.fetch(`${BASE}/agents/steward/owner?role=web${view}`, { headers: { Upgrade: "websocket", cookie } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    return { ws, reader: new MessageReader(ws) };
  }

  it("tell a workspace that something changed, once per burst, and leave the raw-process sockets alone", async () => {
    const { cookie, post } = await browser();
    const workspace = await socket(cookie, "&view=workspace");
    const plain = await socket(cookie, "");
    await scriptModel(fauxAssistantMessage([fauxText("Hi.")]));
    expect((await post("messages", { id: "live-0001", text: "hello" })).status).toBe(202);
    expect(await frameWhere(workspace.reader, (m) => m.t === "workspace_changed")).toEqual({ t: "workspace_changed" });
    await waitRunsSettled();
    await expect(frameWhere(plain.reader, (m) => m.t === "workspace_changed", 700)).rejects.toThrow(/timed out/);
    workspace.ws.close();
    plain.ws.close();
  });

  it("carry the reply as it is written, only for the owner's own conversation, and clear it when the run ends", async () => {
    const { cookie, post } = await browser();
    const workspace = await socket(cookie, "&view=workspace");
    const reply = "Here is a reply that is long enough to be written in more than one piece, so a live view can show it growing.";
    await streamRepliesAt(40); // word by word, roughly three seconds for the whole reply
    await scriptModel(fauxAssistantMessage([fauxText(reply)]));
    expect((await post("messages", { id: "stream-0001", text: "say something long" })).status).toBe(202);

    const seen: string[] = [];
    for (;;) {
      const frame = await frameWhere(workspace.reader, (m) => m.t === "stream", 12_000);
      seen.push(String(frame.text));
      if (frame.text === reply) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const text of seen) expect(reply.startsWith(text)).toBe(true); // growing prefixes, never something else
    expect(await frameWhere(workspace.reader, (m) => m.t === "stream" && m.text === "", 12_000)).toMatchObject({ threadId: null });
    await waitRunsSettled();
    workspace.ws.close();
  }, 30_000);

  it("show nothing live for work the owner never sees: an event run's bookkeeping stays off the wire", async () => {
    const { cookie } = await browser();
    const workspace = await socket(cookie, "&view=workspace");
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const dispatched = await ownerStub().dispatchForTest({ prompt: "fix it", repoRef: "repo-a", newTitle: "Fix it" });
    if (dispatched.kind !== "dispatched") throw new Error(JSON.stringify(dispatched));
    fake.send({ t: "cmd_ack", re: (await fake.waitForCmds(1))[0]!.id, status: "accepted" });
    await fake.emit("started", dispatched.workerId, { sessionId: dispatched.workerId, branch: "sig/x-1" });
    await scriptModel(fauxAssistantMessage([fauxText("Private bookkeeping the owner is never sent.")]));
    await fake.emit("report", dispatched.workerId, { type: "report", status: "done", summary: "Done", changes: [], tests: { ran: false } });
    await fake.emit("settled", dispatched.workerId, { type: "settled", outcome: "reported" });
    await waitRunsSettled();
    await expect(frameWhere(workspace.reader, (m) => m.t === "stream" && m.text !== "", 800)).rejects.toThrow(/timed out/);
    workspace.ws.close();
    fake.close();
  }, 30_000);

  it("need a valid session: a socket without the cookie is turned away", async () => {
    const res = await SELF.fetch(`${BASE}/agents/steward/owner?role=web&view=workspace`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });
});

describe("the page and its files", () => {
  it("authorizes pages in the Durable Object without serving assets from its pinned environment", async () => {
    const { cookie } = await browser();
    const response = await ownerStub().fetch(new Request(`${BASE}/app`, { headers: { cookie } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("x-sig-workspace-shell")).toBe("1");
    expect(await response.text()).toBe("");
    const denied = await ownerStub().fetch(new Request(`${BASE}/app`));
    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain('id="password-form"');
  });

  it("serve the workspace shell with a policy that forbids inline script and foreign origins", async () => {
    const { cookie } = await browser();
    const response = await SELF.fetch(`${BASE}/app`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = response.headers.get("content-security-policy")!;
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self' wss://example.com"]) {
      expect(policy).toContain(directive);
    }
    const html = await response.text();
    expect(html).toContain('<div class="workspace" id="workspace"');
    expect(html).toContain("/app/assets/workspace.js");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline script anywhere
  });

  it("open a Thread URL in the same shell, and 404 an unknown Thread", async () => {
    const { fake, threadId } = await oneThread();
    const { cookie } = await browser();
    const page = await SELF.fetch(`${BASE}/app/threads/${threadId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="workspace"');
    expect((await SELF.fetch(`${BASE}/app/threads/t_missing`, { headers: { cookie } })).status).toBe(404);
    fake.close();
  });

  it("serve static files only to a signed-in browser, and only plain file names", async () => {
    const { cookie } = await browser();
    const script = await SELF.fetch(`${BASE}/app/assets/workspace.js`, { headers: { cookie } });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("cache-control")).toContain("private");
    expect((await SELF.fetch(`${BASE}/app/assets/workspace.css`, { headers: { cookie } })).headers.get("content-type")).toContain("text/css");
    expect((await SELF.fetch(`${BASE}/app/assets/i18n.js`, { headers: { cookie } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/app/assets/workspace.js`)).status).toBe(401);
    for (const name of ["nope.js", "..%2Fpackage.json", ".hidden", "a/b.js", "%2e%2e/steward.ts"]) {
      expect((await SELF.fetch(`${BASE}/app/assets/${name}`, { headers: { cookie } })).status).toBe(404);
    }
    expect((await SELF.fetch(`${BASE}/app/assets/workspace.js`, { method: "POST", headers: { cookie } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the owner's own commands", () => {
  it("never put a login link or a pairing command into the conversation", async () => {
    await ownerDm("/加机器");
    const { get } = await browser();
    const workspace = await get();
    expect(JSON.stringify(workspace.messages)).not.toMatch(/connect|配对码|link\/wl1/);
  });
});
