# Architecture

Argos is a durable YAML playbook engine for Paseo agents. A repository declares a workflow; a
deterministic engine executes it; an agent (Claude Code, Codex, OpenCode, Pi) only does the work
*inside* a step. This document describes the process split, the layers, the pi-durable mapping,
and what "durable" does — and does not — mean.

## Processes

```
argos CLI ─────────────── HTTP ──┐
                                 ├──► argos serve (one process, one writer)
Paseo plugin (panel + tools) ────┘        ├── $ARGOS_HOME/argos.sqlite   (pi-durable)
                                          ├── engine tasks: run / step / gate / script
                                          └── Paseo adapter ──► Paseo daemon ──► agents
```

| Process | Owns | Never does |
|---|---|---|
| `argos serve` | SQLite, the pi-durable harness, the run scheduler, the Paseo client, the loopback RPC server, the bearer token | nothing outside its home; no agent work itself |
| `argos` CLI | argument parsing, HTTP calls, human/JSON rendering | open SQLite, import the durable host, launch agents |
| Paseo plugin (`id: argos`) | a sidebar row, a run/gate panel, four chat tools | open SQLite, hold run state, keep a run alive |

The split exists so that a plugin reload, a CLI exit, or a closed terminal cannot kill an
in-flight run. It also enforces the single-writer rule mechanically: the CLI and plugin have no
storage dependency at all (`packages/cli/test/import-graph.test.ts`,
`packages/paseo-plugin/test/import-graph.test.ts`, and the CLI sentinel test).

`argos serve` binds `127.0.0.1` (default `7676`, `ARGOS_PORT`), creates
`$ARGOS_HOME/token` on first use (`0600`), and requires `Authorization: Bearer <token>` on every
request. `OPTIONS` is the only unauthenticated method, and CORS headers appear only when the
server is created with an allow-list.

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ control surfaces   CLI · HTTP/SSE · Paseo plugin · chat tools         │
├──────────────────────────────────────────────────────────────────────┤
│ RPC               contracts (zod) · server · summary projection      │
├──────────────────────────────────────────────────────────────────────┤
│ durable host      ArgosHost · pi-durable tasks · mirrored documents  │
│                   ├─ run task   select → await → settle → gate → done│
│                   ├─ step task  locate → launch → await → collect    │
│                   ├─ gate task  await → decided                      │
│                   └─ script task prepare → run → collect             │
├──────────────────────────────────────────────────────────────────────┤
│ engine            next(record, event) → { record, effects }          │
│                   readiness · transitions · loops · timeouts · decide│
├──────────────────────────────────────────────────────────────────────┤
│ playbook          discovery · schema · resolve · expand · validate · │
│                   canonical hash · frozen JSON IR                    │
├──────────────────────────────────────────────────────────────────────┤
│ adapters          Paseo port · fake · git (execFile) · script env    │
└──────────────────────────────────────────────────────────────────────┘
```

The arrows only point down. The engine imports no I/O, no timers, no durable or Paseo code, and
`packages/core/src/engine/purity.test.ts` enforces it. `src/durable/` is the only importer of
`@earendil-works/*`; `src/paseo/client.ts` is the only importer of `@getpaseo/*`; `src/git/` and
`durable/tasks/script.ts` are the only places that spawn a process.

### Playbook definition

`loadPlaybook(repoDir, id)` discovers `.argos/playbooks/*.yaml` (then the paseo fallback), reads
roles/defaults, normalizes aliases, wires inputs, inlines sub-playbooks, validates the graph, and
freezes a `PlaybookIR` with a canonical `sha256` hash. It never writes. The run checkpoint stores
the frozen IR, so editing a playbook cannot change an active run; a new run gets a new hash. See
`docs/compat.md` for the upstream contract.

### Pure engine

Everything that decides control flow is a pure reducer:

```ts
next(record: RunRecord, event: EngineEvent): { record: RunRecord; effects: readonly Effect[] }
```

- **Events** are `tick`, `stepAttemptStarted`, `stepSettled`, `gateDecided`, `cancel`.
- **Effects** are `dispatchStep`, `openGate`, `finishRun`, `startAfterTask`, `decisionRejected`,
  `scheduleWake`.
- Readiness = all `needs` completed/skipped, `notBefore <= now`, and `when` true. Conditions read
  `steps.<id>.outputs.<name>`, `steps.<id>.outcome`, `steps.<id>.status`, and
  `playbook.inputs.<name>`; an LLM is never consulted.
- Transitions are `complete`, `end`, `fail`, `goto`, `ask` (plus a `branch` step's engine-side
  case selection). `goto` resets the target and every downstream step, keeps outputs/attempts,
  and passes feedback into the next prompt as `{{ feedback }}`.
- Loops are counted per edge (`review->fix`), with `max_loops`; exceeding it opens a loop-limit
  gate instead of silently passing.
- Gates are `<stepId>:<n>`. A decision is validated and applied through the same reducer, so the
  durable path and the unit tests exercise one state machine.

The reducer never performs an effect. The durable host commits the checkpoint and then creates
the child task the effect asks for.

## pi-durable mapping

| Argos concept | pi-durable primitive |
|---|---|
| Run | task `argos.run` v1; checkpoint = `RunRecord` |
| Step | child task `argos.step` v1 (or `argos.script` v1), owned by the run task |
| Parallel steps | `waiting { on: [ids], policy: "allSettled" }` |
| Human gate | child task `argos.gate` v1 + decision document |
| Retry/backoff | checkpoint attempt + `sleeping { until }` |
| Loop counter | checkpoint `loops` / `loopAllowance` |
| Crash recovery | reopen SQLite + `resume()`; a running task re-runs its last committed phase |
| Run/step/gate queries | mirrored session documents written in the same commit |
| Task-definition evolution | `defineTask` `version` (+ `migrate()` when a shape changes) |

Task phases are **static** so the task definition never depends on playbook content:

```ts
argos.run    v1: "select" | "await" | "settle" | "gate" | "done"
argos.step   v1: "locate" | "launch" | "await" | "collect"
argos.script v1: "prepare" | "run" | "collect"
argos.gate   v1: "await" | "decided"
```

Documents are session-scoped families:

| Kind | Key | Content |
|---|---|---|
| `argos.run` | `runId` | `{ taskId, record }` — the complete mirrored `RunRecord` |
| `argos.history` | `runId` | append-only `{ events: [...] }`, capped at 500 |
| `argos.gate` | `${runId}.${gateId}` | the one decision document (`pending`/`decided`) |
| `argos.idempotency` | `clientRequestId` | replay cache, 24 h TTL |
| `argos.runs` | singleton | run-id index (listing never scans tasks) |

The run and history documents are written inside the same `runtime.commit()` as the task
checkpoint, so `GET /runs/:id` never sees a state older than the engine. A gate document is
written by the decision writer, not by the gate task.

## Durability model

The engine guarantees **at-most-once launch *attempt* with reconciliation**, not exactly-once
execution. The difference matters across the daemon boundary.

1. `locate` commits `{ requestId, label, attempt, deadlineAt }` **before** any executor call.
   `requestId = argos:<runId>:<stepId>:<attempt>` is stable across restarts.
2. `launch` commits `launchAttempted: true`, then calls the executor. The Paseo adapter first
   lists agents with label `argos/launch=<requestId>`; it adopts a found agent, otherwise creates
   one with that label, `cwd`, rendered prompt, and compiled `outputSchema`.
3. The returned `agentId` is committed immediately (the reconcile point). `await` parks in
   `sleeping(now + pollMs)` and polls `refresh`/`status`; it never holds a model turn.
4. `collect` validates structured output and commits a terminal completed task carrying a
   `StepTaskResult`. A failed step is a completed task with an `errorCode`; task failure is
   reserved for broken task code.

A `SIGKILL` between (1) and (3) is the crash window. On restart the task re-enters `launch` with
the same request id; label reconciliation finds the agent if the daemon created it. If the daemon
cannot filter by label, Argos refuses to blind-relaunch and fails the attempt with
`launch_uncertain` — a clear operator message instead of a duplicate agent. There is a narrow
window where the daemon has the agent but the label is not queryable; that is why Argos does not
claim exactly-once.

`packages/core/test/e2e/kill-restart.test.ts` exercises the happy path with a real process: the
built CLI starts `argos serve`, a blocked step is held, the process is `SIGKILL`ed, the release
file appears, the server restarts on the same home, and the file-backed fake agent ledger shows
exactly one creation per step across both lifetimes. The gate scenario kills with a pending gate,
restarts, decides, and completes.

Timeouts and retries live in `argos.step`, because a run parked in `waiting` does not tick.
Per-step `timeout` (default 30m) is resolved at use time; a timed-out attempt is retried per
`retries` (extra attempts) with deterministic 1s/2s/4s… backoff up to 60s, then fails
`step_timeout`. The run `deadline` fails the whole run immediately. This is a documented deviation
from a fully ticking scheduler: the run record sees one dispatch per child task, while local
attempts are visible in the step checkpoint/history.

## Gates and decisions

`openGate` creates one `argos.gate` child and the pending document in the same commit as the
checkpoint/mirror. The child polls the document every 2 s (`GATE_POLL_MS`). `ArgosHost.decideGate`
reads the record and writes the document inside **one** commit: the first writer wins. Duplicate
active decisions are `gate_already_decided`; unknown gates/decisions are `gate_unknown`; a write on
a finished run is `run_terminal`. The run task maps the result to a `gateDecided` event, so the
reducer applies it exactly once.

- **Step gate**: the decision id is the step outcome and routes through `on`.
- **Ask gate**: the chosen choice's `outcome`/`goto` (default: the ask target).
- **Loop-limit gate**: `approve` adds exactly one `loopAllowance` for the edge and traverses;
  anything else fails the step with `step_failed`.
- The decision comment becomes `StepRecord.feedback` on the re-queued roots and is rendered into
  `{{ feedback }}` in the next attempt's prompt.

v1 gate deciders are human/external. A `decider: { by: role }` block is parsed, resolved, and
preserved in the IR, but the gate still waits for a decision through the RPC surface; the
short-lived deciding agent is not launched yet.

## Adapters

### Paseo

`src/paseo/port.ts` defines the port; `client.ts` is the only SDK import site. Errors are
classified once (`isQuotaError`, `isLabelFilterUnsupported`, `isConnectionError`,
`isAgentMissing`). Quota is a **target hop**, not a retry: the attempt moves to the next fallback
target without consuming `retries`, records `exhausted`, and all-blocked becomes
`provider_exhausted`. An archived agent gets exactly one handover relaunch, then `agent_missing`.
`output.ts` compiles `outputs`/`outcomes` to a JSON Schema; a schema-invalid result is
`invalid_output` and retries. Plain-text providers get a fenced-JSON fallback only when outputs
are declared.

The `ARGOS_FAKE_PASEO=1` executor is test-only. It can persist its agent registry and creation
ledger in `$ARGOS_HOME` so an E2E restart adopts instead of duplicating.

### Scripts, worktrees, read-only

A script step is a real child process (`shell: false`), looked up under `.argos/scripts/` then the
paseo fallback, run in the worktree when isolation is on. Exit `75` parks and re-runs; any other
non-zero exit fails the step; the step timeout bounds an endless exit-75 loop. The environment is
filtered (D10) and stdout/stderr are kept as bounded tails.

Worktree isolation is created by `git` through `execFile` (no shell). It fetches `origin`, picks a
base, refuses a dirty checkout before any agent exists, and stores `{path, branch, baseSha}` in
the checkpoint. A read-only role gets a git snapshot before launch and a comparison in `collect`;
a diff fails `readonly_violation` and leaves the tree for inspection. The guard detects, it does
not prevent (see `docs/compat.md`).

## Control surfaces

`argos validate|run|ls|status|gates|decide|cancel|retry|serve|doctor` are HTTP clients of
`argos serve` (except `validate`, which only reads files, and `doctor`, which also inspects the
local home when the server is down). `POST` writes accept `clientRequestId`; the lookup and create
share one commit, so a retried request returns the same run. `GET /events` is commit-driven SSE
with a snapshot frame and reconnecting clients; the plugin re-fetches on reconnect.

`RunSummary`/`RunDetail` never contain prompts, agent messages, transcripts, or credential-like
inputs. The plugin holds no durable state: teardown closes only its HTTP client and streams, and a
new plugin instance reconnects to the same `argos serve` run.

## Invariants

- **No LLM in control flow.** Transitions, readiness, loop limits, gates, retries, and timeouts
  are decided by the engine. A model only works inside a step.
- **One writer.** Only `argos serve` opens `$ARGOS_HOME/argos.sqlite`. A second live owner is
  refused with `storage_locked` naming `serve.pid`; the CLI and plugin never open storage.
- **Loopback and token.** The server binds `127.0.0.1` and requires a bearer token on every
  request; secrets never reach the database or logs.
- **Stable codes.** Callers match on `ArgosError.code`, never on message text. See the table in
  `AGENTS.md`.
- **Same-commit mirrors.** Run/history documents are committed with the checkpoint; the UI cannot
  observe a state older than the engine.
- **Definition freeze.** A run's IR and hash are immutable once started.

## Where to read more

- `AGENTS.md` — commands, storage layout, task/document kinds, error codes, env vars, tests.
- `docs/compat.md` — the paseo-playbooks divergences with fixtures.
- `docs/spikes/pi-durable-host.md` — the spike that pinned the pi-durable host behavior.
- The approved spec and plan in `brain/spec/2026/Nov/11/03_*`.
