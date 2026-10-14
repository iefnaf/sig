# Steward M2: the steward as a pi-durable extension

The LLM part of the steward, packaged as an extension so the same code runs in-process against the faux model (`test/`) and inside the e2e Durable Object (`../e2e`).

- `src/steward.ts` — tools (`find_threads`, `get_thread`, `update_thread`, `start_worker`, `ask_user`, `no_action`), the autonomy policy hook, and the role prompt. `StewardContext` keeps dispatch/ask behind an interface.
- `src/brief.ts` — the situation brief injected as a per-request prompt section.
- `eval/` — the routing eval (steward.md §3.4). See below.

## Routing eval

A fixed world of 24 threads (ambiguity clusters for 登录/首页/api-gateway, states running / waiting_you / idle+unread / idle-clean, ages up to 14 days) and 100 labeled utterances: attach to a thread (45), create new (20), must ask (11~13), converse/answer-from-memory (rest). Each case runs the real extension against the real model in a fresh in-memory world.

```
npm run eval                       # full run
node eval/run-eval.ts --only 61,63 # subset while iterating
```

DEEPSEEK_API_KEY comes from the env or `../e2e/.dev.vars` (gitignored). Results land in `eval/results/`; the committed `baseline-deepseek-flash.json` is the reference run.

Baseline (deepseek-flash, 2026-10-14): best run 96% pass — 错路由 1%, 不必要反问 1.1%; across later runs 88-93% with 错路由 up to 7%. The residual is model nondeterminism (temperature is not pinned through the harness) plus utterances defensible under either label (e.g. 「把登录的几件事都收尾一下」). Regression protocol: a single run decides nothing — rerun 2-3 times and look for clusters of the same failure shape (tokenization, ask calibration, double dispatch all moved the numbers by 20+ points when broken; noise moves them by ~5).

What the eval caught and fixed (keep regressing on any model/prompt/candidate-assembly change):

1. **Chinese tokenization**: whitespace-split token matching never matched Chinese titles («依赖升级» vs «升级依赖»). `find_threads` now scores character-bigram overlap + latin-word matches, marks `weak: true` below a cutoff.
2. **Ask calibration**: the first prompt asked whenever unsure → 21 unnecessary asks. The rules now rank: no match → create; one clear match → attach; equal multiple / no referent → ask. Text-asks that list candidates count as asking (`pass_text_ask`) but the tool (`ask_user`, buttons) is the product behavior.
3. **One dispatch per run**: deepseek-flash sometimes dispatched a placeholder then corrected itself; the guard blocks a second `start_worker` for a different thread in the same run.
4. **Narrating without calling**: flash occasionally claims 已派发 in prose without calling the tool (rule 4 in the prompt pushes back; a settle-time verify pass is the real fix, M3).
