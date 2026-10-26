// The web pages over real data (issue #22): the done-report card carries a 查看详情 one-time
// link that lands in the workspace with that Thread selected (ADR-0004; the timeline is in
// the workspace snapshot, `views.workspace`); the machine page lists devices with live online state; its revoke button bumps the device
// epoch and closes the live connector connection with 4403 (protocol §5.1); /加机器 in chat
// issues the pairing code and answers with the npx connect command, redeemable exactly once.
import { CloseCode } from "@alexlikevibe/protocol";
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShOutboundRow, Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  connect,
  messageEvent,
  nextClose,
  ownerDm,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  // The /加机器 test redeems a real code through POST /pair; the brute-force lockout's
  // GLOBAL failure bucket (issue #27) survives resetLedgerState and other test files
  // deliberately fill it — clear it so this file's redemption cannot be rate-limited.
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: (s: TemplateStringsArray) => void }).sql.bind(instance);
    sql`DELETE FROM pair_fail`;
  });
});

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(20);
  return rows.filter((r) => r.kind === "text" && r.status === "sent").map((r) => JSON.parse(r.payload as string).text as string);
}

async function sentCards(): Promise<ShOutboundRow[]> {
  const rows = await ownerStub().outboundRows(30);
  return rows.filter((r) => r.kind === "card" && r.status === "sent");
}

async function waitForWorkerIdle(timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    const thread = snap.threads[0];
    if (thread && thread.workers[0]?.state === "idle") return thread.threadId;
    if (Date.now() > deadline) throw new Error(`worker never settled: ${JSON.stringify(snap.threads)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("report cards carry the one-time 查看详情 link", () => {
  it("a done card links to the Thread timeline, and the link opens it after login", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "登录 bug 修好，测试通过", changes: ["auth/session.ts 补上过期刷新"], branch: "sig/login-1" },
    });
    await fake.connect();
    // The steward LLM owns natural language now (issue #6); the deterministic dispatch path
    // its start_worker tool drives is entered directly here — same Thread, timeline, and card.
    await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
    await waitForWorkerIdle();
    await waitWhileOutboundPending();

    const [card] = await sentCards();
    expect(card).toBeDefined();
    const cardJson = JSON.parse(card!.payload as string) as { card: { text: string; buttons: Array<{ label?: string }> } };
    expect(cardJson.card.buttons.some((b) => b.label === "查看详情")).toBe(true);
    const linkUrl = cardJson.card.text.match(/https:\/\/example\.com\/link\/\S+/)![0]!;
    expect(linkUrl).toMatch(/^https:\/\/example\.com\/link\/wl1\.t\/t_\w+\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);

    // Opening the link logs in and lands directly on that Thread.
    const open = await SELF.fetch(linkUrl, { redirect: "manual" });
    expect(open.status).toBe(303);
    const threadId = await ownerStub().debugSnapshot().then((s) => s.threads[0]!.threadId);
    expect(open.headers.get("location")).toBe(`/app/threads/${threadId}`);
    const cookie = open.headers.get("set-cookie")!.split(";")[0]!;

    const page = await SELF.fetch(`https://example.com${open.headers.get("location")!}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="workspace"'); // the workspace shell; the page selects the Thread from the URL

    // The Thread's timeline, worker and branch are what the workspace snapshot hands the page.
    const workspace = (await (await SELF.fetch("https://example.com/app/api/workspace", { headers: { cookie } })).json()) as {
      threads: Array<{ id: string; title: string; workers: Array<{ machine: string; branch: string | null }>; timeline: Array<{ kind: string; text: string }> }>;
    };
    const thread = workspace.threads.find((entry) => entry.id === threadId)!;
    expect(thread.title).toBe("修复登录 bug");
    expect(thread.timeline.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["user_instruction", "dispatch", "report"]));
    expect(thread.timeline.map((entry) => entry.text).join("\n")).toContain("登录 bug 修好，测试通过");
    expect(thread.workers[0]).toMatchObject({ machine: "mac-studio" });
    expect(thread.workers[0]!.branch).toContain("sig/login");
  });

  it("in the workspace a finished report is an ordinary message, not a card; a PR ask stays a card", async () => {
    const answer = "## 结论\n\n1. 先装依赖\n2. 再启动\n\n```sh\npnpm i\n\npnpm dev\n```";
    for (const [pushed, kind] of [[true, "text"], [false, "card"]] as const) {
      await resetLedgerState();
      await configureAndBind("ou_owner");
      const fake = await pairFakeConnector("mac-studio", { run: { status: "done", summary: "调研完成", answer, branch: "sig/research-1", pushed } });
      await fake.connect();
      await ownerStub().dispatchForTest({ prompt: "调研一下", repoRef: "repo-a", newTitle: "调研" });
      await waitForWorkerIdle();
      await waitWhileOutboundPending();

      const [row] = await sentCards();
      const cookie = await webLogin();
      const { messages } = (await (await SELF.fetch("https://example.com/app/api/workspace", { headers: { cookie } })).json()) as {
        messages: Array<{ id: string; text?: string; card?: { kind: string; body: string[] } }>;
      };
      const message = messages.find((entry) => entry.id === row!.id)!;
      if (kind === "text") {
        expect(message.card).toBeUndefined();
        expect(message.text).toContain(answer);
        expect(message.text).not.toContain("/link/wl1.");
      } else {
        expect(message.card).toMatchObject({ kind: "consent" });
        expect(message.card!.body).toHaveLength(1);
        expect(message.card!.body[0]).toContain(answer);
      }
      fake.close();
    }
  });

  it("a failure card links to the timeline too", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "needs_decision", summary: "卡住了", question: "要不要删库？" },
    });
    await fake.connect();
    await ownerStub().dispatchForTest({ prompt: "干件大事", repoRef: "repo-a", newTitle: "干件大事" });
    await waitForWorkerIdle();
    // §5.3 (issue #10): the needs_decision question is held for the window — expire it so
    // the deterministic fallback card (the one carrying the link) goes out.
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const [card] = await sentCards();
    const msg = JSON.parse(card!.payload as string) as { card: { text: string; buttons: Array<{ label?: string }> } };
    expect(msg.card.buttons.some((b) => b.label === "查看详情")).toBe(true);
    expect(msg.card.text).toMatch(/\/link\/wl1\.t\/t_\w+\./);
  });
});

describe("/加机器: chat-issued pairing (protocol §5.2)", () => {
  it("replies with npx @alexlikevibe/sig connect <url> <code>, single-use", async () => {
    await ownerDm("/加机器");
    const text = (await sentTexts()).join("\n");
    const match = text.match(/npx @alexlikevibe\/sig connect (\S+) (\w{8})/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("https://example.com"); // origin learned from the webhook hit

    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: match![2], name: "mac-mini" }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^st1\./);

    // Single use: the second redemption of the same code fails.
    const again = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: match![2], name: "evil" }),
    });
    expect(again.status).toBe(400);
  });
});

describe("the machines dialog: online state and revocation (protocol §5.1)", () => {
  it("lists machines with live state in the snapshot, and revoke (the workspace API) bumps the epoch and closes with 4403", async () => {
    const cookie = await webLogin();
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const closed = nextClose(fake.ws!);

    const snap = await (await SELF.fetch("https://example.com/app/api/workspace", { headers: { cookie } })).json() as {
      csrf: string;
      machines: Array<{ id: string; name: string; online: boolean; revoked?: boolean; agents: string[] }>;
    };
    const machine = snap.machines.find((m) => m.id === fake.deviceId);
    expect(machine).toMatchObject({ name: "mac-studio", online: true, agents: ["pi"] }); // hello's kinds, not [object Object]

    // The mutation needs the session's csrf token in the header (workspace-api.ts).
    const csrf = snap.csrf as string;
    const deviceId = fake.deviceId;
    const res = await SELF.fetch("https://example.com/app/api/machines/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, origin: "https://example.com" },
      body: JSON.stringify({ deviceId }),
    });
    expect(res.status).toBe(200);

    // The live connection closes with 4403 (CloseCode.REVOKED).
    expect((await closed).code).toBe(CloseCode.REVOKED);

    // A reconnect with the old token is rejected with 4403: the epoch moved.
    const retry = await connect(fake.token);
    const ws = retry.webSocket!;
    ws.accept();
    expect((await nextClose(ws)).code).toBe(CloseCode.REVOKED);

    // The snapshot shows the machine as revoked and offline.
    const snap2 = await (await SELF.fetch("https://example.com/app/api/workspace", { headers: { cookie } })).json() as typeof snap;
    expect(snap2.machines.find((m) => m.id === deviceId)).toMatchObject({ online: false, revoked: true });

    // The audit trail records who/what.
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "web_machine_revoked" && l.detail === deviceId)).toBe(true);
  });

  it("rejects the revoke without a matching csrf token", async () => {
    const cookie = await webLogin();
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const res = await SELF.fetch("https://example.com/app/api/machines/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": "0".repeat(64), origin: "https://example.com" },
      body: JSON.stringify({ deviceId: fake.deviceId }),
    });
    expect(res.status).toBe(403);
    // Machine untouched: still listed online.
    const snap = await ownerStub().debugSnapshot();
    expect(snap.machines.find((m) => m.deviceId === fake.deviceId)?.online).toBe(true);
  });
});
