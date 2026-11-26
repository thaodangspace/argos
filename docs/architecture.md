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
                                          └── executor registry ──► Paseo daemon / herdr-core
```

| Process | Owns | Never does |
|---|---|---|
| `argos serve` | SQLite, the pi-durable harness, the schedule runner (one timer over durable schedule documents), the executor registry (the Paseo client plus an optional herdr-core client), the loopback RPC server, the bearer token | nothing outside its home; no agent work itself |
| `argos` CLI | argument parsing, HTTP calls, human/JSON rendering | open SQLite, import the durable host, launch agents |
| Paseo plugin (`id: argos`) | a sidebar row, a run/gate panel, four chat tools | open SQLite, hold run state, keep a run alive, touch schedules |

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
│ adapters          Paseo port · hc port · fakes · git · script env    │
└──────────────────────────────────────────────────────────────────────┘
```

The arrows only point down. The engine imports no I/O, no timers, no durable or Paseo code, and
`packages/core/src/engine/purity.test.ts` enforces it. `src/durable/` is the only importer of
`@earendil-works/*`; `src/paseo/client.ts` is the only importer of `@getpaseo/*`; `src/hc/client.ts`
is the only user of `node:net`; `src/git/` and `durable/tasks/script.ts` are the only places that
spawn a process.

### Executor registry

`argos serve` assembles one registry: `paseo` always, `hc` (herdr-core) when a real core answers
its `hello`/`server.status` probe inside 5 s or when the test-only `ARGOS_FAKE_EXECUTOR=hc` selects
the deterministic fake. `--default-executor <id>` (or `ARGOS_EXECUTOR`) picks the substrate a run
without an override starts on; without either, `hc` is preferred as soon as its adapter registered
and `paseo` is the fallback, so a machine with no herdr-core starts the same server it always did.

A run resolves its substrate once — request (`argos run --executor`, `POST /runs {executor}`) >
schedule document > playbook (`executor:`, `defaults.executor`, `defaults/main.yaml`) > server
default — and the resolved id is **frozen** in `RunRecord.executor` (omitted for `paseo`, so every
older record is byte-identical). The child `argos.step` task commits the same id and looks it up in
the registry, so a restart with a different `--default-executor` cannot move an in-flight run to
another substrate. An id the registry does not carry is `executor_unavailable` before any task, run
index entry, or worktree exists; `GET /info` and `argos doctor` list every registered executor with
its reachability, version, and capabilities, in registry order (`hc` first, then `paseo`), and
`argos serve` prints one startup line naming the registry.

### Playbook definition

`loadPlaybook(repoDir, id)` discovers `.argos/playbooks/*.yaml` (then the paseo fallback), reads
roles/defaults, normalizes aliases, wires inputs, inlines sub-playbooks, validates the graph, and
freezes a `PlaybookIR` with a canonical `sha256` hash. It never writes. The run checkpoint stores
the frozen IR, so editing a playbook cannot change an active run; a new run gets a new hash. An
edited definition is picked up by `argos fork`, which starts a *new* run at a chosen step (see
[Fork at a step](#fork-at-a-step)). See `docs/compat.md` for the upstream contract.

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
| Step | child task `argos.step` v1 (or `argos.script` / `argos.delay` v1), owned by the run task |
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
argos.delay  v1: "arm" | "wait"
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
| `argos.schedule` | `<id>` | one schedule (playbook, cwd, cron/tz, policies, `nextFireAt`, `lastFire`, `runIds`, bounded fire log) |
| `argos.schedules` | singleton | schedule-id index — the roster every schedule read consults |

The run and history documents are written inside the same `runtime.commit()` as the task
checkpoint, so `GET /runs/:id` never sees a state older than the engine. A gate document is
written by the decision writer, not by the gate task. A schedule fire writes its run task, mirror,
history, run-index entry and the schedule document in the same commit, so the run and its fire
marker cannot disagree.

## Durability model

The engine guarantees **at-most-once launch *attempt* with reconciliation**, not exactly-once
execution. The difference matters across the daemon boundary.

1. `locate` commits `{ requestId, label, attempt, deadlineAt }` **before** any executor call.
   `requestId = argos:<runId>:<stepId>:<dispatchAttempt>` is stable across restarts. A local retry
   inside the task (timeout, invalid output, quota wait) uses
   `argos:<runId>:<stepId>:<dispatchAttempt>.<k>`, so it can never collide with the request id of a
   later engine dispatch.
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
restarts, decides, and completes. A third scenario kills `argos serve` **before** a schedule's
fire time, waits for the wall clock to pass it, restarts, and asserts exactly one run for that
instant (its ULID time prefix decodes to the fire time), one ledger creation for its step,
`lastFire.status = "started"`, and one fire line on stderr — then kills and restarts again to prove
the same fire time cannot run twice.

Timeouts and retries live in `argos.step`, because a run parked in `waiting` does not tick.
Per-step `timeout` (default 30m) is resolved at use time; a timed-out attempt is retried per
`retries` (extra attempts) with deterministic 1s/2s/4s… backoff up to 60s, then fails
`step_timeout`. The run `deadline` fails the whole run immediately. This is a documented deviation
from a fully ticking scheduler: the run record sees one dispatch per child task, while local
attempts are visible in the step checkpoint/history.

A **transient executor outage at launch** shares the 1s/2s/4s… backoff but not the attempt
bookkeeping. Nothing ran, so the step parks in `phase: "launch"` and re-enters the same
adopt-or-create call with the **same** request id: `retries` is untouched, no new agent is minted
(a create whose reply was lost is adopted, and a daemon that cannot filter labels still refuses
`launch_uncertain`), and the step `timeout` is the only cap. At the deadline the step fails with
the **transient code** (`paseo_unreachable` / `executor_unreachable`), never `step_timeout`, and
the receipt's `detail` records how many launches the outage cost; `launchFailures` stays in the
checkpoint as the step's outage history and `launchErrorCode` is dropped once a retry succeeds.
Every other launch failure is terminal on the first throw, and a `launch()` that hangs without
throwing is still unbounded — only a thrown transient failure parks. Poll-time unreachability
keeps its old rule: the attempt exists, so it parks and ends in `step_timeout` after `retries`.

### Fork at a step

`argos fork <runId> <stepId>` is the iterate loop: edit a step's prompt, branch the finished run at
that step, keep everything upstream. Three rules make it safe to have without weakening the freeze.

**A fork is a new run.** It gets a fresh run id, its own worktree and branch, its own mirror and
history. The parent document is never mutated. A same-id reload would produce one document whose
`playbookHash` disagrees with the prefix that actually ran, and reconstructing the boundary would
mean replaying history `seq` — so the discontinuity is recorded instead of implied, as
`RunRecord.forkedFrom = {runId, stepId, fromHash, toHash}` plus one `forked_from` history event
(`detail = <parentRunId>@<stepId>`). This is the "branch with a parent pointer" model, not the
"apply the newest code to every resume" model: a resume still never re-reads a file.

**The edit must stay inside the reset closure.** The guard diffs the frozen IR against a fresh
`loadPlaybook` of the run's `cwd` (`playbook/diff.ts`) and refuses with `definition_conflict` unless
every differing step is in `downstreamClosure(parentIr, [stepId])` — the set the fork re-runs — and
the step sequence, input declarations, `isolation`, and `after` are unchanged. `title`,
`description`, `defaults`, `providers`, `roles`, `blocks`, `outcomes`, `concurrency`, and the hash
may differ freely; `labels` may not, because `resolve.ts` merges playbook labels into every
`StepIR`. The closure is computed on the **parent** IR, so a new `goto` edge inside it can only add
work, never hide it.

**State carries over by policy, not by accident.** Inherited: step status/outputs/attempts/feedback,
`cwd`, `exhausted`, and the parent's resolved inputs verbatim. Re-pinned: the closure's scripts
(hash compared against the new IR, `script_repinned` per change). Dropped: `gates` (the parent's
decisions, and new ids start at `:1`), `loops`/`loopAllowance` (a fork is a fresh attempt and must
not hit the parent's `max_loops` wall on its first re-run), `trigger` (one fire, one run in
`argos ls --schedule`), `deadline` (an absolute instant that may already have passed). An isolated
parent's fork cuts `argos/<forkRunId>` from `refs/heads/argos/<parentRunId>` locally — no fetch, no
source-dirtiness check — so uncommitted parent work stays behind for inspection.

`argos retry` remains the other tool: same `runId`, same frozen IR, scripts re-pinned. The mental
model is one sentence each — **retry never reloads, fork always does**.

## Scheduler

Recurring work is a **schedule document**, not a long-lived task:

```
argos.schedule.<id>   one schedule: playbook, cwd, cron + IANA tz, overlap/catchUp/keep,
                      enabled/generation, nextFireAt, lastFire, liveRunId, runIds, fire log
argos.schedules       the schedule-id index — the roster every read and every fire commit consults
```

`ArgosHost` owns one `ScheduleRunner` (`durable/schedules.ts`). It arms exactly one timer, at
`min(earliest enabled nextFireAt, now + 60 s)`, and arms none when every schedule is paused. The
timer only enqueues a tick; ticks, timer fires, and `argos schedule run` all execute one after
another on a single promise chain, so two fires never overlap. `croner` is used only as a
calculator (`schedule/next.ts`, built paused, with no callback): it never arms a timer.

Why not a durable task per schedule, or one singleton scheduler task? A pi-durable task cannot be
woken before its `sleeping { until }` elapses, so edit, pause, and run-now would each need
abort-plus-recreate, and every checkpoint shape change would need `migrate()`. Durability here
comes from the document, the fire's single commit, and the deterministic run id instead: while
`argos serve` is down nothing is lost (the schedule is a row), and the next start catches up.

### The fire commit

A fire is prepared outside any commit — load the playbook at fire time, coerce inputs, pin
scripts, cut the worktree — and then written by **one** commit that also updates the schedule
document. Inside that commit the runner re-reads the document and aborts the fire (writing
nothing) when any of these holds — with one exception, the already-landed run, which is adopted
instead:

- the index no longer lists the id (deleted while preparing);
- the `uid` differs (the id was deleted and re-added);
- `generation` changed (an edit or a pause landed);
- the schedule is disabled;
- `lastFire.fireAt >= fireAt` (that instant already landed, or the clock moved back);
- the run index already lists the run id — the existing run is adopted as this fire's outcome
  instead of starting a second one;
- `overlap: skip` and `liveRunId` names a run that is still live.

The run id is deterministic: `scheduleRunId(uid, fireAt)` is a ULID whose time part is the fire
time and whose random part is `sha256(uid:fireAt)`. A crash after the worktree exists but before
the commit therefore re-fires the same instant with the same id (and the same
`<home>/worktrees/<runId>`), and two schedules due at the same instant cannot collide. `argos
schedule run` uses a fresh ULID, because "now" is not a fire time.

Catch-up: a tick takes the **latest** due fire time and counts the earlier ones (capped at
`10000+`), then applies `catchUp` — `all` (default) always fires that latest time, `<ms>` fires it
only inside the window, `0` only inside a 120 s grace. Earlier due times become one `missed`
fire-log entry and never start a run. A fire at most 120 s late is `cron`; later is `catch_up`.
Overlap: `skip` (default) records `skipped_overlap` and advances `nextFireAt` while the previous
run is live; `allow` starts anyway. A fire that fails before the commit is recorded as `refused`
(code plus a bounded message, `consecutiveFailures + 1`) and is retried only at the next fire time.

DST follows `croner`'s documented rules, pinned by fixed-epoch tests in America/New_York,
Europe/Berlin, and Asia/Saigon: a fixed-time job runs once on a repeated local time and, in a
spring-forward gap, at the first valid instant after it; a wildcard, range, or step job follows
Vixie-cron (both occurrences, nonexistent skipped). `nextFireAt` is stored as absolute epoch
milliseconds, so a clock that moves backwards cannot re-fire an instant (`lastFire.fireAt` guards
it) and a clock that moves forward is an ordinary catch-up.

Retention is a separate step: after a fire whose run started, and outside its commit, runs in
`runIds` (newest first, capped at 1,000) beyond the newest `keep` (1..1,000 or `all`) are removed
with the same `removeRun` that `argos rm` uses. Retention cannot fail a fire: a live run, a run
with a running after-task, and a run whose worktree directory still exists are skipped and retried
after the next fire, and retention never removes a worktree or a branch.

Observability: `lastFire`, the 50-entry fire log, `consecutiveFailures`, `nextFireAt`, `liveRunId`
and `runIds` in the document; `trigger` on the run record and `RunSummary`; `argos schedule
ls`/`show`, `argos ls --schedule <id>`, the `argos doctor` `schedules` check, and one stderr line
per fire (`[argos] schedule <id> <iso> <status> run <runId>`). The listener is registered before
the first tick, so a catch-up fire during startup is announced too.

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

### herdr-core (`hc`)

`src/hc/port.ts` is the port; `client.ts` is the only socket. herdr-core is a **terminal host**:
JSON-RPC 2.0 over its Unix socket (a named pipe on Windows), plain mode — one JSON object per line
in both directions, params by name. `hello {generation: 1}` is the handshake: a core that speaks
another generation (or answers `incompatible`, `unsupported_generation`, `needs_update`,
`hc_missing`, or nothing at all) is simply not registered, and `argos serve` prints one warning
instead of failing to start. `HC_SOCKET`/`HC_SESSION` and the documented endpoint chain resolve the
socket; Argos never spawns an `hc` CLI.

A playbook targets hc the same way it targets Paseo — `agent: { provider: hc, model: <template> }`
— and the canonical target is `hc/<template>`. `templates.list` is the catalog, so a template the
core does not offer is the existing `model_unavailable` before any task exists; `herdr` and
`herdr-core` are accepted spellings. `executor: hc` at the playbook top level, in `defaults.executor`,
or in `defaults/main.yaml` pins the substrate, while `argos run --executor hc`, `POST /runs
{executor}`, and `argos schedule add --executor hc` override it for one run or one schedule. Note
that `hc` is the server default when a core answered at startup, so a playbook whose steps target a
Paseo `provider/model` and that never names `executor:` is refused `model_unavailable` (naming the
missing `hc/<...>` targets) before any task — pin `executor: paseo` for a Paseo-only repository.

One step is one `terminal.run` (argv = template + rendered prompt) with a deterministic
`argos-<16 hex of the request id>` name and `argos/launch|run|step|attempt|home` labels. It also
carries `herdr.space`/`herdr.tab`, the Herdr app's adoption labels, so the step is a pane there while
it runs (`ARGOS_HERDR=0` turns them off; `ARGOS_HERDR_SPACE` defaults to `argos`, and
`ARGOS_HERDR_TAB` to the run id, so one run's steps share a tab). No other client reads a label, and
an install without the app simply keeps them as data. `launch`
adopts before it creates: a label-filtered `terminal.list {all: true, labels: {argos/launch}}` finds
a terminal a crashed lifetime made, and a `name_taken` reply adopts that name instead of retrying —
so a restart never runs the step twice. `rm` is never passed at launch (the crash window needs the
record), and the terminal is removed on settle, killed first when hc still calls it live.

The prompt is delivered exactly once with no extra checkpoint state: `terminal.run` reports
`first_message.sent`, and while hc still says "not sent, `turn === 0`" a `terminal.send {if:
"idle"}` types it in — hc's own record is the durable fact. `status()` is one `terminal.get` per
existing poll tick (`poll_ms`), never an event subscription: `working`/`idle`/`blocked` keep the
step running (`blocked` carries a `blocked: <msg>` detail and the deadline still governs), and a
`done` status or a finished terminal settles it with its exit code. Declared outputs are read from
the terminal text with the shared fenced-JSON parser (see `docs/compat.md` row 37). A terminal that
disappears gets exactly one handover relaunch (new name, `argos/handover=1`, a handover note), then
`agent_missing`.

| Port error | Argos code | HTTP |
|---|---|---|
| `HcTransportError` (connect/read/write/timeout/closed) | `executor_unreachable` | 503 |
| `unreachable` kind | `executor_unreachable` | 503 |
| `hc_missing`, `incompatible`, `unsupported_generation`, `needs_update`, `unavailable`, an unknown kind | `executor_unavailable` | 422 |
| `not_found`, `machine_unknown` | `agent_missing` after one handover | 409 |
| `name_taken` with no adoptable terminal | `launch_uncertain` | 409 |
| `blocked`, `status_mismatch`, `finished`, `live`, `invalid_params`, `spawn_failed`, `conflict` | `step_failed` | 502 |

**Completion depends on the program.** hc learns that work finished from the program's own OSC 7501
status report. A template whose command never reports status never looks done, so its step runs to
its deadline (`step_timeout`); the step deadline, not the adapter, is the bound. A transport failure
is `executor_unreachable` in both phases: at launch the step parks and retries the same
adopt-or-create call — adopting a terminal `terminal.run` already created — until the step
deadline, and at poll time it parks to the same deadline. That is Paseo's rule. hc has no
structured-output channel and no provider counters, so `usage`/cost stays absent for its steps.

**Trust boundary.** hc runs the template's command as the same user, with that user's filesystem
access, in the run's `cwd`/worktree. The socket is same-user trust: whoever can connect to it can
start a terminal. Argos never passes an `env` block to `terminal.run`, so the program inherits the
core's environment and never an `ARGOS_*` name; prompts and labels carry no token. `hc` is the
server default whenever a core answers its startup probe, so that access is the default posture:
run `argos serve --default-executor paseo` (or pin `executor: paseo`) where it is not wanted. It can
also be chosen per run, per playbook, or per schedule.

**Where a template comes from.** A template is a machine-level asset, and the split is three
layers:

| Layer | Owns | Code |
|---|---|---|
| `hc` core | the terminal/PTY, OSC 7501, adoption by label/name, kill-before-`rm` | not ours |
| template pack (asset) | `claude -p`'s flags, `stream-json` event mapping, quota wording, login-shell `PATH`, final-message shaping | `packages/cli/templates/packs/*/*.mjs`, installed to `$ARGOS_HOME/hc/packs/<pack>@<version>/` |
| Argos | `templates.list` as catalog, `terminal.run`, poll, fenced-JSON parse, `model_unavailable`, the engine | `src/hc/`, `src/engine/`, `src/durable/` |

`claude -p` is not in the engine because of process ownership: hc owns the terminal and must keep
running it across an `argos serve` crash and restart (that is what makes adoption instead of a
re-run possible), while Argos owns the step and must never interpret the program's output beyond
the one fenced JSON block — so the vendor's flags, quota wording, and stream parsing live in a
program an operator installs and can fork, not in a control path (`argos hc templates …`,
[`docs/hc-templates.md`](hc-templates.md)).

The `ARGOS_FAKE_EXECUTOR=hc` port is test-only (`src/hc/fake.ts`, file-backed under
`ARGOS_FAKE_HC_DIR`): it opens no socket, settles every terminal with exit code 0, and can hold one
step until a release file appears so the E2E can `SIGKILL` a server mid-step.

### Scripts, worktrees, read-only

A script step is a real child process (`shell: false`), looked up under `.argos/scripts/` then the
paseo fallback, run in the worktree when isolation is on. Exit `75` parks and re-runs; any other
non-zero exit fails the step; the step timeout bounds an endless exit-75 loop. The environment is
filtered (D10) and stdout/stderr are kept as bounded tails.

A delay step (`delay: 30m`) runs no process: `argos.delay` commits one absolute wake time and parks
in `sleeping` slices of at most 60 s (a Node timer stalls while the machine sleeps, so each wake
re-reads the wall clock), and a restart resumes the same instant. Use it, not a `sleep` script, for
the pause in a loop: a restart kills a script and the respawn starts its sleep over against the
original deadline (`script_timeout`). Delay steps have no step timeout.

Worktree isolation is created by `git` through `execFile` (no shell). It fetches `origin`, picks a
base, refuses a dirty checkout before any agent exists, and stores `{path, branch, baseSha}` in
the checkpoint. A read-only role gets a git snapshot before launch and a comparison in `collect`;
a diff fails `readonly_violation` and leaves the tree for inspection. The guard detects, it does
not prevent (see `docs/compat.md`).

## Control surfaces

`argos validate|run|ls|status|gates|decide|cancel|retry|rm|worktree|schedule|serve|doctor` are
HTTP clients of `argos serve` (except `validate`, which only reads files, and `doctor`, which also
inspects the local home when the server is down). `POST` writes accept `clientRequestId`; the
lookup and create share one commit, so a retried request returns the same run. `GET /events` is
commit-driven SSE with a snapshot frame and reconnecting clients; the plugin re-fetches on
reconnect.

The substrate is selected per run (`argos run --executor`, `POST /runs {executor}`), per schedule
(`argos schedule add|edit --executor`) or per server (`argos serve --default-executor`, which
otherwise prefers `hc` and falls back to `paseo`), and a playbook can pin it with `executor:`.
`GET /info` publishes the registry (`{id, default, reachable,
version?, capabilities}`), which is what `argos doctor`'s `executors` line and the `argos ls` /
`argos status` output render; `RunSummary.executor` is present only when the run is not on
`paseo`.

The scheduler's operator surface is `argos schedule add|ls|show|edit|pause|resume|run|rm` and
`argos ls --schedule <id>`. A schedule's `cwd` (resolved `--cwd`, else the CLI's cwd) and `tz`
(`--tz`, else the CLI process zone) come from that invocation, never from the server, so an
unattended run means the same thing after a restart or from another machine; the RPC layer
requires `cwd` in the body for the same reason.

`RunSummary`/`RunDetail` never contain prompts, agent messages, transcripts, or credential-like
inputs. `RunDetail` adds what a CI-style step log needs — each step's attempts (`target`, timing,
usage), its declared outputs (credential-shaped output names dropped, long values truncated), its
outcome, and the run's bounded history; the list projection stays lean. Usage also rolls up: a
step's `usage` aggregates its attempts and the run's `usage` aggregates every main step
(`engine/usage.ts`), which is what `argos ls`'s COST column, `argos status`'s `usage` line, and the
panel's run meta/step rows render; after tasks are separate runs and are not counted in the
parent. The plugin holds no durable state: teardown closes only its HTTP client and streams, and a
new plugin instance reconnects to the same `argos serve` run.

## Web UI (`/ui`)

`argos serve` also hosts a SvelteKit SPA under `/ui` (same port, same origin). `GET /` answers a
`302` to `/ui/` when the UI is present; without a UI directory the server is API-only and `/ui`
answers `404`.

- **Build and packaging.** `packages/web` is a private workspace (`@thaodangspace/argos-web`,
  Svelte 5 runes, `@sveltejs/adapter-static`, `paths.base = "/ui"`). `npm run build:ui` writes
  `packages/web/build/`; `packages/cli/scripts/copy-ui.mjs` copies it to `packages/cli/ui/` and
  writes `build.json`, so the CLI tarball carries the UI (`files: ["dist", "ui", …]`). A development
  checkout points at the build with `ARGOS_UI_DIR=packages/web/build`; an empty `ARGOS_UI_DIR`
  disables the UI. `argos serve` logs one `[argos] ui <dir> (build <id>)` line, or one warning when
  the directory has no `index.html`.
- **Static rules.** Only `/ui` and `/ui/...` are UI paths, so the SPA route `/ui/runs/<id>` can never
  shadow `GET /runs/:id`. An extension-less path falls back to `index.html` (deep links work); a
  missing path **with** an extension is a `404` (a stale chunk never receives HTML). Path segments
  are decoded, `..`/separator/NUL are rejected, and the resolved file's realpath must stay inside
  the UI directory. `_app/immutable/*` is cached immutably; everything else is `no-store`.
- **Browser session.** The bearer token never reaches the browser. Each server process mints one
  random session id and hands it to the browser in an `HttpOnly; SameSite=Strict; Path=/` cookie on
  HTML responses; every API route accepts either `Authorization: Bearer <token>` (unchanged) or that
  cookie. A cookie-authenticated write additionally requires an `Origin` equal to the request's
  `Host` (and refuses `Sec-Fetch-Site: cross-site`), because `SameSite` compares sites, not ports —
  a page on another loopback port would otherwise be "same-site" with the server. A restart
  invalidates every session; the SPA reloads once to obtain a fresh cookie.
- **Data.** The UI is a projection of the same read model as the CLI and panel: `GET /runs`,
  `GET /runs/:id` (attempts, declared outputs, bounded history), `GET /events` (SSE), gate decisions,
  cancel/retry/fork, and `GET /playbooks?cwd=` for the "Run workflow" form. It renders steps, status,
  duration, attempts, usage/cost, declared outputs, gates, and history — never prompts or agent
  transcripts, which the contract does not expose.
- **Styling.** Every screen is markup plus utilities: Tailwind 4 (through `@tailwindcss/vite`, ahead
  of `sveltekit()` in the Vite plugin list) and Skeleton 5.0.6 with the Vintage theme.
  `packages/web/src/app.css` is the only stylesheet and holds exactly the four `@import`s
  (`tailwindcss`, `@skeletonlabs/skeleton`, `@skeletonlabs/skeleton-svelte`,
  `@skeletonlabs/skeleton/themes/vintage`) and one
  `@custom-variant dark (&:where(.dark, .dark *))` — no `@theme`, no `@utility`, no selector, no
  declaration. That variant is load-bearing: Skeleton paints through `light-dark()` pairs, so the
  class is what makes the toggle win over the operating system. `src/app.html` carries the two
  attributes: `class="dark"` is the colour mode and the only thing `applyTheme` writes,
  `data-theme="vintage"` selects the theme and is never written at runtime. A tone becomes a
  class only through the literal records in `lib/ui/tone.ts` (Skeleton colour pairings, so one class
  serves both modes) — an interpolated `tone-{tone}` is invisible to Tailwind's scanner and would be
  missing only in the production build. `lib/style-guard.test.ts` keeps it that way (no `<style>`, no
  `style=`, no interpolated class, the `app.css` shape, no stale allowlist entry, no `{@html}`), and
  `test/setup.ts` supplies the jsdom polyfills Zag's `Dialog`/`Toast` need while the default test
  environment stays `node`. The palette is Vintage, which deliberately replaces the old
  GitHub-Actions colours; it ships system font stacks and zero `@font-face`, so the UI downloads no
  font and requests no new origin.
- **Shared view model.** Labels, tones, glyphs, filters, grouping, the step log and history text live
  in `@thaodangspace/argos-core/view`; the Paseo panel re-exports them and the web UI imports them, so
  a new status or history event is one edit for both clients (`core/test/view/purity.test.ts` keeps
  that module free of Node, storage, and adapter imports).

The playbook DAG follows the same shape: **one projector, two renderers.** `playbook/graph.ts`
(`buildPlaybookGraph`) turns a frozen `PlaybookIR` into the structural `PlaybookGraph` — nodes,
edges, entry, terminals — and `view/graph.ts` renders it, either as Mermaid text
(`renderMermaid`/`escapeMermaidLabel`/`mermaidNodeKey`, what `argos chart` prints) or as integer
SVG geometry (`layerGraph`, what `RunGraph.svelte` draws). The import is one-way: the graph contract
lives in `rpc/contracts.ts` because `view/` may import only that module and its own siblings, and
`view/graph.ts` never imports `playbook/` — so the web bundle carries the renderer but never the
loader. The projector is a *consumer* of the IR: no key, hash, or engine decision changes.

The graph is **derived, never stored.** `RunDetail.graph` is projected by `toRunDetail` from
`record.ir` (memoized per frozen IR) and `GET /playbooks?graph=1` adds it per summary on request
only — the default listing and every run document stay byte-identical. A run always charts the
definition it froze, so `argos chart --run <id>` and the `?view=graph` toggle show what actually
ran, not the working tree.

## Database maintenance (`/db/*`)

`argos serve` is the only writer, so maintenance is not a second process that opens the file: it is
a small route family on the same token and the same connection.

| Route | Behavior |
|---|---|
| `GET /db/stats` | `argos db stats`: file and WAL size, SQLite page counters, and row counts over pi-durable's tables (`documents`/`document_revisions`, `tasks`, `entries`, `conversations`, `submissions`, live runs by status, idempotency receipts and how many are past the 24 h TTL). Read-only. |
| `POST /db/purge` | `argos db purge --older-than <n>(s\|m\|h\|d) [--dry-run] [--vacuum]`: retires every **terminal** run whose `updatedAt` is older than the window through `removeRun`, retires expired idempotency receipts, and reclaims the terminal `tasks` rows of the runs it removed. A live run is skipped as `active`, a refused removal is reported with its stable code, and worktrees are **never** removed. `dry-run` reports the same counts and changes nothing. |
| `POST /db/vacuum` | `argos db vacuum`: `VACUUM`, then a truncating WAL checkpoint (the order matters — the rewrite goes through the WAL, so checkpointing afterwards is what shrinks the on-disk total). |

Why the task rows: `removeRun` / `argos rm` deliberately keep pi-durable's task records (nothing
reads them once the mirror is gone, and the engine never mutates a terminal task), but they are
the bulk of the file — a run's `argos.run` checkpoint duplicates the whole record. A purge deletes
only rows that are already `terminal` **and** belong to a run it just removed, plus their
`record_ids` claims; ids are minted from a monotonic counter, so dropping a claim cannot collide
with a future row. Retired documents (`retired_at`) are left in place: they are small, and the
document table is pi-durable's to read.

Nothing runs on a timer. A purge or a vacuum is an operator action with an explicit window, the
same posture as `argos worktree gc`.

## Security


Argos is a **single-user, local** tool. It does not sandbox the work it starts: a playbook's scripts
and agents run as the local user, with that user's files, environment, and credentials (whatever
the env rules below allow). The security model is therefore about *who can ask Argos to run
something*, not about containing what the run does.

### Threat model

| Trusted | Untrusted / out of scope |
|---|---|
| The operator's account, `$ARGOS_HOME` (`0700`), the token file (`0600`), the `argos serve` process | A repository's playbook or script contents (they are code, reviewed like code), a compromised Paseo daemon or agent, a local herdr-core core, a process running as the same user |
| The local loopback listener | Remote network peers (the server binds `127.0.0.1` and never advertises itself) |
| The CLI/plugin as the operator | Agents the run launches: they inherit only the granted environment and act inside the run `cwd`/worktree, but they are not kernel-isolated |

The main risks are (a) someone who obtains the token starting an arbitrary run, (b) a playbook
leaking secrets into a child process, and (c) a script or agent changing files outside what the
operator expected. (a) is bounded by the token file's mode, (b) by the env allowlist, and (c) is
accepted: filesystem permissions are the boundary, not Argos.

### What the token grants

`$ARGOS_HOME/token` is the only authorization. Every route requires
`Authorization: Bearer <token>` and compares it in constant time; `OPTIONS` is unauthenticated.
Possession of the token means full control of that server:

- `POST /runs` starts a playbook in **any accepted `cwd`** — so it can make Argos execute the
  playbook's scripts and launch agent turns as the local user in that directory. The token is
  therefore equivalent to code execution as the operator, not a read-only status key.
- `POST /runs/:id/gates/:gateId` approves human gates (including `max_loops` grants),
  `cancel`/`retry`/`DELETE /runs/:id` change or retire runs, and the worktree routes remove
  checkouts. `POST /db/purge` retires every old terminal run in one call (and its task rows) and
  `POST /db/vacuum` rewrites the database file. `GET` routes expose run metadata only: no prompts,
  transcripts, agent messages, or playbook IR ever appear in `RunSummary`/`RunDetail`.

The token and `ARGOS_PASEO_PASSWORD` are never logged, never stored in the database, and never
returned by a route.

### `cwd` trust

`POST /runs` refuses a `cwd` that is not absolute, contains a NUL byte, does not exist, or is not
a directory (`invalid_request`, HTTP 400, before the loader runs, so no run or worktree is
created). A git repository is deliberately **not** required: Argos can run a playbook in any
directory the operator names, and `isolation: worktree` is what asks for a git checkout.
Because the API accepts any existing directory, the plugin (not the server) is where a calling
agent is confined — see *Plugin confinement*.

### Environment rules

A script is deny-by-default (FR2). It inherits only the baseline (`PATH`, `HOME`, `LANG`, `LC_*`,
`TZ`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TMP`, `TEMP`, `SystemRoot`, `PATHEXT`,
`COMSPEC`) plus the names its step `env:` list grants: an exact name (granted even when it looks
like a credential), a `PREFIX_*` prefix (which never covers a name matching
`/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i`), or `"*"` (every non-secret name — the old
inherit-everything behavior, which `argos validate` warns about as `env_inherit_all`). The deny list
(`ARGOS_PASEO_PASSWORD`, `ARGOS_HOME`, `ARGOS_PORT`, `ARGOS_EXECUTOR`, `ARGOS_PASEO_URL`, and the
`ARGOS_FAKE_PASEO*`/`ARGOS_FAKE_EXECUTOR`/`ARGOS_FAKE_HC_*` test knobs) is never passed, even when
named. `NODE_OPTIONS`, `SSH_AUTH_SOCK`, and `GIT_*` are absent
unless granted; a run cannot "inherit" a credential by accident. Agents launched by a step see the
same filtered environment.

### Script pinning

Every script is resolved and hashed (SHA-256) when the run starts and stored in
`RunRecord.scripts`; the script task re-hashes the file immediately before **every** spawn. A
changed, moved, or deleted script means `script_changed` (409) and no automatic retry; `argos retry`
is the operator's re-pin. This is **detection, not prevention** (accepted risk R4): a writer that
changes the file between the hash check and `exec` is not stopped, and a running script can modify
its own file or any file it can write. Scripts are not sandboxed — they run as the local user and
can delete untracked files later steps expected (see `docs/compat.md` row 25).

### Read-only and worktrees

`role.readonly` is enforced by a git snapshot before and after the step; a difference is
`readonly_violation` and the worktree is kept for inspection. The guard detects, it does not
prevent (created-and-deleted files, new files inside an already-untracked directory, and ignored
paths are invisible). Worktree cleanup is manual (`argos worktree rm`, `argos worktree gc`) and
**record-only**: the path and branch come from the stored run record, guarded against
`<home>/worktrees/<runId>` and `argos/<runId>`, so an API caller cannot point removal at an
arbitrary directory. gc only *reports* a directory that no run index entry claims.

### Browser session (Web UI)

The embedded UI (`/ui`) needs a credential a browser can use: the token file is `0600` and
JavaScript must not hold the token, and `EventSource` cannot set an `Authorization` header. The
server therefore mints one random **session id per process**, kept only in memory, and sets it in an
`HttpOnly; SameSite=Strict; Path=/` cookie on HTML responses. Every route accepts the bearer token
(unchanged) or that cookie; a restart invalidates all sessions.

This is deliberately equivalent to the token in capability, not broader:

- The cookie is unreadable from JavaScript (`HttpOnly`) and never leaves the process/filesystem
  (not persisted, not logged).
- `SameSite=Strict` stops cross-site sends, and `Sec-Fetch-Site: cross-site` is refused outright.
- Because `SameSite` compares *sites* (scheme + registrable domain), two loopback ports are
  "same-site"; a cookie-authenticated **write** therefore also requires `Origin` to equal the
  request's `Host`. Reads are safe from another origin because no CORS headers are configured.
- Setting the cookie on `GET /ui/...` means any local caller can obtain a session — exactly as any
  local caller can already read `$ARGOS_HOME/token`; the threat model treats same-user processes as
  trusted. The cookie grants nothing the token does not.
- The static shell and its assets are served **before** authentication (they contain no run data,
  and the shell is what delivers the cookie). Only `/ui*` is claimed that way; every API route keeps
  the bearer/cookie check.

### Plugin confinement

The plugin's panel is human-driven, so its `argos.runs.start` RPC is not confined (the operator
chooses the directory). The **agent chat tool** is different: `argos_start_playbook` fills `cwd`
from the calling agent's working directory (A2, verified against Paseo 0.15.4 — `AgentToolContext`
carries `agent.cwd: string`) and refuses a request outside it.

- Omitted `cwd` → the agent's own working directory.
- An explicit `cwd` must be that directory or a subdirectory of it (`agentCwd + "/"` prefix),
  after the tool rejects any path containing a `..` segment, and it must be absolute.
- An empty or missing agent cwd is refused (`invalid_request`); there is **no** fallback to the
  server's cwd.

The check is **lexical and not a sandbox**: it stops a model from pointing a run at an unrelated
directory, but a symlink inside the agent cwd that resolves elsewhere still passes, as does a
subdirectory whose own contents are symlinks. A refusal is local: the tool returns
`{error:{code:"invalid_request"}}` and makes no HTTP call. A server-side `invalid_request` stays
`invalid_request` (it is not collapsed into `playbook_invalid`).

### Unattended schedules

A schedule is executable intent stored on disk: it makes `argos serve` start a playbook with no
operator present. It is therefore created and changed only through the token-authenticated RPC
surface (`argos schedule …`, `POST /schedules…`); the plugin exposes no schedule panel or chat
tool, so an agent cannot register, edit, or run one.

- `cwd` is validated when the schedule is added or edited **and again at every fire**
  (`resolveRunRequest`), so a deleted, moved, or replaced directory is a refused fire, not a run
  somewhere unexpected.
- The stored `tz` is checked by `Intl` and never reaches a shell; the stored cron is parsed by
  `croner` in 5-field mode (`@reboot` and seconds are refused).
- Scripts are resolved, hashed, and pinned at each fire exactly as for a manual run, and re-hashed
  before every spawn; a changed script is `script_changed`, never a silent run.
- The document stores inputs (in `0600` SQLite, like run records) but **no environment values**: a
  scheduled script or agent inherits `argos serve`'s environment through the same env filter, and
  summaries go through `publicInputs`, so credential-looking names never reach a caller.
- A refusal stores the `ArgosError.code` plus a message cut to 500 characters; a non-`ArgosError`
  contributes only its name, so no YAML, input, or environment value is persisted.
- Deterministic run ids stay inside the ULID alphabet, so the record-only worktree guard
  (`<home>/worktrees/<runId>`, branch `argos/<runId>`) still holds.

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
- **Definition freeze.** A run's IR and hash are immutable once started, and a resume never
  re-reads a file. An edited definition continues through `argos fork`: a new run with `forkedFrom`
  provenance, so every document still contains exactly the IR it ran.
- **Durable schedules.** A schedule is a document, not a task; one in-process timer only wakes a
  tick, and the fire's single commit (guards plus a deterministic run id) is what makes a fire
  happen exactly once.

## Where to read more

- `AGENTS.md` — commands, storage layout, task/document kinds, error codes, env vars, tests.
- `docs/hc-templates.md` — hc template packs: the `pack.json` format, the `claude` pack's knobs and
  step budgets, what `verify` answers, and the migration from a vendored `claude-step.py`.
- `docs/compat.md` — the paseo-playbooks divergences with fixtures.
- `docs/spikes/pi-durable-host.md` — the spike that pinned the pi-durable host behavior.
- The approved spec and plan in `brain/spec/2026/Nov/11/03_*`.
- `brain/spec/2026/Nov/13/01_spec_argos_fork_at_step.md` and `01_impl_argos_fork_at_step.md` —
  fork-at-step: the problem, the closure rule, and the phase plan it was built from.
- `brain/spec/2026/Nov/16/01_spec_argos_multi_provider_runs.md` and
  `01_impl_argos_multi_provider_runs.md` — the executor registry, the frozen per-run substrate, and
  the herdr-core adapter.
