// Notes: the layered memory (issue #18, steward.md §2.3-§2.5, spec §10). The unit half runs
// the real module over the real migrations inside a fresh DO per test (createNotes enforces
// caps, dedup, supersession, and trust); the conversation half drives the scripted faux model
// through the tools — the resident section in the prompt, project notes on get_thread, the
// 「记账」 relay on the next reply, and list/pin/remove by conversation.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ShOutboundRow, Steward } from "../src/steward.ts";
import type { Ledger } from "../src/ledger.ts";
import type { NoteDraft, NoteRow, Notes } from "../src/notes.ts";
import { PROJECT_CAP_PER_REPO, RESIDENT_CAP, renderChangeReports, retentionScore } from "../src/notes.ts";
import {
  configureAndBind,
  connectAndHello,
  messageEvent,
  modelRequests,
  ownerStub,
  pairDevice,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
} from "./helpers.ts";

// The DO-side surface the unit tests reach through (private fields are typed away, the same
// cast helpers.ts uses for loadFeishuConfig).
type RawSql = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[];

/** Runs a whole test body inside a fresh DO: migrations applied on first touch, clean tables. */
async function inNotesDo(fn: (n: Notes, ledger: Ledger, sql: RawSql) => void | Promise<void>): Promise<void> {
  const id = env.Steward.idFromName(`notes-unit-${crypto.randomUUID()}`);
  const stub = env.Steward.get(id);
  // An RPC first (helpers.ts's pattern): it flows through the SDK lifecycle → onStart() →
  // migrations. runInDurableObject on a cold DO would find no sh_* tables yet.
  await stub.channelLogEntries(1);
  await runInDurableObject(stub, (instance: Steward) => {
    const ledger = (instance as unknown as { ledger: Ledger }).ledger;
    const sql = (instance as unknown as { sql: RawSql }).sql.bind(instance) as unknown as RawSql;
    return fn(ledger.notes, ledger, sql);
  });
}

/** Fills a layer to `fill` characters with `size`-char user_said notes; returns the rows. */
function fillLayer(n: Notes, layer: "resident" | "project", fill: number, size: number, repoId = "repo-a"): NoteRow[] {
  const created: NoteRow[] = [];
  for (let i = 0; i * size < fill; i += 1) {
    const prefix = `${layer === "resident" ? "全局偏好" : "仓库约定"}${String(i).padStart(6, "0")} `;
    const text = prefix + "记".repeat(size - prefix.length);
    const draft: NoteDraft =
      layer === "resident"
        ? { text, kind: "preference", source: "user_said", layer: "resident" }
        : { text, kind: "convention", source: "user_said", layer: "project", scopeRepoId: repoId };
    const done = n.commit(draft);
    if (!done.ok) throw new Error(`fill commit failed: ${done.message}`);
    created.push(done.note);
  }
  return created;
}

// ---- unit: caps (steward.md §2.3/§2.4) ------------------------------------------------------------

describe("notes unit: layer caps", () => {
  it("admits writes up to the cap exactly, then demands eviction", async () => {
    await inNotesDo((n) => {
      // 2360 of 2400 used: a 40-char note still fits, a 41-char one does not.
      fillLayer(n, "resident", 2360, 20);
      const fits = n.propose({ text: `${"合".repeat(39)}x`, kind: "preference", source: "user_said", layer: "resident" });
      expect(fits.needsEviction).toHaveLength(0);
      const tight = n.propose({ text: `${"合".repeat(40)}xy`, kind: "preference", source: "user_said", layer: "resident" });
      expect(tight.needsEviction.length).toBeGreaterThan(0);

      // Without replaces the module refuses; with the listed victim it writes.
      const refused = n.commit({ text: `${"合".repeat(40)}xy`, kind: "preference", source: "user_said", layer: "resident" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("capacity");
      const victim = tight.needsEviction[0]!;
      const done = n.commit(
        { text: `${"合".repeat(40)}xy`, kind: "preference", source: "user_said", layer: "resident" },
        { replaces: [victim.noteId] },
      );
      expect(done.ok).toBe(true);
      if (done.ok) {
        expect(done.changes.map((c) => c.op)).toContain("evicted");
        expect(n.get(victim.noteId)).toMatchObject({ layer: "archive", supersededBy: done.note.noteId });
      }
    });
  });

  it("rejects a single note over the cap outright", async () => {
    await inNotesDo((n) => {
      const tooBig = n.commit({ text: "巨".repeat(RESIDENT_CAP + 1), kind: "preference", source: "user_said", layer: "resident" });
      expect(tooBig.ok).toBe(false);
      if (!tooBig.ok) expect(tooBig.code).toBe("over_limit");
    });
  });

  it("keeps per-repo project caps independent", async () => {
    await inNotesDo((n) => {
      fillLayer(n, "project", PROJECT_CAP_PER_REPO, 20, "repo-a");
      const onB = n.commit({ text: "repo-b 用 vitest", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-b" });
      expect(onB.ok).toBe(true);
      const overA = n.commit({
        text: `${"仓".repeat(60)}库约定超长`,
        kind: "convention",
        source: "user_said",
        layer: "project",
        scopeRepoId: "repo-a",
      });
      expect(overA.ok).toBe(false);
      if (!overA.ok) expect(overA.code).toBe("capacity");
    });
  });

  it("never evicts pinned entries; an all-pinned layer refuses honestly", async () => {
    await inNotesDo((n) => {
      const created = fillLayer(n, "resident", 2360, 20);
      for (const row of created) n.pin(row.noteId, true);
      const propose = n.propose({ text: `${"合".repeat(40)}xy`, kind: "preference", source: "user_said", layer: "resident" });
      expect(propose.needsEviction).toHaveLength(0); // pinned entries are invisible to eviction
      const refused = n.commit({ text: `${"合".repeat(40)}xy`, kind: "preference", source: "user_said", layer: "resident" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("capacity");
      // Nothing was touched by the attempt: all 118 stay resident and pinned.
      expect(n.list({ layer: "resident" })).toHaveLength(118);
    });
  });
});

// ---- unit: dedup and similarity (steward.md §2.4) ---------------------------------------------------

describe("notes unit: dedup and similar candidates", () => {
  it("an exact (normalized) match is a duplicate: propose bumps useCount, commit absorbs", async () => {
    await inNotesDo((n) => {
      const first = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      expect(first.ok).toBe(true);

      // Whitespace differences collapse (trim + runs → one space); the second propose
      // reports the duplicate. (An inserted space inside is NOT collapsed away — it would
      // land in `similar` instead, which the previous test line already covers.)
      const propose = n.propose({ text: "  报告保持简短 \n ", kind: "preference", source: "user_said", layer: "resident" });
      expect(propose.duplicate?.useCount).toBe(1);
      expect(propose.similar).toHaveLength(0);
      expect(propose.duplicate?.text).toBe("报告保持简短");

      const again = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.bumped).toBe(true);
        expect(again.changes).toHaveLength(0); // nothing new noted, nothing to report
      }
      expect(n.list({ layer: "resident" })).toHaveLength(1);
    });
  });

  it("surfaces semantically close entries as similar, not strangers", async () => {
    await inNotesDo((n) => {
      n.commit({ text: "汇报保持简短，先结论后细节", kind: "preference", source: "user_said", layer: "resident" });
      n.commit({ text: "这个仓库用 pnpm 管理依赖", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      const hit = n.propose({
        text: "这个仓库用 pnpm 管理依赖（装包先 pnpm install）",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "repo-a",
      });
      expect(hit.similar.map((s) => s.text)).toContain("这个仓库用 pnpm 管理依赖");
      const miss = n.propose({
        text: "测试在 CI 里必须全绿才能合并",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "repo-b",
      });
      expect(miss.similar).toHaveLength(0);
    });
  });
});

// ---- unit: supersession (steward.md §2.4) -----------------------------------------------------------

describe("notes unit: supersession via replaces", () => {
  it("the old entry sinks to the archive as a historical version pointing at its successor", async () => {
    await inNotesDo((n) => {
      const old = n.commit({ text: "报告要短", kind: "preference", source: "user_said", layer: "resident" });
      if (!old.ok) throw new Error(old.message);
      const next = n.commit(
        { text: "报告要短：结论一行，要点最多四条", kind: "preference", source: "user_said", layer: "resident" },
        { replaces: [old.note.noteId] },
      );
      if (!next.ok) throw new Error(next.message);
      expect(n.get(old.note.noteId)).toMatchObject({
        layer: "archive",
        status: "superseded",
        supersededBy: next.note.noteId,
      });
      // The historical version stays searchable (archive: never deleted, §2.3).
      expect(n.search("报告要短").map((f) => f.noteId)).toContain(old.note.noteId);
      expect(next.changes.map((c) => c.op)).toEqual(["noted", "superseded"]);
    });
  });

  it("a replayed commit converges on the existing note (idempotent by dedup)", async () => {
    await inNotesDo((n) => {
      const draft: NoteDraft = { text: "派发前先看机器负载", kind: "preference", source: "user_said", layer: "resident" };
      const first = n.commit(draft);
      const second = n.commit(draft);
      if (!first.ok || !second.ok) throw new Error("commits failed");
      expect(second.bumped).toBe(true);
      expect(second.note.noteId).toBe(first.note.noteId);
      expect(n.list({ layer: "resident" })).toHaveLength(1);
    });
  });

  it("replaces can cross layers: the confirmed promotion path project → resident", async () => {
    await inNotesDo((n) => {
      const parked = n.commit({
        text: "这个仓库用 pnpm",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "repo-a",
      });
      if (!parked.ok) throw new Error(parked.message);
      expect(parked.note.confirmed).toBe(false);
      n.confirm(parked.note.noteId);
      const promoted = n.commit(
        { text: "这个仓库用 pnpm", kind: "convention", source: "worker_reported", layer: "resident", confirmed: true },
        { replaces: [parked.note.noteId] },
      );
      if (!promoted.ok) throw new Error(promoted.message);
      expect(promoted.note.layer).toBe("resident");
      expect(promoted.note.confirmed).toBe(true);
      expect(n.get(parked.note.noteId)?.supersededBy).toBe(promoted.note.noteId);
    });
  });
});

// ---- unit: trust gating (steward.md §2.3, spec §10.3) ------------------------------------------------

describe("notes unit: trust rules", () => {
  it("worker_reported and inferred stay out of the resident layer until confirmed", async () => {
    await inNotesDo((n) => {
      const refused = n.commit({ text: "用户喜欢晚上跑长任务", kind: "preference", source: "worker_reported", layer: "resident" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("trust");
      const inferredToo = n.commit({ text: "用户偏好简短汇报", kind: "preference", source: "inferred", layer: "resident" });
      expect(inferredToo.ok).toBe(false);

      // The project layer takes them — unconfirmed, exactly the §2.3 "pending" state.
      const parked = n.commit({
        text: "这个仓库用 pnpm",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "repo-a",
      });
      expect(parked.ok).toBe(true);
      if (parked.ok) {
        expect(parked.note.confirmed).toBe(false);
        expect(parked.note.layer).toBe("project");
      }

      // Confirmation flips the flag; a resident commit replacing it is then allowed.
      const confirmed = n.confirm(parked.ok ? parked.note.noteId : "");
      expect(confirmed.changes.map((c) => c.op)).toEqual(["confirmed"]);
      const promoted = n.commit(
        { text: "这个仓库用 pnpm", kind: "convention", source: "worker_reported", layer: "resident", confirmed: true },
      );
      expect(promoted.ok).toBe(true);
    });
  });

  it("connector facts never enter the resident layer, even confirmed", async () => {
    await inNotesDo((n) => {
      const refused = n.commit({
        text: "mac-studio 有 4 个 worker 槽",
        kind: "environment",
        source: "connector",
        layer: "resident",
        confirmed: true,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("trust");
      const parked = n.commit({
        text: "mac-studio 有 4 个 worker 槽",
        kind: "environment",
        source: "connector",
        layer: "project",
        scopeRepoId: "repo-a",
      });
      expect(parked.ok).toBe(true);
      if (parked.ok) expect(parked.note.confirmed).toBe(true); // high trust — just not resident
    });
  });

  it("user_said enters the resident layer confirmed", async () => {
    await inNotesDo((n) => {
      const said = n.commit({ text: "重活优先派给 codex", kind: "preference", source: "user_said", layer: "resident" });
      expect(said.ok).toBe(true);
      if (said.ok) expect(said.note.confirmed).toBe(true);
    });
  });

  it("invalid drafts are rejected (empty text, missing repoId, resident with repoId)", async () => {
    await inNotesDo((n) => {
      const empty = n.commit({ text: "  \n ", kind: "preference", source: "user_said", layer: "resident" });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.code).toBe("invalid");
      const noRepo = n.commit({ text: "约定", kind: "convention", source: "user_said", layer: "project" });
      expect(noRepo.ok).toBe(false);
      const withRepo = n.commit({
        text: "约定",
        kind: "preference",
        source: "user_said",
        layer: "resident",
        scopeRepoId: "repo-a",
      });
      expect(withRepo.ok).toBe(false);
    });
  });
});

// ---- unit: review-fix regressions (PR #44) -----------------------------------------------------------

describe("notes unit: review fixes (PR #44)", () => {
  it("forRepos touches only project notes — a get_thread fetch must not reset the resident decay clock", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const res = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      const proj = n.commit({ text: "这个仓库用 pnpm", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      if (!res.ok || !proj.ok) throw new Error("fixtures failed");
      const past = Date.now() - 5_000;
      sql`UPDATE sh_note SET lastUsedAt = ${past}`;
      n.forRepos(["repo-a"]);
      expect(n.get(res.note.noteId)?.lastUsedAt).toBe(past); // resident untouched (finding 2)
      expect(n.get(proj.note.noteId)!.lastUsedAt).toBeGreaterThan(past); // assembled ⇒ used
    });
  });

  it("propose surfaces refusals instead of swallowing them, and never offers evictions for an over-cap single note", async () => {
    await inNotesDo((n) => {
      const trust = n.propose({ text: "用户喜欢晚上跑长任务", kind: "preference", source: "worker_reported", layer: "resident" });
      expect(trust.rejected?.code).toBe("trust"); // (finding 5) the model learns it at propose
      expect(trust.needsEviction).toHaveLength(0);
      const over = n.propose({ text: "巨".repeat(RESIDENT_CAP + 1), kind: "preference", source: "user_said", layer: "resident" });
      expect(over.rejected?.code).toBe("over_limit");
      expect(over.needsEviction).toHaveLength(0); // no pointless eviction candidates
      const healthy = n.propose({ text: "正常的偏好", kind: "preference", source: "user_said", layer: "resident" });
      expect(healthy.rejected).toBeUndefined();
    });
  });

  it("the short-needle LIKE fallback escapes wildcards: 100% matches only the literal", async () => {
    await inNotesDo((n) => {
      const hit = n.commit({ text: "任务完成度达到 100%", kind: "fact", source: "user_said", layer: "project", scopeRepoId: "r" });
      const other = n.commit({ text: "速度提升了两倍", kind: "fact", source: "user_said", layer: "project", scopeRepoId: "r" });
      if (!hit.ok || !other.ok) throw new Error("fixtures failed");
      const hits = n.search("100%");
      expect(hits.map((h) => h.noteId)).toEqual([hit.note.noteId]); // not everything (finding 6)
    });
  });

  it("list: archive honors the repo scope; all keeps resident rows when scoped", async () => {
    await inNotesDo((n) => {
      const res = n.commit({ text: "全局偏好", kind: "preference", source: "user_said", layer: "resident" });
      const a = n.commit({ text: "repo-a 旧约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      const b = n.commit({ text: "repo-b 旧约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-b" });
      if (!res.ok || !a.ok || !b.ok) throw new Error("fixtures failed");
      n.commit(
        { text: "repo-a 新约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" },
        { replaces: [a.note.noteId] },
      );
      // archive + scope filters to that repo's history only (finding 7)
      const archiveA = n.list({ layer: "archive", scopeRepoId: "repo-a" }).map((x) => x.noteId);
      expect(archiveA).toEqual([a.note.noteId]);
      // all + scope: resident (global) rows stay in the listing (finding 7)
      const allA = n.list({ layer: "all", scopeRepoId: "repo-a" }).map((x) => x.noteId);
      expect(allA).toContain(res.note.noteId);
      expect(allA).toContain(a.note.noteId);
      expect(allA).not.toContain(b.note.noteId);
    });
  });

  it("confirm records the owner's evidence message on the log row", async () => {
    await inNotesDo((n) => {
      const parked = n.commit({ text: "这个仓库用 pnpm", kind: "convention", source: "worker_reported", layer: "project", scopeRepoId: "r" });
      if (!parked.ok) throw new Error(parked.message);
      n.confirm(parked.note.noteId, "user:om_confirm_9");
      const entry = n.pendingChanges().find((c) => c.op === "confirmed");
      expect(entry?.reason).toBe("confirmed_by:user:om_confirm_9"); // promotion provenance stays traceable
    });
  });

  it("renderPendingForReply is read-only; markPendingReported is bounded by upTo", async () => {
    await inNotesDo((n) => {
      const one = n.commit({ text: "第一条", kind: "preference", source: "user_said", layer: "resident" });
      if (!one.ok) throw new Error(one.message);
      const first = n.renderPendingForReply();
      expect(first.text).toContain("记住了");
      expect(n.pendingChanges()).toHaveLength(1); // nothing marked by the render (finding 4)
      // A change landing between render and mark keeps its id above upTo: stays pending.
      const two = n.commit({ text: "第二条", kind: "preference", source: "user_said", layer: "resident" });
      if (!two.ok) throw new Error(two.message);
      n.markPendingReported(first.upTo);
      const pending = n.pendingChanges();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.noteId).toBe(two.note.noteId); // rides the NEXT reply
    });
  });
});

// ---- unit: the retention score (steward.md §2.5) -----------------------------------------------------

describe("notes unit: eviction ordering", () => {
  it("needsEviction is score-ordered: inferred sinks before user_said, unconfirmed before confirmed", async () => {
    await inNotesDo((n) => {
      const said = n.commit({ text: `${"用".repeat(40)}户说的偏好`, kind: "preference", source: "user_said", layer: "resident" });
      const guessed = n.commit({ text: `${"推".repeat(40)}断出的偏好`, kind: "preference", source: "inferred", layer: "project", scopeRepoId: "r" });
      if (!said.ok || !guessed.ok) throw new Error("fixtures failed");
      n.pin(said.note.noteId, false);
      // Equal age and use: sourceWeight decides (inferred 0.3 < user_said 1.0).
      expect(retentionScore(guessed.note, Date.now())).toBeLessThan(retentionScore(said.note, Date.now()));

      const confirmed = n.commit({ text: `${"证".repeat(40)}实过的汇报`, kind: "preference", source: "worker_reported", layer: "project", scopeRepoId: "r", confirmed: true });
      if (!confirmed.ok) throw new Error("fixture failed");
      const unconfirmed = n.commit({ text: `${"未".repeat(40)}证实的汇报`, kind: "preference", source: "worker_reported", layer: "project", scopeRepoId: "r" });
      if (!unconfirmed.ok) throw new Error("fixture failed");
      expect(retentionScore(unconfirmed.note, Date.now())).toBeLessThan(retentionScore(confirmed.note, Date.now()));
    });
  });
});

// ---- unit: maintenance (steward.md §2.5) --------------------------------------------------------------

describe("notes unit: maintenance (decay, suggestions, capacity backstop)", () => {
  it("demotes project entries unused for 60 days; resident entries only get a suggestion", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const proj = n.commit({ text: "老仓库约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-old" });
      const res = n.commit({ text: "老全局偏好", kind: "preference", source: "user_said", layer: "resident" });
      if (!proj.ok || !res.ok) throw new Error("fixtures failed");
      const stale = Date.now() - 91 * 86_400_000;
      sql`UPDATE sh_note SET lastUsedAt = ${stale} WHERE noteId IN (${proj.note.noteId}, ${res.note.noteId})`;

      const changes = n.maintenance(Date.now());
      expect(changes.map((c) => c.op)).toEqual(["demoted", "suggest_demote"]);
      expect(n.get(proj.note.noteId)?.layer).toBe("archive");
      expect(n.get(res.note.noteId)?.layer).toBe("resident"); // suggestion only — never auto-demoted

      // The suggestion does not re-fire daily while it waits for the user.
      const again = n.maintenance(Date.now());
      expect(again.map((c) => c.op)).not.toContain("suggest_demote");
    });
  });

  it("pinned entries are exempt from decay; the capacity backstop evicts by score", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const pinned = n.commit({ text: "置顶的老偏好", kind: "preference", source: "user_said", layer: "resident" });
      const lowScore = n.commit({
        text: "推断的老偏好",
        kind: "preference",
        source: "inferred",
        layer: "resident",
        confirmed: true,
      });
      if (!pinned.ok || !lowScore.ok) throw new Error("fixtures failed");
      n.pin(pinned.note.noteId, true);
      // The pinned entry is old — decay must skip it anyway, but keep the victim fresh so
      // only the capacity backstop (score-ordered) acts here.
      const stale = Date.now() - 91 * 86_400_000;
      sql`UPDATE sh_note SET lastUsedAt = ${stale} WHERE noteId = ${pinned.note.noteId}`;
      // Simulate cap drift (e.g. writes from older code): inflate bytes past the cap.
      sql`UPDATE sh_note SET bytes = ${RESIDENT_CAP} WHERE noteId = ${pinned.note.noteId}`;

      const changes = n.maintenance(Date.now());
      // The pinned entry is never suggested nor evicted; the low-score one is.
      expect(changes.map((c) => c.op)).toEqual(["evicted"]);
      expect(n.get(lowScore.note.noteId)?.layer).toBe("archive");
      expect(n.get(pinned.note.noteId)).toMatchObject({ layer: "resident", pinned: true });
    });
  });
});

// ---- unit: search (sh_note_fts, trigram) and the relay ------------------------------------------------

describe("notes unit: FTS search and the change relay", () => {
  it("finds Chinese substrings across every non-removed layer, including history", async () => {
    await inNotesDo((n) => {
      const live = n.commit({ text: "这个仓库用 pnpm 管理依赖", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      const removed = n.commit({ text: "临时草稿条目", kind: "fact", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      if (!live.ok || !removed.ok) throw new Error("fixtures failed");
      n.remove(removed.note.noteId);

      const hits = n.search("pnpm 管理");
      expect(hits.map((h) => h.noteId)).toContain(live.note.noteId);
      expect(hits.map((h) => h.noteId)).not.toContain(removed.note.noteId);
      expect(n.search("临时草稿")).toHaveLength(0);
      // Short needles (below trigram's 3 chars) still work via the LIKE fallback.
      expect(n.search("草稿").map((h) => h.noteId)).not.toContain(removed.note.noteId);
    });
  });

  it("drains pending changes into one relay block, once", async () => {
    await inNotesDo((n) => {
      const one = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      const two = n.commit({ text: "重活优先给 codex", kind: "preference", source: "user_said", layer: "resident" });
      if (!one.ok || !two.ok) throw new Error("fixtures failed");
      n.pin(two.note.noteId, true);

      expect(n.pendingChanges().map((c) => c.op)).toEqual(["noted", "noted", "pinned"]);
      const block = n.drainPendingForReply();
      expect(block).toContain("（记账：");
      expect(block).toContain("记住了「报告保持简短」");
      expect(block).toContain("「重活优先给 codex」已置顶");
      expect(n.pendingChanges()).toHaveLength(0);
      expect(n.drainPendingForReply()).toBe("");
    });
  });

  it("bounds the relay block at ten clauses plus a count line", () => {
    const changes = Array.from({ length: 13 }, (_, i) => ({
      op: "noted" as const,
      noteId: `n_${i}`,
      text: `偏好${i}`,
      reason: null,
    }));
    const rendered = renderChangeReports(changes);
    expect(rendered).toContain("另有 3 条记忆变更");
    expect(rendered.length).toBeLessThanOrEqual(700);
  });
});

// ---- unit: context assembly --------------------------------------------------------------------------

describe("notes unit: context and the resident section", () => {
  it("context returns resident + scoped project notes and bumps lastUsedAt", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const res = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      const mine = n.commit({ text: "这个仓库用 pnpm", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      const other = n.commit({ text: "别的仓库约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-b" });
      if (!res.ok || !mine.ok || !other.ok) throw new Error("fixtures failed");

      // Rewind both project notes' lastUsedAt: same-millisecond creation would otherwise
      // make the touch indistinguishable from the untouched row.
      const past = Date.now() - 5_000;
      sql`UPDATE sh_note SET lastUsedAt = ${past} WHERE noteId IN (${mine.note.noteId}, ${other.note.noteId})`;
      const ctx = n.context({ repoIds: ["repo-a"] });
      expect(ctx.resident.map((x) => x.noteId)).toEqual([res.note.noteId]);
      expect(ctx.project.map((x) => x.noteId)).toEqual([mine.note.noteId]);
      const touched = n.get(mine.note.noteId)!;
      const untouched = n.get(other.note.noteId)!;
      expect(touched.lastUsedAt).toBeGreaterThan(untouched.lastUsedAt!);
      expect(n.forRepos(["repo-b"]).map((x) => x.noteId)).toEqual([other.note.noteId]);
    });
  });

  it("renders the resident section with pinned first; empty layer renders nothing", async () => {
    await inNotesDo((n) => {
      expect(n.renderResidentSection()).toBe("");
      const plain = n.commit({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" });
      const pinned = n.commit({ text: "重活优先给 codex", kind: "preference", source: "user_said", layer: "resident" });
      if (!plain.ok || !pinned.ok) throw new Error("fixtures failed");
      n.pin(pinned.note.noteId, true);
      const section = n.renderResidentSection();
      expect(section).toContain("偏好与全局约定");
      expect(section.indexOf("重活优先给 codex")).toBeLessThan(section.indexOf("报告保持简短")); // pinned first
      expect(section).toContain("用户说的");
    });
  });
});

// ---- the conversation surface: tools, section, relay (faux model, production paths) -------------------

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 10)}`): Promise<{ msgId: string; res: Response }> {
  const res = await postEvent(messageEvent({ msgId, text }));
  expect(res.status).toBe(200);
  return { msgId, res };
}

/** All sent text rows so far (a snapshot — for anything racing the delivery pass, poll instead). */
async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

/** Polls until a sent text row contains `needle` (replies send asynchronously after settle). */
async function waitForSentContaining(needle: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const texts = await sentTexts();
    const hit = texts.find((t) => t.includes(needle));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no sent text contains: ${needle} (sent: ${JSON.stringify(texts)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("notes in conversation (issue #18, steward.md §4.1/§4.3, spec §10.3)", () => {
  it("a user preference lands in the resident layer and renders as a prompt section", async () => {
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_propose", { text: "报告保持简短，先结论", kind: "preference", source: "user_said", layer: "resident" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", { text: "报告保持简短，先结论", kind: "preference", source: "user_said", layer: "resident" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("好，记住了。")]),
    );
    await dm("记住：报告保持简短，先结论。");
    await waitRunsSettled();

    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes).toHaveLength(1);
    expect(snap.notes[0]).toMatchObject({ layer: "resident", source: "user_said", confirmed: true, text: "报告保持简短，先结论" });

    // §4.1: the resident layer is one system-prompt section — present in the requests after
    // the commit (this run's own follow-up requests included), rendered fresh from the ledger.
    const requests = await modelRequests();
    const withNotes = requests.filter((r) => (r.notes ?? "").includes("报告保持简短"));
    expect(withNotes.length).toBeGreaterThan(0);
    expect(withNotes[0]!.notes).toContain("用户说的");

    // spec §10.3: the reply carries the deterministic「记账」relay — remembered out loud.
    const reply = await waitForSentContaining("记住了「报告保持简短，先结论」");
    expect(reply).toContain("记账：");
  });

  it("project notes come back with get_thread for the repos it involves", async () => {
    const { deviceId, token } = await pairDevice("mac-studio");
    await connectAndHello(deviceId, token, 1, {
      repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
    });
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome.kind).toBe("dispatched");
    const threadId = outcome.kind === "dispatched" ? outcome.threadId : "";
    // The thread's repoIds are the connector-reported repoIds (/srv/repo-a).
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({
        text: "这个仓库用 pnpm 管理依赖",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "/srv/repo-a",
      });
      if (!done.ok) throw new Error(done.message);
    });

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("get_thread", { threadId })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("看过了。")]),
    );
    await dm("这个 thread 现在什么情况？");
    await waitRunsSettled();
    const requests = await modelRequests();
    const toolResult = requests.find((r) => r.lastToolResult.includes("projectNotes"));
    expect(toolResult).toBeDefined();
    expect(toolResult!.lastToolResult).toContain("这个仓库用 pnpm 管理依赖");
    // worker_reported stays unconfirmed in the project layer until the owner confirms.
    expect(toolResult!.lastToolResult).toContain('"confirmed":false');
    expect(toolResult!.lastToolResult).toContain('"source":"worker_reported"');
  });

  it("low-trust sources cannot sneak into the resident layer without the owner's own words", async () => {
    // The worker "reported" a preference; the steward tries to store it resident directly.
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", { text: "用户喜欢晚上跑长任务", kind: "preference", source: "worker_reported", layer: "resident" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("先记到项目层。")]),
    );
    await dm("worker 汇报完了");
    await waitRunsSettled();
    const requests = await modelRequests();
    const refusal = requests.find((r) => r.lastToolResult.includes("refused"));
    expect(refusal).toBeDefined();
    expect(refusal!.lastToolResult).toContain("常驻层");
    expect((await ownerStub().debugSnapshot()).notes.filter((n) => n.layer === "resident")).toHaveLength(0);

    // With the owner's real confirmation message as evidence, the promotion goes through.
    // (Their DM is a message this deployment truly received — checkProvenanceRef verifies.)
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", {
          text: "用户喜欢晚上跑长任务",
          kind: "preference",
          source: "worker_reported",
          layer: "resident",
          confirmEvidence: "user:om_confirm_1",
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已提升。")]),
    );
    await dm("对，我喜欢晚上跑长任务", "om_confirm_1");
    await waitRunsSettled();
    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes.filter((n) => n.layer === "resident" && n.confirmed)).toHaveLength(1);
  });

  it("notes can be listed, pinned, and removed by conversation", async () => {
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({
        text: "报告保持简短",
        kind: "preference",
        source: "user_said",
        layer: "resident",
      });
      if (!done.ok) throw new Error(done.message);
    });
    // Drain the pending「记账」from the seed so the reply assertions below stay exact.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      ledger.notes.drainPendingForReply();
    });

    const noteId = (await ownerStub().debugSnapshot()).notes[0]!.noteId;
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_list", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("notes_pin", { noteId, pinned: true })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已列出并置顶。")]),
    );
    await dm("看看你记住了什么，把那条置顶");
    await waitRunsSettled();

    let snap = await ownerStub().debugSnapshot();
    expect(snap.notes[0]).toMatchObject({ pinned: true });
    const requests = await modelRequests();
    const listResult = requests.find((r) => r.lastToolResult.includes("报告保持简短"));
    expect(listResult).toBeDefined();

    // The pin is relayed with the reply; the earlier noted-change was already drained.
    await waitForSentContaining("已置顶");

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_remove", { noteId })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已删除。")]),
    );
    await dm("把那条删了吧");
    await waitRunsSettled();
    snap = await ownerStub().debugSnapshot();
    expect(snap.notes[0]).toMatchObject({ status: "removed", layer: "archive" }); // tombstone, never a hard delete
    await waitForSentContaining("已删除");
  });

  it("an over-cap commit is refused with the eviction candidates spelled out", async () => {
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      // 2360 chars of resident preferences: the next 41-char write needs one 20-char victim.
      for (let i = 0; i < 118; i += 1) {
        const prefix = `偏好${String(i).padStart(6, "0")} `;
        const done = ledger.notes.commit({
          text: prefix + "记".repeat(20 - prefix.length),
          kind: "preference",
          source: "user_said",
          layer: "resident",
        });
        if (!done.ok) throw new Error(done.message);
      }
      ledger.notes.drainPendingForReply();
    });

    const newText = `${"新".repeat(40)}偏好`;
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_propose", { text: newText, kind: "preference", source: "user_said", layer: "resident" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("notes_commit", { text: newText, kind: "preference", source: "user_said", layer: "resident" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("层满了，需要你挑一条扔。")]),
    );
    await dm(`记住个新偏好：${newText}`);
    await waitRunsSettled();
    const requests = await modelRequests();
    const refusal = requests.find((r) => r.lastToolResult.includes("refused"));
    expect(refusal).toBeDefined();
    expect(refusal!.lastToolResult).toContain("replaces");
    expect(refusal!.lastToolResult).toContain("可腾挪候选");
    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes.filter((n) => n.layer === "resident")).toHaveLength(118);
  });
});

describe("notes trust gates: the evidence rules (PR #44 review finding 3)", () => {
  it("a user_said resident note carries the triggering message as evidence (auto-attached in user runs)", async () => {
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", { text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("好。")]),
    );
    const { msgId } = await dm("记住：报告保持简短");
    await waitRunsSettled();
    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes).toHaveLength(1);
    // The gate's trace: the note hangs on the message the user actually sent.
    expect(snap.notes[0]).toMatchObject({ layer: "resident", evidence: `user:${msgId}` });
  });

  it("an event run cannot write user_said into the resident layer without citing the user's message", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome.kind).toBe("dispatched");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "sig/x-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });

    // The report wake (⟦event⟧) fires after the 3s merge window; during that run the model
    // tries to store a worker-claimed "preference" as user_said — the tool refuses: in an
    // event run there is no user message to auto-attach, and none was cited.
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", { text: "用户喜欢晚上跑长任务", kind: "preference", source: "user_said", layer: "resident" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("no_action", { reason: "记账完成" })]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "任务完成" });
    await waitRunsSettled();

    const requests = await modelRequests();
    const refusal = requests.find((r) => r.lastToolResult.includes("常驻层记忆必须挂在用户真正说过的消息上"));
    expect(refusal).toBeDefined();
    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes.filter((n) => n.layer === "resident")).toHaveLength(0);
    expect(snap.noteLog).toHaveLength(0); // a refusal logs nothing — no announcement owed
  });

  it("notes_confirm requires the confirmation to postdate the note (the user must have seen the「记账」)", async () => {
    await dm("一条更早的无关消息", "om_early"); // received BEFORE the note exists
    const noteId = await (async () => {
      const r = await runInDurableObject(ownerStub(), (instance: Steward) => {
        const ledger = (instance as unknown as { ledger: Ledger }).ledger;
        const done = ledger.notes.commit({
          text: "这个仓库用 pnpm",
          kind: "convention",
          source: "worker_reported",
          layer: "project",
          scopeRepoId: "/srv/repo-a",
        });
        if (!done.ok) throw new Error(done.message);
        ledger.notes.drainPendingForReply(); // seeded silently: not this test's subject
        return done.note.noteId;
      });
      return r;
    })();

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_confirm", { noteId, evidenceRef: "user:om_early" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("需要用户先确认。")]),
    );
    await dm("对，没错", "om_confirm_late");
    await waitRunsSettled();
    const requests = await modelRequests();
    const stale = requests.find((r) => r.lastToolResult.includes("确认消息必须晚于笔记创建"));
    expect(stale).toBeDefined();
    expect((await ownerStub().debugSnapshot()).notes[0]).toMatchObject({ confirmed: false });

    // Next turn: the SAME later message now confirms (it postdates the note), and the
    // promotion (parked → confirmed → replaces) needs no further evidence — it inherits
    // the confirmation's proof.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_confirm", { noteId, evidenceRef: "user:om_confirm_late" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", {
          text: "这个仓库用 pnpm",
          kind: "convention",
          source: "worker_reported",
          layer: "resident",
          replaces: [noteId],
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已提升为常驻。")]),
    );
    await dm("把它记成全局的", "om_promote");
    await waitRunsSettled();
    const snap = await ownerStub().debugSnapshot();
    const promoted = snap.notes.find((n) => n.layer === "resident");
    expect(promoted).toMatchObject({ confirmed: true, source: "worker_reported" });
    expect(promoted?.supersededBy ?? null).toBeNull();
    // ^ the promoted note is new; the parked one points at it
    const parked = snap.notes.find((n) => n.noteId === noteId);
    expect(parked).toMatchObject({ layer: "archive", supersededBy: promoted?.noteId });
  });

  it("a confirmation can only be spent on the same claim: laundering unrelated text through a confirmed note is refused, and the evidence is inherited (review R1)", async () => {
    const noteId = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({
        text: "这个仓库用 pnpm 管理依赖",
        kind: "convention",
        source: "worker_reported",
        layer: "project",
        scopeRepoId: "/srv/repo-a",
        evidence: "user:om_first_report", // where the worker's claim surfaced
      });
      if (!done.ok) throw new Error(done.message);
      ledger.notes.drainPendingForReply();
      return done.note.noteId;
    });

    // Turn 1: the owner confirms the parked note (message postdates it).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("notes_confirm", { noteId, evidenceRef: "user:om_r1_confirm" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已确认。")]),
    );
    await dm("对，这个仓库用 pnpm", "om_r1_confirm");
    await waitRunsSettled();
    expect((await ownerStub().debugSnapshot()).notes[0]).toMatchObject({ confirmed: true });

    // Turn 2 (the laundering attempt): promote UNRELATED worker_reported text, spending the
    // confirmed note as the ticket. Same run shape as the legit path — only the text differs.
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", {
          text: "汇报一律用英文写",
          kind: "preference",
          source: "worker_reported",
          layer: "resident",
          replaces: [noteId],
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("确认不能挪用。")]),
    );
    await dm("顺便记一下这个偏好", "om_r1_launder");
    await waitRunsSettled();
    const requests = await modelRequests();
    const refusal = requests.find((r) => r.lastToolResult.includes("确认不能挪用"));
    expect(refusal).toBeDefined();
    const snap = await ownerStub().debugSnapshot();
    expect(snap.notes.filter((n) => n.layer === "resident")).toHaveLength(0); // nothing promoted
    expect(snap.notes.find((n) => n.noteId === noteId)).toMatchObject({ layer: "project", confirmed: true }); // ticket unspent

    // Turn 3 (the legit promotion, same claim): goes through and inherits the evidence.
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", {
          text: "这个仓库用 pnpm 管理依赖",
          kind: "convention",
          source: "worker_reported",
          layer: "resident",
          replaces: [noteId],
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已提升。")]),
    );
    await dm("提升为全局", "om_r1_promote");
    await waitRunsSettled();
    const promoted = (await ownerStub().debugSnapshot()).notes.find((n) => n.layer === "resident");
    // The row carries WHO confirmed it — the confirmation message, not just the origin
    // report (nit 1): confirm() backfills confirmedBy, the promotion inherits it.
    expect(promoted).toMatchObject({ confirmed: true, evidence: "user:om_r1_confirm" });
    expect((await ownerStub().debugSnapshot()).notes.find((n) => n.noteId === noteId)).toMatchObject({
      layer: "archive",
      supersededBy: promoted?.noteId,
    });
  });

  it("a direct low-trust promotion must cite the run's own user message — an older real message is not enough", async () => {
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      ledger.notes.drainPendingForReply();
    });
    await dm("一条真实存在的更早消息", "om_old_real"); // received, but BEFORE this turn
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notes_commit", {
          text: "用户喜欢晚上跑长任务",
          kind: "preference",
          source: "worker_reported",
          layer: "resident",
          confirmEvidence: "user:om_old_real",
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("引用旧消息不行。")]),
    );
    // om_old_real IS a real, previously-received user message — but THIS run was triggered
    // by a different one: the confirmation must have happened in this conversation turn.
    await dm("随便聊点别的", "om_other_turn");
    await waitRunsSettled();
    const requests = await modelRequests();
    const refusal = requests.find((r) => r.lastToolResult.includes("触发本轮的那条用户消息"));
    expect(refusal).toBeDefined();
    expect((await ownerStub().debugSnapshot()).notes.filter((n) => n.layer === "resident")).toHaveLength(0);
  });
});

// ---- forgetting and daily maintenance (issue #19, steward.md §2.5, spec §10.2) ----------------------

describe("notes forgetting: retention, pins, pressure (issue #19)", () => {
  it("the retention score weighs recency, usage, source, and confirmation (§2.5 formula)", async () => {
    await inNotesDo(() => {
      const now = Date.now();
      const base: NoteRow = { noteId: "n_x", layer: "resident", scopeRepoId: null, kind: "preference", text: "t", bytes: 1, source: "user_said", evidence: null, confirmedBy: null, confirmed: true, pinned: false, createdAt: now, lastUsedAt: now, useCount: 0, status: "active", supersededBy: null };
      const fresh = { ...base, lastUsedAt: now - 1 * 86_400_000 };
      const stale = { ...base, lastUsedAt: now - 80 * 86_400_000 };
      expect(retentionScore(fresh, now)).toBeGreaterThan(retentionScore(stale, now));
      const used = { ...base, useCount: 5 };
      const unused = { ...base, useCount: 0 };
      expect(retentionScore(used, now)).toBeGreaterThan(retentionScore(unused, now));
      const confirmed: NoteRow = { ...base, source: "worker_reported", confirmed: true };
      const unconfirmed: NoteRow = { ...base, source: "worker_reported", confirmed: false };
      expect(retentionScore(unconfirmed, now)).toBe(retentionScore(confirmed, now) / 2);
    });
  });

  it("a pinned target is refused in replaces regardless of capacity (review finding 1)", async () => {
    await inNotesDo((n) => {
      // Escape (a): the layer has ROOM — the old code archived the pinned target anyway.
      const lone = n.commit({ text: "唯一的旧偏好", kind: "preference", source: "user_said", layer: "resident" });
      if (!lone.ok) throw new Error("fixture failed");
      n.pin(lone.note.noteId, true);
      const withRoom = n.commit(
        { text: "一条无关的新偏好", kind: "preference", source: "user_said", layer: "resident" },
        { replaces: [lone.note.noteId] },
      );
      expect(withRoom.ok).toBe(false);
      if (!withRoom.ok) {
        expect(withRoom.code).toBe("invalid");
        expect(withRoom.message).toContain("置顶");
      }
      expect(n.get(lone.note.noteId)).toMatchObject({ layer: "resident", status: "active", pinned: true });

      // Escape (b): near-cap, mixed targets — the unpinned ones alone cover the deficit.
      // The old code skipped the pinned check and the loop archived the pinned note as 'evicted'.
      const created = fillLayer(n, "resident", 2360, 20);
      const pinned = created[5]!;
      n.pin(pinned.noteId, true);
      const mixed = n.commit(
        { text: `${"另".repeat(40)}一条新偏好`, kind: "preference", source: "user_said", layer: "resident" },
        { replaces: [created[0]!.noteId, pinned.noteId] },
      );
      expect(mixed.ok).toBe(false);
      if (!mixed.ok) expect(mixed.code).toBe("invalid");
      expect(n.get(pinned.noteId)).toMatchObject({ layer: "resident", status: "active", pinned: true });
      expect(n.get(created[0]!.noteId)).toMatchObject({ layer: "resident", status: "active" }); // untouched too
    });
  });

  it("a user_said write over cap records pressure; a low-trust write does not", async () => {
    await inNotesDo((n, _ledger, sql) => {
      fillLayer(n, "project", PROJECT_CAP_PER_REPO - 10, 20, "repo-a");
      const refused = n.commit({ text: "用 vitest 跑测试，报告要带截图", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      expect(refused.ok).toBe(false);
      const rows = sql<{ layer: string; scope_repoId: string; text: string }>`SELECT layer, scope_repoId, text FROM sh_note_pressure`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ layer: "project", scope_repoId: "repo-a", text: "用 vitest 跑测试，报告要带截图" });

      // Low-trust sources are never worth the room: no pressure row, plain refusal.
      const lowTrust = n.commit({ text: "低信任来源的满层写入", kind: "convention", source: "worker_reported", layer: "project", scopeRepoId: "repo-a" });
      expect(lowTrust.ok).toBe(false);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(1);

      // A retry with the named victim succeeds — and clears the pressure row.
      const propose = n.propose({ text: "用 vitest 跑测试，报告要带截图", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      const done = n.commit(
        { text: "用 vitest 跑测试，报告要带截图", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" },
        { replaces: [propose.needsEviction[0]!.noteId] },
      );
      expect(done.ok).toBe(true);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
    });
  });

  it("maintenance resolves ignored pressure by score: evicts, then writes, then reports both", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const created = fillLayer(n, "resident", 2360, 20); // user_said, equal scores → oldest first
      // The lowest-value entry: inferred beats user_said only when confirmed — sink an
      // unconfirmed worker_reported project note as the expected victim? No: different layer.
      // Instead: mark note #2 inferred-origin by rewriting its row (source column is the weight).
      // Sink every other entry's clock to "freshly used" and make this one the stale,
      // unconfirmed worker_reported entry: the lowest retention score by construction.
      const stale = Date.now() - 80 * 86_400_000;
      const fresh = Date.now();
      for (const [idx, row] of created.entries()) {
        sql`UPDATE sh_note SET lastUsedAt = ${idx === 1 ? stale : fresh}, useCount = ${idx === 1 ? 0 : 3},
               source = ${idx === 1 ? "worker_reported" : "user_said"}, confirmed = ${idx === 1 ? 0 : 1}
             WHERE noteId = ${row.noteId}`;
      }
      const asked = `${"报".repeat(55)}必须中文`; // 59 chars: 2360 + 59 > 2400 → refused, pressure recorded
      n.commit({ text: asked, kind: "preference", source: "user_said", layer: "resident", evidence: "user:om_pressure_1" });
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(1);

      const changes = n.maintenance(Date.now());
      // The ignored request was honoured: one note written, one entry evicted for it.
      expect(changes.map((c) => c.op)).toContain("noted");
      expect(changes.map((c) => c.op)).toContain("evicted");
      const evicted = changes.find((c) => c.op === "evicted")!;
      // The victim is the unconfirmed worker_reported entry — the lowest score, not the oldest.
      expect(evicted!.noteId).toBe(created[1]!.noteId);
      const noted = changes.find((c) => c.op === "noted")!;
      expect(noted!.text).toBe(asked);
      // The deferred write keeps the draft's shape and its verified provenance.
      expect(n.get(noted!.noteId)).toMatchObject({ kind: "preference", evidence: "user:om_pressure_1", source: "user_said" });
      expect(n.get(evicted!.noteId)).toMatchObject({ layer: "archive", supersededBy: expect.any(String) });
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
      // The cap holds after the pass.
      const bytes = sql<{ total: number }>`SELECT COALESCE(SUM(bytes),0) AS total FROM sh_note WHERE layer='resident' AND status='active'`[0]!.total;
      expect(bytes).toBeLessThanOrEqual(2400);
    });
  });

  it("an unrelated successful write does not silently delete the parked promise (review finding 2)", async () => {
    await inNotesDo((n, _ledger, sql) => {
      fillLayer(n, "resident", 2360, 20);
      const refused = n.commit({ text: `${"长".repeat(55)}的一条用户偏好`, kind: "preference", source: "user_said", layer: "resident" });
      expect(refused.ok).toBe(false);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(1);

      // An UNRELATED small write fits without touching the parked request's room.
      const small = n.commit({ text: "短偏好", kind: "preference", source: "user_said", layer: "resident" });
      if (!small.ok) throw new Error(small.message);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(1); // the promise survives

      // The daily pass still honours it — evicting by score, writing, reporting both halves.
      const changes = n.maintenance(Date.now());
      expect(changes.map((c) => c.op)).toContain("noted");
      expect(changes.map((c) => c.op)).toContain("evicted");
      const noted = changes.find((c) => c.op === "noted")!;
      expect(noted.text).toContain("的一条用户偏好");
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
    });
  });

  it("two distinct parked requests are both honoured — latest-wins no longer erases one (review finding 3)", async () => {
    await inNotesDo((n, _ledger, sql) => {
      fillLayer(n, "resident", 2360, 20);
      const first = n.commit({ text: `${"甲".repeat(55)}的第一条偏好`, kind: "preference", source: "user_said", layer: "resident" });
      const second = n.commit({ text: `${"乙".repeat(55)}的第二条偏好`, kind: "preference", source: "user_said", layer: "resident" });
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(2);
      // The identical retry is a true no-op for the log too (the log-dup minor).
      n.commit({ text: `${"乙".repeat(55)}的第二条偏好`, kind: "preference", source: "user_said", layer: "resident" });
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_log WHERE op = 'room_needed'`[0]!.n).toBe(2);

      const changes = n.maintenance(Date.now());
      const noted = changes.filter((c) => c.op === "noted").map((c) => c.text);
      expect(noted).toHaveLength(2);
      expect(noted.some((t) => t.includes("的第一条偏好"))).toBe(true);
      expect(noted.some((t) => t.includes("的第二条偏好"))).toBe(true);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
    });
  });

  it("a parked correction supersedes its named predecessor — not score-evicts around it (review finding 4)", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const predecessor = n.commit({ text: "汇报一律用英文写", kind: "preference", source: "user_said", layer: "resident" });
      if (!predecessor.ok) throw new Error("fixture failed");
      fillLayer(n, "resident", 2360 - predecessor.note.text.length, 20);
      // The correction names its predecessor but the reworded text still does not fit.
      const correction = n.commit(
        { text: `汇报一律用中文写，${"包".repeat(50)}括标题`, kind: "preference", source: "user_said", layer: "resident" },
        { replaces: [predecessor.note.noteId] },
      );
      expect(correction.ok).toBe(false);

      const changes = n.maintenance(Date.now());
      expect(changes.map((c) => c.op)).toContain("superseded");
      const superseded = changes.find((c) => c.op === "superseded")!;
      expect(superseded.noteId).toBe(predecessor.note.noteId);
      const noted = changes.find((c) => c.op === "noted")!;
      expect(noted.text).toContain("汇报一律用中文写");
      // The predecessor sank as a historical version of the correction — both-active is gone.
      expect(n.get(predecessor.note.noteId)).toMatchObject({
        layer: "archive",
        status: "superseded",
        supersededBy: noted.noteId,
      });
      expect(n.get(noted.noteId)).toMatchObject({ layer: "resident", status: "active" });
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
    });
  });

  it("the saved note is reported by the daily delivery, not stranded as reply-class (review finding 5)", async () => {
    await inNotesDo((n, _ledger, sql) => {
      fillLayer(n, "resident", 2360, 20);
      n.commit({ text: `${"长".repeat(55)}的一条用户偏好`, kind: "preference", source: "user_said", layer: "resident" });
      n.maintenance(Date.now());
      const rows = sql<{ op: string; delivery: string }>`
        SELECT op, delivery FROM sh_note_log WHERE op = 'noted' AND reason = 'user_said' ORDER BY id
      `;
      const saved = rows[rows.length - 1]!;
      expect(saved.delivery).toBe("maintenance"); // rides the daily flush, both halves in one message
    });
  });

  it("the owner's own archive tap leaves no redundant relay clause (review minor)", async () => {
    await inNotesDo((n) => {
      const res = n.commit({ text: "要归档的老偏好", kind: "preference", source: "user_said", layer: "resident" });
      if (!res.ok) throw new Error("fixture failed");
      n.drainPendingForReply(); // the「记住了」rode a reply before the tap
      const done = n.demote(res.note.noteId, 0, "note_archive"); // the card tap's module call
      expect(done.ok).toBe(true);
      // The tap's reply WAS the report: no「长期未用，已移入档案」clause rides the next reply.
      expect(n.renderPendingForReply().text).not.toContain("已移入档案");
      expect(n.pendingChanges()).toHaveLength(0); // the log row exists but is already reported
    });
  });

  it("an undecided suggestion never rides a reply and is never marked by one (review finding 6)", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const res = n.commit({ text: "老全局偏好", kind: "preference", source: "user_said", layer: "resident" });
      if (!res.ok) throw new Error("fixture failed");
      n.drainPendingForReply(); // the fixture's own「记住了」rode a reply before the aging
      sql`UPDATE sh_note SET lastUsedAt = ${Date.now() - 95 * 86_400_000} WHERE noteId = ${res.note.noteId}`;
      n.maintenance(Date.now());

      // A user reply arrives BEFORE the daily flush could send the card: the suggestion
      // clause is absent from the relay (informational rows may ride — the ask may not).
      const rendered = n.renderPendingForReply();
      expect(rendered.text).not.toContain("建议归档");
      expect(rendered.text).not.toContain("已 90 天未用"); // no plain-text swallow
      n.markPendingReported(rendered.upTo);
      const stillPending = sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_note_log WHERE op = 'suggest_demote' AND reportedAt IS NULL
      `[0]!.n;
      expect(stillPending).toBe(1); // still waiting for its decision card

      // The daily flush then delivers it as a card (module side: still pending maintenance).
      expect(n.pendingMaintenance().map((p) => p.op)).toContain("suggest_demote");
    });
  });

  it("maintenance writes the parked request without eviction when room appeared meanwhile", async () => {
    await inNotesDo((n, _ledger, sql) => {
      fillLayer(n, "project", PROJECT_CAP_PER_REPO - 10, 20, "repo-a");
      const refused = n.commit({ text: "用 vitest 跑测试，报告要带截图", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-a" });
      expect(refused.ok).toBe(false);
      // Room appears before the daily pass: the owner removed two entries.
      const rows = n.list({ layer: "project", scopeRepoId: "repo-a" }).slice(0, 2);
      for (const row of rows) n.remove(row.noteId);

      const changes = n.maintenance(Date.now());
      expect(changes.map((c) => c.op)).toEqual(["noted"]);
      expect(changes[0]!.text).toBe("用 vitest 跑测试，报告要带截图");
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
    });
  });

  it("maintenance drops pressure it cannot honour (all pinned) and reports it honestly", async () => {
    await inNotesDo((n, _ledger, sql) => {
      const created = fillLayer(n, "resident", 2360, 20);
      // Room exists while the request lands: the pressure row is recorded.
      const over = n.commit({ text: `${"新".repeat(55)}的一条用户偏好`, kind: "preference", source: "user_said", layer: "resident" });
      expect(over.ok).toBe(false);
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(1);
      // Then the owner pins everything: the room evaporates before the daily pass.
      for (const row of created) n.pin(row.noteId, true);

      const changes = n.maintenance(Date.now());
      expect(changes.map((c) => c.op)).toContain("room_refused");
      expect(sql`SELECT COUNT(*) AS n FROM sh_note_pressure`[0]!.n).toBe(0);
      // Nothing was evicted and every pin held.
      expect(n.list({ layer: "resident" })).toHaveLength(118);
      expect(n.list({ layer: "resident" }).every((row) => row.pinned)).toBe(true);
    });
  });

  it("an ignored-need eviction relay reads in the 「为腾空间我忘了…」 voice", () => {
    const rendered = renderChangeReports([
      { op: "evicted", noteId: "n_a", text: "旧偏好甲", reason: "ignored_needsEviction" },
      { op: "noted", noteId: "n_b", text: "新偏好乙", reason: "user_said" },
    ]);
    expect(rendered).toContain("为腾空间我忘了「旧偏好甲」");
    expect(rendered).toContain("记住了「新偏好乙」");
  });
});

describe("notes daily maintenance: the alarm, the ask, the reports (issue #19)", () => {
  beforeEach(async () => {
    await ownerStub().resetNotesStateForTests();
  });

  /** Runs the daily pass and waits until its outbound rows exist (delivery is async). */
  async function runMaintenanceUntil(pred: (rows: ShOutboundRow[]) => boolean, what: string): Promise<void> {
    await ownerStub().notesMaintenance();
    const deadline = Date.now() + 8000;
    for (;;) {
      // The bookkeeping notice is quiet (issue #11) and waits out its merge window —
      // time-travel it due like waitWhileOutboundPending does, or it never turns "sent".
      await waitWhileOutboundPending();
      const rows = await ownerStub().outboundRows(50);
      if (pred(rows)) return;
      if (Date.now() > deadline) {
        const dump = await runInDurableObject(ownerStub(), (instance: Steward) => {
          const ledger = (instance as unknown as { ledger: Ledger }).ledger;
          const raw = (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(instance);
          return {
            notes: raw`SELECT noteId, layer, lastUsedAt, pinned, status FROM sh_note`,
            log: raw`SELECT id, op, noteId, delivery, reportedAt, ts FROM sh_note_log ORDER BY id`,
            channel: raw`SELECT reason, detail FROM sh_channel_log ORDER BY seq DESC LIMIT 8`,
          };
        });
        throw new Error(`maintenance did not produce: ${what} (rows: ${JSON.stringify(rows.map((r) => r.id))}) state: ${JSON.stringify(dump)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** A resident note whose lastUsedAt is `days` old (closure capture — runInDurableObject
   *  forwards no arguments). */
  async function agedResidentNote(text: string, days: number): Promise<string> {
    return runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({ text, kind: "preference", source: "user_said", layer: "resident" });
      if (!done.ok) throw new Error(done.message);
      ledger.notes.drainPendingForReply();
      const stale = Date.now() - days * 86_400_000;
      (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql`
        UPDATE sh_note SET lastUsedAt = ${stale} WHERE noteId = ${done.note.noteId}
      `;
      return done.note.noteId;
    });
  }

  it("arms exactly one idempotent 02:00 UTC cron; running the pass does not stack another", async () => {
    // Any first RPC into the DO runs onStart, which arms the cron.
    await ownerStub().notesMaintenance();
    const schedules = await ownerStub().notesMaintenanceSchedulesForTest();
    expect(schedules.filter((s) => s.type === "cron" && s.cron === "0 2 * * *")).toHaveLength(1);
    // A second pass (a restart re-running onStart included) dedups onto the same row.
    await ownerStub().notesMaintenance();
    expect((await ownerStub().notesMaintenanceSchedulesForTest()).length).toBe(1);
  });

  it("a 90-day-unused resident note gets an archive-or-keep card — never a demotion; the taps decide", { timeout: 25000 }, async () => {
    const noteId = await agedResidentNote("报告保持简短", 95);
    await runMaintenanceUntil((rows) => rows.some((r) => r.id.startsWith(`noteask:${noteId}:`) && r.status === "sent" && r.providerMsgId), "the ask card (delivered)");

    // The ask went out as its own card, id keyed to the note + log row (no button data).
    const rows = await ownerStub().outboundRows(50);
    const ask = rows.find((r) => r.id.startsWith(`noteask:${noteId}:`) && r.kind === "card");
    expect(ask).toBeDefined();
    expect((await ownerStub().debugSnapshot()).notes.find((n) => n.noteId === noteId)?.layer).toBe("resident");

    // 归档: sinks to the archive, logged, and the reply confirms it is searchable.
    await postEvent({ cardMsgId: ask!.providerMsgId, action: "note_archive" });
    await waitForSentContaining("已归档");
    expect((await ownerStub().debugSnapshot()).notes.find((n) => n.noteId === noteId)?.layer).toBe("archive");
  });

  it("保留 renews the 90-day clock (a renewal, not a pin); the ask does not re-fire", { timeout: 25000 }, async () => {
    const noteId = await agedResidentNote("重活优先给 codex", 95);
    await runMaintenanceUntil((rows) => rows.some((r) => r.id.startsWith(`noteask:${noteId}:`) && r.status === "sent" && r.providerMsgId), "the ask card (delivered)");
    const rows = await ownerStub().outboundRows(50);
    const ask = rows.find((r) => r.id.startsWith(`noteask:${noteId}:`) && r.kind === "card");
    expect(ask).toBeDefined();

    await postEvent({ cardMsgId: ask!.providerMsgId, action: "note_keep" });
    await waitForSentContaining("保留这条记忆");
    const note = (await ownerStub().debugSnapshot()).notes.find((n) => n.noteId === noteId);
    expect(note).toMatchObject({ layer: "resident", pinned: false });
    expect(note!.lastUsedAt).toBeGreaterThan(Date.now() - 60_000);

    // The next pass does not re-ask (the clock restarted — lastUsedAt is fresh again).
    await ownerStub().notesMaintenance();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = (await ownerStub().outboundRows(50)).filter((r) => r.id.startsWith("noteask:"));
    expect(after).toHaveLength(1); // still just the original ask — no re-ask, no duplicate
  });

  it("the daily flush never swallows a pending reply-class row: it still rides the next reply", async () => {
    // An event-run-style write leaves a pending 'noted' row; an aged resident note adds a
    // maintenance-class suggestion. The daily pass delivers only its own class.
    const noteId = await agedResidentNote("重活优先给 codex", 95); // drains its own「记账」
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({ text: "事件轮里记下的一条", kind: "fact", source: "user_said", layer: "resident" });
      if (!done.ok) throw new Error(done.message);
      // deliberately NOT drained: the reply has not happened yet
    });
    await runMaintenanceUntil((rows) => rows.some((r) => r.id.startsWith(`noteask:${noteId}:`) && r.status === "sent"), "the ask card (delivered)");

    const pending = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      return { reply: ledger.notes.pendingChanges().filter((c) => c.text === "事件轮里记下的一条").length };
    });
    expect(pending.reply).toBe(1); // still waiting for the owner's next reply
    // …and when that reply comes, the announcement rides it.
    await scriptModel(fauxAssistantMessage([fauxText("好。")]));
    await dm("知道了", "om_reply_class");
    const reply = await waitForSentContaining("记住了「事件轮里记下的一条」");
    expect(reply).toContain("记账：");
  }, 20000);

  it("one pass delivers at most one batch; the burst is bounded and the rest waits (review finding 7)", async () => {
    // 25 same-vintage stale resident notes: same-vintage staleness is the natural shape
    // (resident lastUsedAt only moves on re-proposal/confirm), not artificial seeding.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      for (let i = 0; i < 25; i += 1) {
        const done = ledger.notes.commit({ text: `偏好${String(i).padStart(4, "0")}号`, kind: "preference", source: "user_said", layer: "resident" });
        if (!done.ok) throw new Error(done.message);
      }
      ledger.notes.drainPendingForReply();
      const stale = Date.now() - 95 * 86_400_000;
      (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql`
        UPDATE sh_note SET lastUsedAt = ${stale} WHERE layer = 'resident'
      `;
    });
    await ownerStub().notesMaintenance();
    await new Promise((r) => setTimeout(r, 400));
    const rows = await ownerStub().outboundRows(60);
    expect(rows.filter((r) => r.id.startsWith("noteask:")).length).toBe(20); // bounded, not 25
    // The remaining 5 suggestions are still pending — tomorrow's pass (or a reply that is
    // not allowed to swallow them) carries them; nothing is dropped.
    const pending = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      return ledger.notes.pendingMaintenance().filter((p) => p.op === "suggest_demote").length;
    });
    expect(pending).toBe(5);
    await ownerStub().notesMaintenance();
    await new Promise((r) => setTimeout(r, 400));
    expect((await ownerStub().outboundRows(60)).filter((r) => r.id.startsWith("noteask:")).length).toBe(25);
  }, 25000);

  it("keep on a note sunk since the card went out: honest reply, no renewal, ask settled (review finding 8)", async () => {
    const noteId = await agedResidentNote("重活优先给 codex", 95);
    await runMaintenanceUntil((rows) => rows.some((r) => r.id.startsWith(`noteask:${noteId}:`) && r.status === "sent" && r.providerMsgId), "the ask card (delivered)");
    const rows = await ownerStub().outboundRows(50);
    const ask = rows.find((r) => r.id.startsWith(`noteask:${noteId}:`) && r.kind === "card")!;
    // The note sinks after the card exists (an eviction at commit time, say).
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql`
        UPDATE sh_note SET layer = 'archive' WHERE noteId = ${noteId}
      `;
    });
    await postEvent({ cardMsgId: ask.providerMsgId, action: "note_keep" });
    await waitForSentContaining("已经不在常驻层");
    const note = (await ownerStub().debugSnapshot()).notes.find((n) => n.noteId === noteId)!;
    expect(note.layer).toBe("archive");
    expect(note.lastUsedAt).toBeLessThan(Date.now() - 86_400_000); // no renewal of a sunk note
  }, 25000);

  it("a suggestion whose note sank before delivery gets no card — the ask settles as gone (review finding 8)", async () => {
    // Seed a real undecided suggestion, then sink its note before any delivery ran.
    const noteId = await agedResidentNote("一条会沉掉的偏好", 95);
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      ledger.notes.maintenance(Date.now()); // logs the suggestion; delivery NOT run yet
      (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql`
        UPDATE sh_note SET layer = 'archive' WHERE noteId = ${noteId}
      `;
    });
    await ownerStub().notesMaintenance(); // nothing new to log; the flush processes the pending row
    await new Promise((r) => setTimeout(r, 400));
    const rows = await ownerStub().outboundRows(50);
    expect(rows.filter((r) => r.id.startsWith(`noteask:${noteId}:`)).length).toBe(0); // no card for a sunk note
    const settled = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const raw = (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(instance);
      return raw`SELECT decision, reportedAt FROM sh_note_log WHERE op = 'suggest_demote'`[0] ?? null;
    });
    expect(settled).toMatchObject({ decision: "note_gone", reportedAt: expect.any(Number) });
  }, 25000);

  it("maintenance reports its own actions (demotions, evictions) proactively — one coalesced message", async () => {
    // A 70-day-stale project note (auto-demoted) + ignored pressure (evicted-for + noted).
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({ text: "老的仓库约定", kind: "convention", source: "user_said", layer: "project", scopeRepoId: "repo-old" });
      if (!done.ok) throw new Error(done.message);
      ledger.notes.drainPendingForReply();
      const stale = Date.now() - 70 * 86_400_000;
      (instance as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql`
        UPDATE sh_note SET lastUsedAt = ${stale} WHERE noteId = ${done.note.noteId}
      `;
    });
    await runMaintenanceUntil((rows) => rows.some((r) => r.id.startsWith("notechg:") && r.status === "sent"), "the bookkeeping notice (delivered)");

    const sent = await ownerStub().outboundRows(50);
    const notice = sent.find((r) => r.id.startsWith("notechg:") && r.status === "sent");
    expect(notice).toBeDefined();
    const payload = JSON.parse(notice!.payload as string) as { text?: string };
    expect(payload.text).toContain("已移入档案");

    // Once sent, the rows are marked — a later user reply does not repeat the announcement.
    await scriptModel(fauxAssistantMessage([fauxText("好。")]));
    await dm("知道了");
    await waitRunsSettled();
    const replies = (await ownerStub().outboundRows(50)).filter((r) => r.kind === "text" && r.status === "sent");
    expect(replies.some((r) => (JSON.parse(r.payload as string) as { text?: string }).text?.includes("老的仓库约定 已移入档案") ?? false)).toBe(false);
    expect(replies.some((r) => r.id.startsWith("notechg:"))).toBe(true); // the notice itself is untouched
  });
});
