// The L3 page itself (issue #23, spec §7.4): the timeline links each worker to its raw
// process; the page is server-rendered (header, machine state) plus the little vanilla JS
// that streams chunks over a web-role WebSocket; an offline machine shows why the transcript
// is unavailable instead of a stream (connector-pi.md §11.4).
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeConnector,
  configureAndBind,
  mockReset,
  ownerDm,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

async function dispatchOneWorker(fake: FakeConnector): Promise<{ threadId: string; workerId: string }> {
  await ownerDm("/派发 repo-a 修复登录 bug");
  return waitForWorkerState("idle");
}

async function page(path: string, cookie: string): Promise<{ status: number; html: string }> {
  const res = await SELF.fetch(`https://example.com${path}`, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
}

describe("the timeline links to the raw process", () => {
  it("each worker row carries a 原始过程 link to /app/threads/:t/workers/:w", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const timeline = await page(`/app/threads/${threadId}`, cookie);
    expect(timeline.status).toBe(200);
    expect(timeline.html).toContain(`href="/app/threads/${threadId}/workers/${workerId}"`);
    expect(timeline.html).toContain("原始过程");
  });
});

describe("the raw process page", () => {
  it("renders the worker header and the streaming script while the machine is online", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { status, html } = await page(`/app/threads/${threadId}/workers/${workerId}`, cookie);
    expect(status).toBe(200);
    expect(html).toContain("原始过程");
    expect(html).toContain("mac-studio");
    expect(html).toContain(`会话 ${workerId}`);
    expect(html).toContain("history_open"); // the vanilla stream client
    expect(html).toContain("?role=web");
    expect(html).toContain("history_ack");
    // The thread link back out.
    expect(html).toContain(`href="/app/threads/${threadId}"`);
    expect(html).toContain("←");
  });

  it("shows the machine_offline explanation while the machine is not connected", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    fake.close(); // offline before the page is opened

    const cookie = await webLogin();
    const { status, html } = await page(`/app/threads/${threadId}/workers/${workerId}`, cookie);
    expect(status).toBe(200);
    expect(html).toContain("machine_offline");
    expect(html).toContain("机器当前不在线");
    expect(html).not.toContain("history_open"); // no stream to start
  });

  it("404s for an unknown worker or a worker that belongs to another thread", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    expect((await page(`/app/threads/${threadId}/workers/w-ghost`, cookie)).status).toBe(404);
    expect((await page(`/app/threads/t_other/workers/${workerId}`, cookie)).status).toBe(404);
  });

  it("requires the login session", async () => {
    const res = await SELF.fetch("https://example.com/app/threads/t_x/workers/w_y");
    expect(res.status).toBe(401);
  });
});
