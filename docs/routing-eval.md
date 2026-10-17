# The routing eval (issue #7, steward.md §3.4, ADR-0001 decision 14)

Routing is the core of the product's value: attaching an utterance to the right Thread,
creating a new one, or asking — never guessing. Any change to **the steward prompt, the tool
definitions, `threads.findCandidates`, or the model** must run this eval and meet the
thresholds before merge. Regular CI stays deterministic-only; this gate runs on demand
(it spends real model tokens).

## Running it

```bash
cd apps/steward

pnpm eval:routing                     # the 106 ported cases against deepseek-flash
pnpm eval:routing:selftest            # no model, no key: world/recall/gate/scoring checks
node eval/run-eval.ts --only 61,63    # a subset while iterating
node eval/run-eval.ts --limit 20      # the first N
```

The API key resolution order: `DEEPSEEK_API_KEY` in the env, then the `deepseek` entry of
`~/.pi/agent/auth.json` (the dev machine's pi credential store; never printed). Changing the
default model (ADR-0001 decision 11) means re-running this against the new default.

Any OpenAI-compatible endpoint can stand in for the catalog provider — a local router, a
proxy, a self-hosted server:

```bash
node eval/run-eval.ts --endpoint '{"id":"magpie","baseUrl":"http://127.0.0.1:3425/v1","apiKey":"…","model":"zhipu/glm-5.3-flash"}'
```

Results land in `eval/results/` as JSON (committed files are named baselines; timestamped
ones are ad-hoc). **Exit code 0 only when all three thresholds are met** — wire it into the
merge check as `pnpm --filter @shepherd/steward eval:routing`.

## The metrics (steward.md §3.4)

| Metric | Definition | Target |
|---|---|---|
| 错路由 wrong-route | auto-attached/created on the wrong target, or dispatched during pure chat | < 2% |
| 应反问未反问 missed-ask | should have asked, but attached/created/conversed instead | < 3% of the ask-labeled cases |
| 不必要反问 unnecessary-ask | asked when the label had a definite route | < 15% of the non-ask cases |

Each case runs the real steward extension (`find_threads`, the confidence gate, `ask_user`)
in a fresh in-memory world seeded from `eval/dataset.ts` — the 106-case set ported verbatim
from `spike-final` (ADR-0001 decision 1), labels A–G plus the relay cluster 101–106
(spike bug 11: 「按 X 方案实施」 attaches to the plan-producing thread). A prose reply that
lists candidates counts as asking (`pass_text_ask`) — the tool with buttons is the product
behavior, text-asking is not a routing failure — but it is reported so it stays visible.

## Recorded runs

### Default-model baseline: `deepseek-flash-baseline.json` (+ `-confirm`), 2026-10-17

**The gate is green on the default model** — three runs on the final tree, all three thresholds
met (ADR-0001 decision 14):

| Run | pass | wrong-route | missed-ask | unnecessary-ask |
|---|---|---|---|---|
| `deepseek-flash-baseline.json` | 93+1/106 (88.7%) | 1 (0.9%) ✓ | 0/11 ✓ | 11/95 (11.6%) ✓ |
| `deepseek-flash-baseline-confirm.json` | 92+2/106 (88.7%) | 0 (0.0%) ✓ | 0/11 ✓ | 12/95 (12.6%) ✓ |

(+1/+2 are 文字反问 `pass_text_ask`, counted as pass.) Getting the first real-model baseline
took three fixes, all found by these runs:

1. **Tool schema** (`llm/extension.ts`): `notes_commit` parameters used `Type.Intersect`,
   which serializes as bare `allOf` with no top-level `type: "object"` — DeepSeek rejects
   that with 400 (`schema must be a JSON Schema of 'type: "object"', got 'type: null'`),
   failing **every** turn on the default model. Replaced with a merged `Type.Object`.
2. **Eval harness relay wiring** (`eval/harness.ts`): `buildEvalContext` never wired
   `sendToWorker`/`interruptWorker`, so attach-and-steer — the labeled outcome for the
   imperative follow-up cases — threw `ctx.sendToWorker is not a function` and scored as
   `chat` (a 4.7% wrong-route artifact; 0–0.9% after). Same class: `routines` (create /
   set_followup / suggest / cancel / pause) was missing too, so "写完提醒我 review" failed
   with `setFollowup 未定义` instead of recording its route. `eval/` is outside tsconfig's
   include, which is why the gaps never surfaced at typecheck — worth remembering when
   extending the context interface.
3. **Prompt rule** (rule 2, `llm/extension.ts`): symptom/investigation utterances
   （「有点慢，帮我看看」） hung on a self-chosen thread with a read-only worker as the
   justification. The owner's product call: **uncertainty asks — read-only diagnosis is not
   an exemption** (the findings would land in the wrong thread's context). Added to rule 2:
   a symptom that could originate from several threads of one topic is the "multiple
   candidates match" case → `ask_user`; a request for a full sweep is new work → new thread.
   This flipped #63 (the only missed-ask) to ask and, as a side effect, fixed #75
   （全面排查 → 新开）.

The residual failure cluster is unnecessary-ask only (11–12/95, stable across runs): the
same label-edge cases below, every one carrying a dataset note marking it defensible.
Spike baseline for comparison (deepseek-flash, 2026-10-14): 94.3% pass, wrong-route 1.9%,
missed asks 0%, unnecessary 4.2% — with documented run-to-run variance of 88–93% (the spike
README's regression protocol: a single run decides nothing; rerun and look for failure
clusters). The two committed runs are that rerun.

### Local-router runs (2026-10-16, pre-harness-fix)

Before a valid DeepSeek key was available, three runs went through a local OpenAI-compatible
router (`--endpoint`), same world, same prompts — but **before the harness wiring above**, so
their wrong-route numbers carry the same chat-instead-of-relay artifact (missed-ask is
unaffected; that path never involved the relay tools):

| Run (file in `eval/results/`) | pass | wrong-route | missed-ask | unnecessary-ask |
|---|---|---|---|---|
| `baseline-group-never-stuck.json` (strongest local model) | 98/106 (92.5%) | 1.9% ✓ | 2/11 (18.2%) ✗ | 4.2% ✓ |
| `glm-5.3-full.json` | 95/106 (89.6%) | 2.8% ✗ | 2/11 (18.2%) ✗ | 6.3% ✓ |
| `glm-5.3-flash-full-v2.json` | 95/106 (89.6%) | 3.8% ✗ | 2/11 (18.2%) ✗ | 5.3% ✓ |

The runner's headline counts `pass + pass_text_ask` (the two glm runs are 93 + 2 — the 2 are
文字反问, listed separately in each JSON's `summary`); an earlier revision of this table
double-counted them as "95+2".

**The gate is green on the default model** (see the baseline table above): the 2026-10-17
prompt rule resolved #63 — uncertainty asks, read-only diagnosis is not an exemption — and
both committed runs meet all three thresholds. The local-router runs below predate the
harness wiring and stay red; they are kept for history, not as gates.

### The persistent cluster

The local-router runs miss the same handful, and the dataset's own notes mark them defensible
under either label (the default-model baseline carries the same cluster as its residual):

- **#63 「网关那边有点慢」** (label: ask) — two gateway threads exist, but the model argues a
  performance investigation is neither the running refactor nor the logging thread, and
  dispatches a new one. Label note itself says the cluster is ambiguous.
- **#72 「把登录的几件事都收尾一下」** (label: ask) — the model enumerates the login threads,
  attaches the follow-up to the running one, and reports the other already done. Label note:
  「模型谨慎确认子集，可接受」.
- **#66 / #67 / #90 / #93 / #95** flip between models — all carry 「可接受/重验可接受」 notes.

The strict scorer counts them; that is deliberate (the bar is the bar). What this cluster
means practically: the residual is label-edge calibration, not machinery — wrong-route on
the strongest model sits under the bar with zero misattachments to an unrelated thread.

## What the selftest covers (no model needed)

`pnpm eval:routing:selftest` asserts the deterministic layers: the world seeds every dataset
thread with the right derived states, strong scorers never miss the candidate set, explicit
signals (reply routing, a titled mention) short-circuit, the confidence gate blocks attaches
without `routing`/with `medium` and dispatches on `high` — including the signal-2 exemption:
an attach right after find_threads answered `explicit` for that thread needs no `routing`
(review #48 finding 1) — and the scorer's verdict table.
