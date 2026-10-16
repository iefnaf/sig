// The web pages over real data (issue #22): the done-report card carries a 查看详情 one-time
// link that lands on the Thread timeline (`views.timeline`, mobile viewport, no JS); the
// machine page lists devices with live online state; its revoke button bumps the device
// epoch and closes the live connector connection with 4403 (protocol §5.1); /加机器 in chat
// issues the pairing code and answers with the npx connect command, redeemable exactly once.
import { CloseCode } from "@shepherd/protocol";
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShOutboundRow, Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  connect,
  messageEvent,
  mockReset,
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
  await mockReset();
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
      run: { status: "done", summary: "登录 bug 修好，测试通过", changes: ["auth/session.ts 补上过期刷新"], branch: "shepherd/login-1" },
    });
    await fake.connect();
    // The steward LLM owns natural language now (issue #6); the deterministic dispatch path
    // its start_worker tool drives is entered directly here — same Thread, timeline, and card.
    await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
    await waitForWorkerIdle();
    await waitWhileOutboundPending();

    const [card] = await sentCards();
    expect(card).toBeDefined();
    const cardJson = JSON.parse(card!.payload as string) as { card: { elements: unknown[] } };
    const action = JSON.stringify(cardJson.card.elements);
    expect(action).toContain("查看详情");
    const linkUrl = action.match(/https:\/\/example\.com\/link\/(\S+?)"/)![0]!.replace(/"$/, "");
    expect(linkUrl).toMatch(/^https:\/\/example\.com\/link\/wl1\.t\/t_\w+\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);

    // Opening the link logs in and lands directly on that Thread's timeline.
    const open = await SELF.fetch(linkUrl, { redirect: "manual" });
    expect(open.status).toBe(303);
    const threadId = await ownerStub().debugSnapshot().then((s) => s.threads[0]!.threadId);
    expect(open.headers.get("location")).toBe(`/app/threads/${threadId}`);
    const cookie = open.headers.get("set-cookie")!.split(";")[0]!;

    const page = await SELF.fetch(`https://example.com${open.headers.get("location")!}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("修复登录 bug");
    expect(html).toContain("指令");
    expect(html).toContain("派发");
    expect(html).toContain("汇报");
    expect(html).toContain("登录 bug 修好，测试通过");
    expect(html).toContain("mac-studio");
    expect(html).toContain("shepherd/login");
    expect(html).not.toContain("●"); // §6.5: opening the timeline cleared unread
  });

  it("a failure card links to the timeline too", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "needs_decision", summary: "卡住了", question: "要不要删库？" },
    });
    await fake.connect();
    await ownerStub().dispatchForTest({ prompt: "干件大事", repoRef: "repo-a", newTitle: "干件大事" });
    await waitForWorkerIdle();
    await waitWhileOutboundPending();
    const [card] = await sentCards();
    const action = JSON.stringify(JSON.parse(card!.payload as string).card.elements);
    expect(action).toContain("查看详情");
    expect(action).toMatch(/\/link\/wl1\.t\/t_\w+\./);
  });
});

describe("/加机器: chat-issued pairing (protocol §5.2)", () => {
  it("replies with npx @iefnaf/shepherd connect <url> <code>, single-use", async () => {
    await ownerDm("/加机器");
    const text = (await sentTexts()).join("\n");
    const match = text.match(/npx @iefnaf\/shepherd connect (\S+) (\w{8})/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("https://example.com"); // origin learned from the webhook hit

    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code: match![2], name: "mac-mini" }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^st1\./);

    // Single use: the second redemption of the same code fails.
    const again = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code: match![2], name: "evil" }),
    });
    expect(again.status).toBe(400);
  });
});

describe("the machine page: online state and revocation (protocol §5.1)", () => {
  it("lists machines with online state, and revoke bumps the epoch and closes with 4403", async () => {
    const cookie = await webLogin();
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const closed = nextClose(fake.ws!);

    const page = await SELF.fetch("https://example.com/app/machines", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("mac-studio");
    expect(html).toContain("在线");
    expect(html).toContain("pi"); // the agent kinds from hello, not [object Object]
    expect(html).toContain("撤销");
    expect(html).toContain("/加机器");

    // The revoke form carries the per-session csrf token.
    const csrf = html.match(/name="csrf" value="([0-9a-f]{64})"/)![1]!;
    const deviceId = fake.deviceId;    const res = await SELF.fetch("https://example.com/app/machines/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, deviceId }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app/machines");

    // The live connection closes with 4403 (CloseCode.REVOKED).
    expect((await closed).code).toBe(CloseCode.REVOKED);

    // A reconnect with the old token is rejected with 4403: the epoch moved.
    const retry = await connect(fake.token);
    const ws = retry.webSocket!;
    ws.accept();
    expect((await nextClose(ws)).code).toBe(CloseCode.REVOKED);

    // The page shows the machine as revoked, offline, with no second revoke button.
    const page2 = await SELF.fetch("https://example.com/app/machines", { headers: { cookie } });
    const html2 = await page2.text();
    expect(html2).toContain("已撤销");
    expect(html2).not.toContain("离线"); // revoked replaces the online/offline line

    // The audit trail records who/what.
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "web_machine_revoked" && l.detail === deviceId)).toBe(true);
  });

  it("rejects the revoke POST without a matching csrf token", async () => {
    const cookie = await webLogin();
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const res = await SELF.fetch("https://example.com/app/machines/revoke", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "0".repeat(32), deviceId: fake.deviceId }),
    });
    expect(res.status).toBe(403);
    // Machine untouched: still listed online.
    const snap = await ownerStub().debugSnapshot();
    expect(snap.machines.find((m) => m.deviceId === fake.deviceId)?.online).toBe(true);
  });
});
