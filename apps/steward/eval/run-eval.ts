// Routing eval runner (issue #7, steward.md §3.4, ADR-0001 decision 14): each of the 106
// ported cases gets a fresh in-memory world, then the real steward extension runs against
// the real model. The outcome (attach:X / new / ask / chat) is scored against the label.
//
// Usage:
//   node eval/run-eval.ts [--limit N] [--only id,id] [--model deepseek-flash] [--out file] [--concurrency 4]
//   node eval/run-eval.ts --selftest        # no model, no key: world/recall/gate/scoring checks
//
// The API key: DEEPSEEK_API_KEY from the env; as a dev-machine fallback, the `deepseek`
// entry of ~/.pi/agent/auth.json (never printed). Exit code: 0 only when the §3.4
// thresholds are met — this is the required merge check for routing changes (ADR-0001
// decision 14; see docs/routing-eval.md).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { buildStewardExtension } from "../src/llm/extension.ts";
import { buildStewardModels } from "../src/llm/models.ts";
import {
  CASES,
  THREADS,
  buildEvalContext,
  openSeededLedger,
  outcomeOf,
  score,
  type Case,
  type Observation,
  type Outcome,
} from "./harness.ts";
import { RECALL_WEAK_BELOW, recallScore } from "../src/ledger.ts";

// §3.4's bar — the gate this script enforces on exit.
const THRESHOLDS = { wrongRoute: 0.02, missedAsk: 0.03, unnecessaryAsk: 0.15 } as const;

// ---- args ----
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIMIT = Number(arg("limit") ?? 0);
const ONLY = arg("only")?.split(",").map(Number);
/** `--endpoint '{"id":"magpie","baseUrl":"http://…","apiKey":"…","model":"zhipu/glm-5.3-flash"}'`
 *  routes the eval at any OpenAI-compatible endpoint instead of the catalog provider. */
interface EndpointOverride {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
}
const ENDPOINT = arg("endpoint") ? (JSON.parse(arg("endpoint")!) as EndpointOverride) : undefined;
const MODEL_ID = arg("model") ?? ENDPOINT?.model ?? "deepseek-flash";
const PROVIDER_ID = ENDPOINT?.id ?? "deepseek";
const OUT = arg("out") ?? `eval/results/${new Date().toISOString().slice(0, 19).replaceAll(/[:T]/g, "")}.json`;
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const SELFTEST = process.argv.includes("--selftest");

// ---- api key: env first, then the dev machine's pi auth store ----
function apiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth.deepseek;
    if (typeof entry === "string") return entry;
    // The store keeps credential objects ({type: "api_key", key}); unwrap the key.
    if (entry !== null && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
      return (entry as { key: string }).key;
    }
  } catch {
    // fall through
  }
  throw new Error("DEEPSEEK_API_KEY not set (env, or ~/.pi/agent/auth.json's deepseek entry)");
}

type AssistantEntry = { model?: Array<{ role?: string; content?: unknown }> };
const assistantTextOf = (entry: unknown): string => {
  const message = (entry as AssistantEntry | undefined)?.model?.[0];
  if (message?.role !== "assistant") return "";
  const content = message.content;
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  return parts.flatMap((part) => ((part as { type?: string })?.type === "text" ? [(part as { text?: string }).text ?? ""] : [])).join("");
};

// The provider collection is built once; every case's harness shares it — only the registry
// (world + observation) differs per case. With `--endpoint`, any OpenAI-compatible endpoint
// (local router, proxy, self-hosted) stands in for the catalog provider.
let sharedModels: MutableModels | undefined;

async function buildProvider(): Promise<MutableModels> {
  if (ENDPOINT === undefined) {
    return buildStewardModels({ provider: PROVIDER_ID, modelId: MODEL_ID, explicit: true }, apiKey()).models;
  }
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  const provider = createProvider({
    id: ENDPOINT.id,
    name: ENDPOINT.id,
    baseUrl: ENDPOINT.baseUrl,
    auth: {
      apiKey: {
        name: `${ENDPOINT.id} API key`,
        resolve: async () =>
          ENDPOINT.apiKey ? { auth: { apiKey: ENDPOINT.apiKey }, source: "eval endpoint" } : undefined,
      },
    },
    models: [{ id: MODEL_ID, provider: ENDPOINT.id, name: MODEL_ID, baseUrl: ENDPOINT.baseUrl, contextWindow: 128_000, maxTokens: 8_192, api: "openai-completions", type: "chat", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: true, maxTokensField: "max_tokens" } }],
    api: openAICompletionsApi(),
  } as never) as Provider;
  const models = createModels();
  models.setProvider(provider);
  return models;
}

async function runCase(c: Case): Promise<{ outcome: Outcome; reply: string; dispatches: number; asksWithCandidates: number }> {
  const { ledger } = openSeededLedger(Date.now());
  const observation: Observation = { asks: [], dispatches: [] };
  const registry = createRegistry();
  registry.install(buildStewardExtension(buildEvalContext(ledger, c.id, observation)));
  sharedModels ??= await buildProvider();
  const harness = await Harness.open(new MemoryStorage(), { models: sharedModels, registry }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } } });
    const settled = await Promise.race([
      (await conversation.submit({ type: "input", content: c.text, whenBusy: "followUp" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("case timeout")), 150_000)),
    ]);
    if (settled.status !== "done" || settled.type !== "input") {
      return {
        outcome: { kind: "error", reason: (settled as { reason?: string }).reason ?? settled.status },
        reply: "",
        dispatches: observation.dispatches.length,
        asksWithCandidates: observation.asks.filter((a) => a.candidates.length > 0).length,
      };
    }
    const page = await conversation.entries(
      { minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, BACKGROUND_CONTEXT,
    );
    const reply = assistantTextOf(page.items[0]).slice(0, 200);
    return {
      outcome: outcomeOf(observation),
      reply,
      dispatches: observation.dispatches.length,
      asksWithCandidates: observation.asks.filter((a) => a.candidates.length > 0).length,
    };
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}

// ---- selftest: deterministic, no model, no key ------------------------------------------------------

/** One scripted faux-model conversation over a fresh world: what the tools returned + did. */
async function gateCheck(steps: unknown[], input: string): Promise<{ toolResults: string[]; observation: Observation }> {
  const { ledger } = openSeededLedger(Date.now());
  const observation: Observation = { asks: [], dispatches: [] };
  const built = buildStewardModels({ provider: "faux", modelId: "faux-1", explicit: true }, undefined);
  const registry = createRegistry();
  registry.install(buildStewardExtension(buildEvalContext(ledger, 999, observation)));
  const harness = await Harness.open(new MemoryStorage(), { models: built.models, registry }, BACKGROUND_CONTEXT);
  try {
    // root() creates the conversation with the agent config in one commit.
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    built.faux!.setSteps(steps as never[]);
    await conversation!.submit({ type: "input", content: input }, BACKGROUND_CONTEXT).then((s) => s.wait(BACKGROUND_CONTEXT));
    return { toolResults: [...built.faux!.requests()].map((r) => r.lastToolResult), observation };
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}

async function selftest(): Promise<void> {
  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  // 1. world seeding
  const now = Date.now();
  const { ledger } = openSeededLedger(now);
  const threads = ledger.threads.list();
  check("world has every dataset thread", threads.length === THREADS.length, `${threads.length}/${THREADS.length}`);
  const running = threads.filter((t) => t.state === "running").length;
  const waiting = threads.filter((t) => t.state === "waiting_you").length;
  const idle = threads.filter((t) => t.state === "idle").length;
  const want = (state: string) =>
    THREADS.filter((t) => (state === "idle" ? t.state.startsWith("idle") : t.state === state)).length;
  check(
    "derived states match the dataset",
    running === want("running") && waiting === want("waiting") && idle === want("idle"),
    `running ${running}/${want("running")} waiting ${waiting}/${want("waiting")} idle ${idle}/${want("idle")}`,
  );

  // 2. recall: labeled attach cases — the assembly's invariant is that a STRONG scorer
  //    (recall score ≥ the weak band) never misses the candidate set; weak scorers may
  //    (the 12-cap and the brief cover them), and that is printed, not failed.
  const attachCases = CASES.filter((c) => c.expect.kind === "attach");
  let inSet = 0;
  let strongMisses = 0;
  const misses: string[] = [];
  for (const c of attachCases) {
    const world = openSeededLedger(now);
    const candidates = world.ledger.threads.findCandidates({ text: c.text }).candidates;
    const expected = (c.expect as { threadId: string }).threadId;
    const rank = candidates.findIndex((candidate) => candidate.threadId === expected);
    if (rank >= 0) inSet++;
    else {
      const thread = THREADS.find((t) => t.id === expected)!;
      const hay = `${thread.title} ${thread.goal} ${thread.summary ?? ""}`;
      const strong = recallScore(c.text, hay) >= RECALL_WEAK_BELOW;
      if (strong) strongMisses++;
      misses.push(`#${c.id}${strong ? "(强)" : ""} ${c.text}`);
    }
  }
  check("recall: strong scorers never miss the set", strongMisses === 0, `${strongMisses} strong misses of ${attachCases.length}`);
  console.log(`    in-set ${inSet}/${attachCases.length}; weak misses: ${misses.filter((m) => !m.includes("(强)")).join("; ") || "none"}`);

  // 3. explicit short-circuit (§3.2 signal 1)
  const explicit = openSeededLedger(now).ledger.threads.findCandidates({
    text: "接着继续",
    explicitThreadId: "t_login_style",
  });
  check(
    "explicit signal short-circuits",
    explicit.confidence === "explicit" && explicit.explicitThread?.threadId === "t_login_style",
  );
  // §3.2 signal 2: naming the title
  const titled = openSeededLedger(now).ledger.threads.findCandidates({ text: "把「定时清理临时文件」那个任务的保留期改成 7 天" });
  check(
    "a titled mention short-circuits",
    titled.confidence === "explicit" && titled.explicitThread?.threadId === "t_cron",
  );

  // 4. the confidence gate, in-process with the scripted faux provider
  const noRouting = await gateCheck(
    [
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再改改", repoRef: "repo-eval", threadId: "t_login_bug", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好。")]),
    ],
    "登录页那个再改改",
  );
  check(
    "gate: attach without routing is blocked",
    noRouting.toolResults.some((r) => r.includes("routing")) && noRouting.observation.dispatches.length === 0,
    noRouting.observation.dispatches.length === 0 ? "blocked, no dispatch" : "DISPATCHED despite gate",
  );

  const medium = await gateCheck(
    [
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再改改", repoRef: "repo-eval", threadId: "t_login_bug", basis: "user_explicit", routing: { confidence: "medium", reason: "可能是它" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好。")]),
    ],
    "登录页那个再改改",
  );
  check(
    "gate: medium confidence is blocked",
    medium.toolResults.some((r) => r.includes("不允许非 high")) && medium.observation.dispatches.length === 0,
    medium.observation.dispatches.length === 0 ? "blocked, no dispatch" : "DISPATCHED despite gate",
  );

  const high = await gateCheck(
    [
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再改改", repoRef: "repo-eval", threadId: "t_login_bug", basis: "user_explicit", routing: { confidence: "high", reason: "话语点名登录页报错" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂到登录页报错那件事。")]),
    ],
    "登录页那个 500 报错再改改",
  );
  check(
    "gate: high confidence dispatches",
    high.observation.dispatches.length === 1 && high.observation.dispatches[0]!.threadId === "t_login_bug",
  );

  // Review #48 finding 1: signal 2 — find_threads' explicit short-circuit (a deterministic
  // title/id/hint hit) must exempt the attach exactly like a reply/button route does;
  // before the fix the prompt promised this and the gate rejected it (0 dispatches).
  const signal2 = await gateCheck(
    [
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "把「定时清理临时文件」的保留期改成 7 天" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "保留期改成 7 天", repoRef: "repo-eval", threadId: "t_cron", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂上。")]),
    ],
    "把「定时清理临时文件」的保留期改成 7 天",
  );
  check(
    "gate: find_threads explicit (signal 2) attaches without routing",
    signal2.observation.dispatches.length === 1 && signal2.observation.dispatches[0]!.threadId === "t_cron",
    signal2.observation.dispatches.length === 1 ? "dispatched, gate exempt" : "BLOCKED — the gate rejected the explicit hit",
  );

  // 5. scoring
  check("scoring: wrong route", score({ kind: "attach", threadId: "t_a" }, { kind: "attach", threadId: "t_b", isNew: false }, "") === "wrong_route");
  check("scoring: missed ask", score({ kind: "ask" }, { kind: "chat" }, "好的我明白了") === "missed_ask");
  check("scoring: unnecessary ask", score({ kind: "new" }, { kind: "ask" }, "") === "unnecessary_ask");
  check("scoring: text-ask counts as asking", score({ kind: "ask" }, { kind: "chat" }, "你要哪一件？A 还是 B") === "pass_text_ask");

  console.log(failures === 0 ? "\nselftest OK" : `\nselftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- main ----
if (SELFTEST) {
  await selftest();
} else {
  const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id)).slice(0, LIMIT || undefined);
  console.error(`routing eval: ${cases.length} cases, model ${MODEL_ID}, concurrency ${CONCURRENCY}`);

  const results: Array<Case & { outcome: Outcome; verdict: string; reply: string; dispatches: number; ms: number }> = [];
  let done = 0;
  const queue = [...cases];
  async function worker(): Promise<void> {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const t0 = Date.now();
      let r = await runCase(c).catch(
        (err): { outcome: Outcome; reply: string; dispatches: number; asksWithCandidates: number } => ({
          outcome: { kind: "error", reason: err instanceof Error ? err.message : String(err) },
          reply: "", dispatches: 0, asksWithCandidates: 0,
        }),
      );
      if (r.outcome.kind === "error" && !/timeout/.test(r.outcome.reason)) r = await runCase(c); // one retry on transient errors
      const verdict = score(c.expect, r.outcome, r.reply);
      results.push({ ...c, outcome: r.outcome, verdict, reply: r.reply, dispatches: r.dispatches, ms: Date.now() - t0 });
      done++;
      console.error(
        `[${done}/${cases.length}] #${c.id} expect=${JSON.stringify(c.expect)} got=${JSON.stringify(r.outcome)} -> ${verdict} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const n = results.length || 1;
  const by = (v: string) => results.filter((r) => r.verdict === v);
  const asks = results.filter((r) => r.expect.kind === "ask").length;
  const nonAsks = results.length - asks;
  const wrongRoute = by("wrong_route").length;
  const missedAsk = by("missed_ask").length;
  const unask = by("unnecessary_ask").length;
  const errors = by("error").length;
  const wrongRouteRate = wrongRoute / n;
  const missedAskRate = asks ? missedAsk / asks : 0;
  const unaskRate = nonAsks ? unask / nonAsks : 0;
  console.log(`
路由评测结果（n=${results.length}, model=${MODEL_ID}）
  pass            ${by("pass").length + by("pass_text_ask").length}  (${(((by("pass").length + by("pass_text_ask").length) / n) * 100).toFixed(1)}%)  (其中文字反问 ${by("pass_text_ask").length})
  错路由          ${wrongRoute}  (${(wrongRouteRate * 100).toFixed(1)}%)  目标 <${THRESHOLDS.wrongRoute * 100}%
  应反问未反问    ${missedAsk}  (${(missedAskRate * 100).toFixed(1)}% of ${asks} ask-cases)  目标 <${THRESHOLDS.missedAsk * 100}%
  不必要反问      ${unask}  (${(unaskRate * 100).toFixed(1)}% of ${nonAsks} non-ask)  目标 <${THRESHOLDS.unnecessaryAsk * 100}%
  错误/超时       ${errors}
`);
  if (wrongRoute + missedAsk + unask + errors > 0) {
    console.log("失败明细:");
    for (const r of results.filter((x) => x.verdict !== "pass")) {
      console.log(`  #${r.id} [${r.verdict}] "${r.text}"  expect=${JSON.stringify(r.expect)} got=${JSON.stringify(r.outcome)}${r.note ? `  (${r.note})` : ""}`);
      if (r.reply) console.log(`      reply: ${r.reply.replace(/\n/g, " ").slice(0, 140)}`);
    }
  }

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        model: MODEL_ID,
        at: new Date().toISOString(),
        thresholds: THRESHOLDS,
        summary: { n: results.length, pass: by("pass").length, passTextAsk: by("pass_text_ask").length, wrongRoute, missedAsk, unnecessaryAsk: unask, errors },
        results,
      },
      null,
      1,
    ),
  );
  console.error(`results -> ${OUT}`);

  const gatePass =
    wrongRouteRate < THRESHOLDS.wrongRoute &&
    missedAskRate < THRESHOLDS.missedAsk &&
    unaskRate < THRESHOLDS.unnecessaryAsk &&
    errors === 0;
  console.log(gatePass ? "阈值达标（ADR-0001 decision 14）" : "未达阈值：合并前必须修复或重跑");
  process.exit(gatePass ? 0 : 1);
}
