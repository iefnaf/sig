// The L3 raw process (issue #23, spec §7.4): the snapshot names each worker's link
// (/app/threads/:t/workers/:w); since ADR-0004 that URL opens the workspace whose session
// viewer streams the transcript over the browser socket — an offline machine is the viewer's
// state, not a different server-rendered page (connector-pi.md §11.4).
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeConnector,
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function dispatchOneWorker(fake: FakeConnector): Promise<{ threadId: string; workerId: string }> {
  // Post-#6 the owner's natural language goes through the steward LLM; its start_worker tool
  // drives the deterministic dispatch path, entered directly here (same as web-pages tests).
  await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
  return waitForWorkerState("idle");
}

async function page(path: string, cookie: string): Promise<{ status: number; html: string }> {
  const res = await SELF.fetch(`https://example.com${path}`, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
}

describe("the workspace links to the raw process", () => {
  it("each worker in the snapshot names the ids the page links /app/threads/:t/workers/:w with", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const snapshot = await page("/app/api/workspace", cookie);
    expect(snapshot.status).toBe(200);
    const { threads } = JSON.parse(snapshot.html) as { threads: Array<{ id: string; workers: Array<{ id: string; sessionId: string | null }> }> };
    expect(threads.find((thread) => thread.id === threadId)!.workers).toEqual([expect.objectContaining({ id: workerId, sessionId: workerId })]);
    // …and that link opens the read-only raw process page.
    expect((await page(`/app/threads/${threadId}/workers/${workerId}`, cookie)).status).toBe(200);
  });
});

describe("the raw process page", () => {
  // ADR-0005 decision 4: the separate page is gone; the URL opens the workspace whose
  // session viewer streams the transcript over /app/ws (the relay itself has its own suite
  // in history-relay.test.ts; the viewer's client model in ui-session.test.ts).
  it("opens the workspace shell, online or offline — the viewer decides availability", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { threadId, workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const online = await page(`/app/threads/${threadId}/workers/${workerId}`, cookie);
    expect(online.status).toBe(200);
    expect(online.html).toContain('id="workspace"');

    fake.close(); // offline before the page is opened
    const offline = await page(`/app/threads/${threadId}/workers/${workerId}`, cookie);
    expect(offline.status).toBe(200);
    expect(offline.html).toContain('id="workspace"'); // the shell serves either way; the viewer shows why a stream cannot start
  });

  it("requires the login session", async () => {
    const res = await SELF.fetch("https://example.com/app/threads/t_x/workers/w_y");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="password-form"');
  });
});
