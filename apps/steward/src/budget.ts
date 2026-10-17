// Daily steward spend (issue #28, steward.md §12). pi.usage is cumulative and includes
// failed attempts and compaction, so the day's spend is the GROWTH of that total between
// observations: one cursor row, one transaction per reading, and every decision point
// (wake drain, run settle, spend readout) brings it current before it reads.
import type { UsageState } from "@earendil-works/pi-durable";
import type { LedgerDeps } from "./ledger.ts";

/** steward.md §12: unset deploy config gets this cap — far above a normal day's spend.
 *  docs/deploy.md: a moderately active day is single-digit cents, a heavy month a few dollars. */
export const DEFAULT_DAILY_BUDGET_USD = 1;

export interface BudgetConfig {
  usd: number;
  /** Set when DAILY_BUDGET_USD was present but unusable — logged, then the default applies. */
  error?: string;
}

/** `vars.DAILY_BUDGET_USD` (root wrangler.jsonc): dollars per UTC day. Zero disables the
 *  automatic wakes entirely (only owner messages reach the model) — the honest reading of a
 *  "0" cap. A very large number is how to say "effectively off"; a typo never widens it. */
export function resolveBudgetConfig(raw: unknown): BudgetConfig {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { usd: DEFAULT_DAILY_BUDGET_USD };
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(value) && value >= 0) return { usd: value };
  return {
    usd: DEFAULT_DAILY_BUDGET_USD,
    error: `DAILY_BUDGET_USD 必须是 ≥0 的美元数（收到 ${JSON.stringify(raw)}），已按默认 $${DEFAULT_DAILY_BUDGET_USD}/天处理`,
  };
}

/** The UTC calendar date of `at` — the day the counter and the note reset at 00:00 UTC. */
export const budgetDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export interface UsageTotals {
  costUsd: number;
  tokens: number;
}

const positive = (n: number): number => Number.isFinite(n) && n > 0 ? n : 0;

export function sumUsage(state: Readonly<UsageState>): UsageTotals {
  const total = { costUsd: 0, tokens: 0 };
  for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
    total.costUsd += positive(usage.cost.total);
    total.tokens += positive(usage.totalTokens);
  }
  return total;
}

export interface BudgetState extends UsageTotals {
  day: string;
  budgetUsd: number;
  over: boolean;
  resetsAt: number;
  skippedWakes: number;
  overNotedAt: number | null;
}

export function createBudget({ sql, tx, now = Date.now }: LedgerDeps) {
  return {
    /**
     * Folds pi's *cumulative* session usage into today's counter; whatever grew since the
     * last observation is today's spend. Safe by construction: the read-to-write delta and
     * the cursor update are one transaction (concurrent observations serialize there, so a
     * stale reading cannot land after a newer one), a repeated total adds nothing, and a
     * total BELOW the cursor is ignored — pi's ledger only ever grows (README "Usage and
     * Cost"), so that is a stale read, never negative spend. Spend is attributed to the
     * observation's day, which the decision-point syncs keep within a poll of the spend.
     *
     * The FIRST observation ever only seeds the cursor: a deployment upgrading to #28 may
     * carry weeks of pi.usage history, and charging it to upgrade day would trip the cap
     * with a lie. `resetCursorForTests` re-seeds from zero for the same invariant in tests.
     */
    observe(total: UsageTotals, at = now()): void {
      tx(() => {
        const prev = sql<UsageTotals>`SELECT costUsd, tokens FROM sh_usage_cursor WHERE id = 1`[0];
        const costUsd = Math.max(prev?.costUsd ?? 0, total.costUsd);
        const tokens = Math.max(prev?.tokens ?? 0, total.tokens);
        const costDelta = costUsd - (prev?.costUsd ?? costUsd);
        const tokenDelta = tokens - (prev?.tokens ?? tokens);
        sql`
          INSERT INTO sh_usage_cursor (id, costUsd, tokens, updatedAt) VALUES (1, ${costUsd}, ${tokens}, ${at})
          ON CONFLICT (id) DO UPDATE SET costUsd = excluded.costUsd, tokens = excluded.tokens, updatedAt = excluded.updatedAt
        `;
        if (!(costDelta > 0) && !(tokenDelta > 0)) return;
        sql`
          INSERT INTO sh_usage_day (day, costUsd, tokens, updatedAt) VALUES (${budgetDay(at)}, ${costDelta}, ${Math.max(0, tokenDelta)}, ${at})
          ON CONFLICT (day) DO UPDATE SET costUsd = costUsd + excluded.costUsd, tokens = tokens + excluded.tokens, updatedAt = excluded.updatedAt
        `;
      });
    },

    state(config: BudgetConfig, at = now()): BudgetState {
      const day = budgetDay(at);
      const row = sql<UsageTotals & { skippedWakes: number; overNotedAt: number | null }>`
        SELECT costUsd, tokens, skippedWakes, overNotedAt FROM sh_usage_day WHERE day = ${day}
      `[0] ?? { costUsd: 0, tokens: 0, skippedWakes: 0, overNotedAt: null };
      return {
        ...row, day, budgetUsd: config.usd, over: row.costUsd >= config.usd,
        resetsAt: Date.parse(`${day}T00:00:00Z`) + 86_400_000,
      };
    },

    recordSkip(at = now()): void {
      sql`
        INSERT INTO sh_usage_day (day, skippedWakes, updatedAt) VALUES (${budgetDay(at)}, 1, ${at})
        ON CONFLICT (day) DO UPDATE SET skippedWakes = skippedWakes + 1, updatedAt = excluded.updatedAt
      `;
    },

    /** Call in the same transaction that enqueues the daily notice. */
    markNoted(day: string, at = now()): void {
      sql`
        INSERT INTO sh_usage_day (day, overNotedAt, updatedAt) VALUES (${day}, ${at}, ${at})
        ON CONFLICT (day) DO UPDATE SET overNotedAt = COALESCE(overNotedAt, excluded.overNotedAt), updatedAt = excluded.updatedAt
      `;
    },

    /** Attributes spend to the day containing `at` directly — no cursor movement (tests). */
    add(delta: UsageTotals, at: number): void {
      if (!(delta.costUsd > 0) && !(delta.tokens > 0)) return;
      sql`
        INSERT INTO sh_usage_day (day, costUsd, tokens, updatedAt)
        VALUES (${budgetDay(at)}, ${delta.costUsd}, ${delta.tokens}, ${at})
        ON CONFLICT (day) DO UPDATE SET
          costUsd = costUsd + excluded.costUsd, tokens = tokens + excluded.tokens, updatedAt = excluded.updatedAt
      `;
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

export function formatTokens(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The explicit spend query is free and reads the persisted counter, even without a model. */
export function renderSpendStatus(state: BudgetState): string {
  return [
    `今日（${state.day}，UTC）总管模型花费估算：${formatUsd(state.costUsd)} / 每日预算 ${formatUsd(state.budgetUsd)}，共 ${formatTokens(state.tokens)} tokens。`,
    state.over
      ? `已达到每日软上限，今天已跳过 ${state.skippedWakes} 次自动唤醒。完成汇报、失败提醒、汇总卡片和对你消息的回复照常。`
      : "预算内，一切照常。",
    ...(state.costUsd === 0 && state.tokens > 0
      ? ["注意：当前模型报告的价格为 $0（目录无定价或免费模型），预算不会触发；请按 token 数自行估算。"]
      : []),
    "每天 00:00 UTC 重置；仅统计总管的模型调用，按模型报告的用量和价格估算，不含机器上编码 agent 或 Cloudflare 的费用。",
  ].join("\n");
}

export function renderOverBudgetNote(state: BudgetState): string {
  return `⚠️ 今日模型花费估算 ${formatUsd(state.costUsd)} 已达到每日预算 ${formatUsd(state.budgetUsd)}：到 00:00 UTC 重置前，worker 事件、例行任务和定时回看不再唤醒总管；完成汇报、失败提醒和汇总卡片照常，你的消息仍会处理。发「/花费」可查看详情。`;
}

/** Whole-message matches only: a spending question must never swallow a compound task. */
export function isSpendQuery(text: string): boolean {
  const bare = text.trim().replace(/[?？。.!！]+$/u, "").toLowerCase().replace(/\s+/g, " ");
  if (/^\/(?:花费|用量|预算|spend|usage|budget)$/.test(bare)) return true;
  if (/^how much(?: (?:have you spent|did you spend|have we spent|did we spend))?(?: so far)? today$/.test(bare)) return true;
  if (/^(?:what(?:'s| is) )?today'?s (?:spend|spending|usage|budget|cost)$/.test(bare)) return true;
  const zh = bare.replace(/\s+/g, "");
  return (
    /^(?:请问)?(?:你|总管)?(?:今天|今日)(?:一共|总共|已经)?(?:花|用|消耗)了?多少(?:钱|费用|美元|tokens?)?$/.test(zh) ||
    /^(?:今天|今日)的?(?:花费|开销|费用|用量|预算)(?:是多少|多少|还剩多少|剩多少)?$/.test(zh)
  );
}
