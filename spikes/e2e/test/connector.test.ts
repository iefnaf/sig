// Connector contract tests against fake-pi (connector-pi.md §14): every adjudication
// branch, progress throttling, lost-on-crash, and the concurrency cap — deterministic,
// local, no tokens. The real connector runs as a child process against a mock steward.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockSteward } from "./mock-steward.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CONNECTOR = join(HERE, "..", "connector.mjs");
const FAKE_PI = join(HERE, "fake-pi.mjs");

const shell = (cmd, cwd) => new Promise((resolve, reject) => execFile("/bin/zsh", ["-c", cmd], { cwd }, (e, _out, err) => (e ? reject(new Error(`${cmd}: ${err || e.message}`)) : resolve())));

/** A fixture git repo with one commit, plus a fresh SHEPHERD_HOME. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "shepherd-conn-"));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const home = join(dir, "home");
	mkdirSync(home);
	return { dir, repo, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withRig(scenario, fn, opts = {}) {
	const f = fixture();
	await shell("git init -q && git config user.email t@t && git config user.name t && echo hello > README.md && git add -A && git commit -qm init", f.repo);
	const mock = startMockSteward();
	if (opts.swallow) mock.swallowAcks = true;
	if (opts.swallowFrames) mock.swallowAllFrames = true;
	const port = await mock.listen();
	const proc = execFile(
		process.execPath,
		[CONNECTOR, "--url", `http://127.0.0.1:${port}`, "--name", "test-box", "--repo", f.repo, "--code", "X"],
		{ env: { ...process.env, SHEPHERD_HOME: f.home, SHEPHERD_PI_BIN: `${process.execPath} ${FAKE_PI}`, FAKE_PI_SCENARIO: scenario, ...(opts.idleMs ? { SHEPHERD_IDLE_RECYCLE_MS: String(opts.idleMs) } : {}), ...(opts.stallMs ? { SHEPHERD_STALL_MS: String(opts.stallMs) } : {}), ...(opts.deadMs ? { SHEPHERD_DEAD_MS: String(opts.deadMs) } : {}), ...(opts.pingMs ? { SHEPHERD_PING_MS: String(opts.pingMs) } : {}) } },
	);
	try {
		await mock.waitConnected(10_000);
		await fn({ mock, f });
	} finally {
		proc.kill("SIGKILL");
		await mock.close();
		f.cleanup();
	}
}

const eventsOf = (mock, workerId, type) => mock.events().filter((e) => e.workerId === workerId && e.type === type);
const firstOf = (mock, workerId, type) => eventsOf(mock, workerId, type)[0];

function dispatchAndAwait(mock, workerId, endPred) {
	mock.startWorker({ workerId, threadId: "t_test", prompt: "do the thing" });
	return mock.waitFor(endPred, 30000);
}

test("happy: started -> progress -> report(done, git facts) -> settled(reported)", async () => {
	await withRig("happy", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_happy1", (x) => x.type === "settled");
		const w = e.workerId;
		assert.equal(e.outcome, "reported");
		const started = firstOf(mock, w, "started");
		assert.equal(started.sessionId, w);
		assert.equal(started.branch, "shepherd/w_happy1");
		const report = firstOf(mock, w, "report");
		assert.equal(report.status, "done");
		assert.equal(report.summary, "改好了");
		assert.deepEqual(report.changes, ["src/a.ts"]);
		assert.equal(report.tests.passed, true);
		assert.ok(report.git, "git facts merged");
		assert.match(report.git.branch, /^shepherd\//);
		assert.ok(eventsOf(mock, w, "progress").length >= 1);
	});
});

test("unreported: last assistant text passes through for the steward to classify", async () => {
	await withRig("unreported", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_unrep1", (x) => x.type === "settled");
		assert.equal(e.outcome, "unreported");
		assert.match(e.lastText ?? "", /完成/);
		assert.equal(eventsOf(mock, e.workerId, "report").length, 0);
	});
});

for (const [scenario, klass] of [["error_auth", "auth"], ["error_transient", "transient"], ["error_context", "context"]]) {
	test(`error adjudication: ${klass}`, async () => {
		await withRig(scenario, async ({ mock }) => {
			const e = await dispatchAndAwait(mock, `w_${klass}`, (x) => x.type === "settled");
			assert.equal(e.outcome, "error");
			assert.equal(e.errorClass, klass);
			assert.equal(eventsOf(mock, e.workerId, "report").length, 0, "no report event on error");
		});
	});
}

test("aborted run settles as aborted", async () => {
	await withRig("aborted", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_abort1", (x) => x.type === "settled");
		assert.equal(e.outcome, "aborted");
	});
});

test("crash mid-run emits lost, not settled", async () => {
	await withRig("crash", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_crash1", (x) => x.type === "lost");
		assert.match(e.reason, /^process_exit:/);
		assert.equal(eventsOf(mock, e.workerId, "settled").length, 0);
	});
});

test("progress throttling: same-tool bursts collapse", async () => {
	await withRig("throttle", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_thr1", (x) => x.type === "settled");
		const n = eventsOf(mock, e.workerId, "progress").length;
		assert.ok(n >= 1 && n <= 3, `expected 1-3 progress events, got ${n}`);
	});
});

test("concurrency cap: the third worker starts only after a settle", async () => {
	await withRig("slow", async ({ mock }) => {
		mock.startWorker({ workerId: "w_slow1", threadId: "t_test", prompt: "p1" });
		mock.startWorker({ workerId: "w_slow2", threadId: "t_test", prompt: "p2" });
		mock.startWorker({ workerId: "w_slow3", threadId: "t_test", prompt: "p3" });
		const firstSettle = await mock.waitFor((x) => x.type === "settled", 30000);
		// dedup by worker: resent-but-unacked events arrive more than once under load
		const startedBefore = new Set(mock.events().filter((x) => x.type === "started" && x.ts <= firstSettle.ts).map((x) => x.workerId)).size;
		assert.ok(startedBefore <= 2, `third worker started before a settle (${startedBefore})`);
		await mock.waitFor((x) => x.type === "started" && x.workerId === "w_slow3", 30000);
	});
});

test("reconnect resends unacked events (the DO dedups by seq)", async () => {
	await withRig("happy", async ({ mock }) => {
		mock.startWorker({ workerId: "w_resend1", threadId: "t_test", prompt: "do the thing" });
		// let one batch arrive unacked, then drop the connection mid-run
		await mock.waitFor((x) => x.type === "started", 15000);
		mock.dropConn();
		await mock.waitConnected(15000); // connector reconnects and resends the queue
		const settled = await mock.waitFor((x) => x.type === "settled" && x.workerId === "w_resend1", 30000);
		assert.equal(settled.outcome, "reported");
		// the started event (seq 1) must have arrived at least twice: once before the drop, once on resend
		const startedCount = mock.events().filter((x) => x.type === "started" && x.workerId === "w_resend1").length;
		assert.ok(startedCount >= 2, `expected the started event to be resent, saw it ${startedCount} time(s)`);
	}, { swallow: true });
});

test("idle recycle after a settle emits no lost event", async () => {
	await withRig("happy", async ({ mock }) => {
		const e = await dispatchAndAwait(mock, "w_recycle1", (x) => x.type === "settled");
		assert.equal(e.outcome, "reported");
		// SHEPHERD_IDLE_RECYCLE_MS is dialed down in withRig; wait past the recycle window
		await new Promise((r) => setTimeout(r, 3000));
		assert.equal(eventsOf(mock, "w_recycle1", "lost").length, 0, "idle recycle must not look like a lost worker");
	}, { idleMs: 1200 });
});

test("stall watchdog: a wedged run is respawned once and then completes", async () => {
	await withRig("stall_once", async ({ mock }) => {
		mock.startWorker({ workerId: "w_stallrec1", threadId: "t_test", prompt: "do the thing" });
		const restarted = await mock.waitFor((x) => x.type === "progress" && x.tool === "stall-watchdog", 40_000);
		assert.match(restarted.target ?? "", /自动重启/);
		const settled = await mock.waitFor((x) => x.type === "settled" && x.workerId === "w_stallrec1", 40_000);
		assert.equal(settled.outcome, "reported");
	}, { stallMs: 4000 });
});

test("stall watchdog: a second stall settles as error:stall", async () => {
	await withRig("stall", async ({ mock }) => {
		mock.startWorker({ workerId: "w_stall2", threadId: "t_test", prompt: "do the thing" });
		const settled = await mock.waitFor((x) => x.type === "settled" && x.workerId === "w_stall2", 60_000);
		assert.equal(settled.outcome, "error");
		assert.equal(settled.errorClass, "stall");
		assert.ok(eventsOf(mock, "w_stall2", "progress").some((p) => p.tool === "stall-watchdog"), "restart was announced");
	}, { stallMs: 4000 });
});

test("send_worker relays a follow-up to a running worker", async () => {
	await withRig("slow", async ({ mock }) => {
		mock.startWorker({ workerId: "w_send1", threadId: "t_test", prompt: "p1" });
		await mock.waitFor((x) => x.type === "started" && x.workerId === "w_send1", 15000);
		mock.sendCmd("send_worker", { workerId: "w_send1", message: "补充要求：顺便跑一下 lint" });
		await new Promise((r) => setTimeout(r, 1500));
		assert.ok(mock.cmdResults().some((c) => c.ok === true), `send_worker result ok: ${JSON.stringify(mock.cmdResults())}`);
		await mock.waitFor((x) => x.type === "settled" && x.workerId === "w_send1", 30000);
	});
});

test("interrupt_worker aborts a running worker", async () => {
	await withRig("slow", async ({ mock }) => {
		mock.startWorker({ workerId: "w_int1", threadId: "t_test", prompt: "p1" });
		await mock.waitFor((x) => x.type === "started" && x.workerId === "w_int1", 15000);
		await new Promise((r) => setTimeout(r, 300));
		mock.sendCmd("interrupt_worker", { workerId: "w_int1" });
		const settled = await mock.waitFor((x) => x.type === "settled" && x.workerId === "w_int1", 30000);
		assert.equal(settled.outcome, "aborted");
	});
});

test("replayed command (same id) does not start a second worker", async () => {
	await withRig("slow", async ({ mock }) => {
		const id = mock.sendCmd("start_worker", { workerId: "w_dedup1", threadId: "t_test", prompt: "p1" }, "cmd_fixed_id_1");
		await mock.waitFor((x) => x.type === "started" && x.workerId === "w_dedup1", 15000);
		mock.sendCmd("start_worker", { workerId: "w_dedup1", threadId: "t_test", prompt: "p1" }, id); // exact replay
		await new Promise((r) => setTimeout(r, 2000));
		const starts = mock.events().filter((x) => x.type === "started" && x.workerId === "w_dedup1");
		assert.equal(starts.length, 1, `expected exactly one started, saw ${starts.length}`);
	});
});

test("startup orphan sweep reports leftover worktrees as lost and removes clean ones", async () => {
	const f = fixture();
	await shell("git init -q && git config user.email t@t && git config user.name t && echo hello > README.md && git add -A && git commit -qm init", f.repo);
	mkdirSync(join(f.home, "worktrees"), { recursive: true });
	mkdirSync(join(f.home, "locks"), { recursive: true });
	await shell(`git worktree add -q -b shepherd/w_orphan1 ${f.home}/worktrees/w_orphan1`, f.repo);
	writeFileSync(join(f.home, "locks", "w_orphan1.lock"), JSON.stringify({ pid: 999_999, startedAt: "x" })); // dead pid
	const mock = startMockSteward();
	const port = await mock.listen();
	const proc = execFile(
		process.execPath,
		[CONNECTOR, "--url", `http://127.0.0.1:${port}`, "--name", "test-box", "--repo", f.repo, "--code", "X"],
		{ env: { ...process.env, SHEPHERD_HOME: f.home, SHEPHERD_PI_BIN: `${process.execPath} ${FAKE_PI}`, FAKE_PI_SCENARIO: "happy" } },
	);
	try {
		await mock.waitConnected(10_000);
		const lost = await mock.waitFor((x) => x.type === "lost" && x.workerId === "w_orphan1", 15_000);
		assert.match(lost.reason, /^orphan_sweep/);
		await new Promise((r) => setTimeout(r, 1000));
		assert.ok(!existsSync(join(f.home, "worktrees", "w_orphan1")), "clean orphan worktree removed");
	} finally {
		proc.kill("SIGKILL");
		await mock.close();
		f.cleanup();
	}
});

test("half-dead socket (no frames) is torn down and reconnected", async () => {
	await withRig("happy", async ({ mock }) => {
		// mock swallows every frame after the upgrade: no welcome, no pongs
		const t0 = mock.upgrades();
		await new Promise((resolve) => {
			const tick = () => (mock.upgrades() > t0 ? resolve() : setTimeout(tick, 200));
			setTimeout(tick, 100);
		});
		assert.ok(mock.pings() >= 2, "connector kept pinging the dead socket");
	}, { swallowFrames: true, deadMs: 3000, pingMs: 1000 });
});
