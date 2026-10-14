# pi RPC spikes

Throwaway scripts that drive `pi --mode rpc` the way a Shepherd connector would. They back the findings in [docs/research/pi-integration.md](../../docs/research/pi-integration.md). Not production code.

Requirements: `pi` on PATH (verified with 1.2.0), Node 22+, a configured default model. The scripts use your default model and make real model calls, so they cost tokens. Each run uses its own temp directories under `/tmp/shepherd-spike-run*`.

| Script | Experiments |
|---|---|
| `01-basic-steer-resume.mjs <a\|b\|c\|d>` | a: basic run, injected `report` tool, state and stats. b: `steer` and `follow_up` during a long tool call. c: SIGKILL pi mid-tool, resume the session file in a new process. d: a clarifying question |
| `02-abort-session-concurrency.mjs <e\|f\|g\|h\|i\|j\|k\|l\|m>` | e: abort mid-tool, then continue. f: `new_session`, `switch_session`, `fork`, `get_entries`. g: 5 concurrent processes, startup time and RSS. h: connector SIGKILLed, what happens to pi and its tool processes. i: `report` reliability and the no-report fallback. j: image input. k: pi itself SIGKILLed, do tool processes survive. l: project-local extension and `AGENTS.md` in an untrusted directory. m: read-only mode via the `--tools` allowlist |
| `03-report-enforcement.mjs <plain\|enforced> [runs]` | Compares `report` call rate with and without the `agent_before_settle` enforcement hook |

`report-ext.ts` is the plain injected tool. `report-ext-enforced.ts` adds the settle hook that forces one more request when a run ends without a report.
