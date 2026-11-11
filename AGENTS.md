# AGENTS.md

Argos — durable YAML playbook engine for Paseo agents. Implementation plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_impl_argos_yaml_playbook_engine.md`.
Current state: **Phase 5 (gates, decisions, after-tasks)**. Phase 6 (Paseo adapter) is next.

## Layout

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `argos-core` | loader, engine, durable host, RPC server, Paseo adapter |
| `packages/cli` | `argos-cli` | `argos` CLI; HTTP client of `argos serve`, never opens SQLite |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel + chat tools; HTTP client, never opens SQLite |

No source files live outside `packages/*`. TypeScript ESM, `module`/`moduleResolution`
`NodeNext` (relative imports need `.js` extensions), Node `>=22.5`.

## Playbook layer (Phase 2)

`packages/core/src/playbook/` is the compatibility contract: `schema.ts` (zod raw YAML),
`load.ts` (discovery + read-only pipeline), `resolve.ts` (agent precedence, input wiring,
condition/transition normalization), `expand.ts` (sub-playbooks), `validate.ts` (graph checks),
`hash.ts` (canonical JSON + sha256), `ir.ts` (the frozen JSON IR later phases consume).

- Discovery: `.argos/playbooks/*.yaml` then `.paseo/plugins/playbooks/*.yaml` (same fallback for
  `roles/`, `defaults/main.yaml`, `scripts/`); playbook id = filename. `loadPlaybook(repoDir, id)`
  returns a deep-frozen `PlaybookIR` with `hash`; it never writes.
- Aliases normalized: `poll_ms` | `pollMs` | `poll` -> `pollMs` (plan D3 defaults 3000/2000/5000);
  `mode` | `mode_id` -> `modeId`; `playbook: {name}` | `use: id` -> sub-playbook; flat
  `gate`/`choices`/`script` and paseo block forms both load.
- Errors are `ArgosError` with the plan's stable code; loader/validator failures are
  `playbook_invalid`, `playbook_cycle`, or `playbook_missing` and always name file + step.
- Golden compat fixtures live in `packages/core/test/fixtures/compat/` (copied from
  `lerenn/paseo-playbooks`, MIT; see `test/fixtures/ATTRIBUTION.md`). Invalid, sub-playbook,
  precedence, `when`/`branch`, and discovery fixtures sit next to them.

## Engine core (Phase 3)

`packages/core/src/engine/` is the pure decision layer (FR14/15/18/21): no I/O, no timers, no
durable or Paseo imports. `purity.test.ts` enforces the import graph. Phase 4/5 consume it only
through the barrel (`import { next, createRunRecord, hydrateRunRecord } from "argos-core/engine"`).

The reducer contract:

```ts
next(record: RunRecord, event: EngineEvent): { record: RunRecord; effects: readonly Effect[] }
```

- `RunRecord` (`record.ts`) is the whole checkpoint: frozen IR + inputs + step/gate/loop state.
  `createRunRecord({id, ir, inputs, cwd, now, worktree?, deadline?})` starts every step `pending`;
  `hydrateRunRecord(json)` validates strictly and returns the input object untouched, so
  `JSON.stringify(hydrate(json)) === json` (no zod defaults, unknown keys rejected, not stripped).
- Statuses. Run: `pending | running | waiting | completed | failed | cancelled` (`waiting` = a
  gate is pending and nothing else is running). Step: `pending | ready | running | waiting |
  completed | failed | skipped` (`ready` = eligible but held by `concurrency`; `waiting` = parked
  on a gate).
- Events: `{type:"tick", now}`; `{type:"stepAttemptStarted", stepId, attempt, startedAt,
  agentId?, target?, requestId?}`; `{type:"stepSettled", stepId, outcome?, outputs?, errorCode?,
  agentId?, usage?, feedback?, endedAt}`; `{type:"gateDecided", gateId, decision, comment?,
  decidedBy?, decidedVia?, decidedAt}`; `{type:"cancel", now}`. All accept optional `now`; the
  record's `updatedAt` is the event time (never the wall clock) and `seq` bumps only on change.
- Effects: `dispatchStep{stepId, attempt, requestId}`; `openGate{gateId, kind, stepId, question,
  choices, edge?}`; `finishRun{status, outcome?, errorCode?}`; `startAfterTask{id}`;
  `decisionRejected{gateId, code: "gate_unknown" | "gate_already_decided"}`; `scheduleWake{at}`.
  The reducer never performs them.
- Readiness (`ready.ts`): a step is ready when it is `pending`/`ready`, every `needs` dependency is
  `completed` or `skipped` (skipped does not block), `notBefore <= now`, and `when` holds. Steps
  whose dependencies are satisfied but `when` is false are returned as `skipped` and the reducer
  commits that immediately. Conditions read `steps.<id>.outputs.<name>`, `steps.<id>.outcome`,
  `steps.<id>.status` (extension), and `playbook.inputs.<name>` / `inputs.<name>`; operands are
  scalar equality, array membership, or `{empty: true|false}`. No LLM is consulted (FR21).
- `on` mapping: `complete` just completes; `end` finishes the run with its optional outcome;
  `fail` fails step + run with `step_failed`; `goto` re-queues its target; `ask` opens a gate.
  An outcome **without** an `on` entry is a plain `complete`; an outcome **not declared** by the
  step is a runtime `step_failed`. A `fail`/executor error bypasses outcome routing.
- `goto` resets the declared target **and every transitively downstream step** (a re-run of the
  whole affected sub-graph; targets can be a step id or a sub-playbook block id). Outputs and
  attempts are kept; `outcome`/`errorCode`/feedback are cleared. Feedback from the settle or gate
  comment lands on the target roots as `StepRecord.feedback` for `{{ feedback }}`.
- Loops (`loops.ts`). Edge label is `<source>-><declaredTarget>`, e.g. `review->fix` (no spaces;
  block targets keep the block id). `loops[edge]` counts traversals, `loopAllowance[edge]` counts
  human grants. `max_loops: 2` allows exactly two returns; with three traversals already used the
  third attempt opens a loop-limit gate instead. Approve adds one allowance and traverses; reject
  fails the step with `step_failed`. `max_loops` absent = unlimited.
- Gate ids (D14): `<stepId>:<n>`, `n` = 1-based count of gates opened for that step (step gates and
  loop-limit gates share the counter, so ids stay unique even with several loop edges from one
  step; the loop gate's `edge` field names the edge). Duplicate/unknown decisions emit
  `decisionRejected` without touching the record; a decision outside the gate's choices is treated
  as `gate_unknown`.
- `decide.ts` is the pure decision entry point Phase 5's host uses before it writes anything:
  `decideGate(record, {gateId, decision, comment?, decidedBy?, decidedVia?, decidedAt})` returns
  `{ record, effects, gate?, rejection? }`. It reuses `next(record, {type:"gateDecided"})`, so the
  engine stays the only state machine; it rejects unknown gates and out-of-choice decisions with
  `gate_unknown`, duplicates with `gate_already_decided` (naming the winner) and finished runs
  with `run_terminal`. It is in the purity guard's source list.
- Timeouts (`timeouts.ts`). Per-step `timeout` (default 30m) is resolved at use time: number = ms,
  duration string via the loader's parser, whole-value `{{ inputs.t }}` from the run input (number
  or duration), otherwise the default. A timed-out attempt is recorded, then retried per `retries`
  (which counts *extra* attempts) after a deterministic 1s/2s/4s… cap 60s backoff via `notBefore`;
  otherwise the step fails with `step_timeout`. `RunRecord.deadline` is absolute epoch ms and fails
  the whole run immediately (no retries), marking running attempts timed out and never-started
  steps skipped.
- Main loop: on every event, skip `when:false`, settle branch steps (engine-side outcome choice),
  open gate steps, then dispatch ready non-gate steps in IR order up to `concurrency` simultaneous
  `running` steps; over-cap steps are `ready`. When all main steps are terminal the run finishes
  (`completed`, or `failed` if any step failed). `auto` after-tasks are started once via
  `startAfterTask` and never change `run.status`; `manual` stay `pending`.
- Attempt history is **not capped** in the checkpoint (Phase 4/5 write the bounded history
  document, D16). Outputs are append/overwrite only: an output key is never removed.

## Durable host (Phase 4)

`packages/core/src/durable/` is the only place that imports `@earendil-works/*` (later also
`src/git/`). Everything else — loader, engine, future RPC/CLI — stays free of the storage
dependency. The public surface is the `argos-core/durable` subpath; it is deliberately **not**
re-exported from the package root so the CLI and plugin cannot open SQLite by accident.

`ArgosHost` (`host.ts`) owns one SQLite file:

- `ArgosHost.open({ home?, storage?, executor, clock?, models? })` → ensures `$ARGOS_HOME` (`0700`),
  takes `$ARGOS_HOME/serve.pid`, opens `argos.sqlite` (`0600`), installs the `argos` extension, and
  calls `resume()`. `storage` is an injection point for tests (`MemoryStorage`); passing it skips
  the home/pid setup.
- **Single writer.** A pid file naming a live process refuses the open with
  `ArgosError("storage_locked", "<serve.pid>: another argos process (pid N) owns this home")`.
  `pid === process.pid` is also refused (a second host in one process). A dead pid (or unreadable
  content) is stale and replaced. `close()` removes the pid file only when it still names this
  process, and `close()` is idempotent.
- `startRun({ ir, inputs, cwd, worktree?, deadline?, id? })` → `{ runId, taskId }`. `runId` is a
  dependency-free ULID (monotonic within one process); `taskId` is pi-durable's numeric task id,
  stringified at the public boundary. The run task is created **conversation-owned** by the root
  conversation (D5) and the initial mirror is written in the same commit.
- `resume()` / `close()` / `getRun(runId)` / `getHistory(runId)` / `getTaskRecord(taskId)` /
  `inspect()`. `startRun` and `open` both call `resume()`, so scheduling never depends on the
  caller.
- `models` (D6) is a Proxy stub: `Harness.open` reads `getAuth` once (to bind it into its identity
  wrapper), so the property returns a function that throws when **called**; everything else
  throws on call too, and `has` reports `false` so the wrapper stays immutable. The engine never
  asks for a model, and no `pi.generation` task may ever appear in `inspect()`.

### Tasks (kinds `argos.run` v1, `argos.step` v1, `argos.gate` v1)

Checkpoints are discriminated unions of per-phase shapes (pi-durable narrows each handler with
`Extract<S, {phase: P}>`; one interface with a union `phase` becomes `never`).

```ts
argos.run  v1: "select" | "await" | "settle" | "gate" | "done"
  { phase, record: RunRecord,
    childTasks: { [stepId]: TaskId },          // latest child per step
    dispatched: { [String(taskId)]: stepId },  // every step child ever created
    awaiting: TaskId[], settles: StepSettlement[],
    gateTasks: { [gateId]: TaskId },           // latest gate child per gate (D14 ids)
    gateSettles: GateSettlement[],
    afterTasks: { [afterId]: TaskId },         // the `argos.run` child per after-task
    finished?: { status, outcome?, errorCode? } }

argos.step v1: "locate" | "launch" | "await" | "collect"
  { phase, requestId, attempt, label, deadlineAt, polls,
    agentId?, target?, launchedAt?, status?, errorCode? }

argos.gate v1: "await" | "decided"
  { phase, gateId, runId, stepId, kind, edge?, question, choices, seenAt,
    decision?, comment?, decidedBy?, decidedVia?, decidedAt? }
```

`select` feeds `next(record, {type:"tick"})` to the engine, creates one child per effect in the
same commit as the mirror/history — `argos.step` for `dispatchStep`, `argos.gate` (plus its
pending document) for `openGate` — then commits `waiting { on: childIds, policy: "allSettled" }`
(phase `await`). `await` reads `runtime.outcomes(awaiting)` and maps each outcome to an engine
event: `stepSettled` for a step child, `gateDecided` for a gate child (see the Phase 5 section).
The checkpoint carries those settlements into `settle`, which applies them through `next()` (the
reducer decides the next ready set, transitions, loops, decisions, and the run outcome) and
creates/dispatches whatever the reducer asks for. `gate` is the recovery path: a pending gate
with no live child gets a fresh `argos.gate` child (same gate id). `done` creates the `auto`
after-task children and commits the terminal outcome (`completed` → completed, `failed` → failed,
`cancelled` → aborted).

`argos.step` calls the injected `StepExecutor` (`context.ts`):

1. `locate` commits `{ requestId, label, attempt, deadlineAt }` **before** any executor call.
2. `launch` calls `launch()` and commits `agentId` immediately (the reconcile point).
   `launch` must adopt by `requestId` (`argos:<runId>:<stepId>:<attempt>`) and never create twice.
3. `await` calls `status()` and parks in `sleeping { until: now + pollMs }` while running
   (D3 step default 3000). The first status call happens on entry, then on every wake.
4. `collect` optionally calls `collect()`, normalizes outputs to scalars (`invalid_output` on a
   non-scalar), and commits a **terminal completed** task whose result is
   `{ stepId, attempt, requestId, outcome?, outputs?, errorCode?, agentId?, target?, usage? }`.
   A failed step is a completed task with an `errorCode`; task failure is reserved for broken
   task code.

Errors are explicit: a `startAfterTask` effect is recorded as `after_queued` and executed by
`done`; a `decisionRejected` effect is logged as `effect_skipped` (the host validates decisions
first, so it is a bug signal); `scheduleWake` narrows the next poll; a phase that throws commits a
cancelled, mirrored run plus a `task_error` history event and a failed task outcome, so a run is
never abandoned without a terminal state.

### Documents (D4)

| Kind | Key | Content |
|---|---|---|
| `argos.run` | `runId` | `{ taskId, record }` — the complete mirrored `RunRecord` |
| `argos.history` | `runId` | `{ events: [{ at, seq, type, stepId, attempt, detail }] }`, capped at 500 |
| `argos.gate` | `${runId}.${gateId}` | the decision document (see Phase 5); logical name `argos.gate.<runId>.<gateId>` |

All three are **session-scoped document families**. Run and history are written inside the same
`runtime.commit()` as the task checkpoint, so a reader never sees a state older than the engine
(FR13). The history is append-only and drops the oldest events past `HISTORY_LIMIT = 500` (D16);
its types are `run_started | select | dispatch | settle | gate | gate_decided | finish |
effect_skipped | task_error | after_queued | after_start`. Chord stores no document
change when the value is identical, so a commit that only advances the phase still writes the same
mirror without a new document revision — this is expected, not a missing write. The gate family
key `${runId}.${gateId}` is collision-free because a run id is a ULID and a gate id is
`<stepId>:<n>`; neither part can contain a dot.

### Retries and timeouts (documented deviation)

The run task is parked in `waiting` on its children and does not tick, so per-step `timeout` and
`retries` are enforced inside `argos.step`: a poll after `deadlineAt` either re-launches with a
fresh attempt number/requestId after a deterministic 1s/2s/4s… backoff, or collects
`step_timeout`. The `RunRecord` records one dispatch attempt per child task; the extra local
attempts are visible in the step task's checkpoint/history. Moving retry scheduling back into the
engine is Phase 5/6 work once parked runs can be woken for `notBefore`.

### Gates and after-tasks (Phase 5)

**Gate task and document.** `openGate` creates one `argos.gate` child (owned by the run task,
`{kind:"task", taskId: runTaskId}`) and the pending document `argos.gate.<runId>.<gateId>` in the
same commit as the checkpoint/mirror, then the run waits on it. `await` re-reads the document and
parks in `sleeping { until: now + GATE_POLL_MS }` while it is pending (D7/FR19, 2000 ms — the
constant lives in `durable/context.ts`); `decided` commits a terminal completed task whose result
is `{ runId, gateId, decision, comment?, decidedBy?, decidedVia?, decidedAt }`. A restart resumes
the same task and the same gate id — nothing is renumbered, because the id comes from the run
record's `GateRecord` (D14 `<stepId>:<n>`).

```ts
GateDoc (argos.gate.<runId>.<gateId>, family key `${runId}.${gateId}`)
  { runId, gateId, stepId, kind, question, choices,
    status: "pending" | "decided",
    decision: string | null, decidedBy: string | null, decidedVia: string | null,
    comment: string | null, decidedAt: number | null, createdAt }   // null = not set (JsonObject)
```

**Decisions.** `ArgosHost.decideGate(runId, gateId, decision, {comment?, decidedBy?, decidedVia?})`
reads the run record and writes the document inside **one** `root.commit()`; the first writer
wins. It is the only writer of a decision. Codes: `gate_unknown` (unknown run/gate id, or a
decision outside the gate's choices), `gate_already_decided` (the message names the winning
decision and its time), `run_terminal` (the run already finished). The gate child then maps the
result to an engine `gateDecided` event in the run's `settle` phase, so the reducer applies it:
- `step` gate — the decision id **is** the step outcome, routed through `on`;
- `ask` gate — the chosen choice's `outcome`/`goto` (default: the ask target);
- `loop_limit` gate — `approve` adds exactly one to `loopAllowance[edge]` and re-fires the edge,
  anything else fails the step with `step_failed`. `max_loops: N` allows exactly N returns; the
  N+1-th opens the gate. Approving once therefore grants exactly one more traversal.
The decision comment becomes `StepRecord.feedback` on the re-queued roots and is rendered into
`{{ feedback }}` in the next attempt's prompt (and passed as `LaunchInput.feedback`).

**After-tasks (FR11).** `after[id]` starts as `pending`. When the main graph becomes terminal the
reducer marks every `trigger: "auto"` entry `running` and emits `startAfterTask`; the run's `done`
phase then creates one `argos.run` child per entry (owned by the parent run task) with a scoped
`PlaybookIR` (`<playbookId>/<afterId>`, only that entry's steps, fresh content hash), and only then
commits the parent's terminal outcome. `trigger: "manual"` stays `pending` until
`ArgosHost.startAfterTask(runId, afterId)` (conversation-owned child: pi-durable refuses a child of
a terminal owner; `started: false` when the entry is no longer pending). An after-task never
changes the parent's `run.status`: the parent mirror's `after[id]` is host-owned bookkeeping
(`pending → running → completed|failed`, `startedAt`/`endedAt`) and the child patches it in its own
terminal commit. While an auto after-task is live the parent task stays `completing`, so its
receipt waits for it.

Host APIs added in Phase 5: `decideGate`, `getGate(runId, gateId)` (typed `GateDoc`), and
`startAfterTask` (→ `{ runId, afterId, started, taskId? }`). Documents: `GateDocFamily` with
`checkpointWhen: () => true`, both in `durable/mirror.ts` alongside the run/history writers.

### Tests

```sh
npm test                                        # all workspaces + durable suite
npm run typecheck
npx vitest run --project core packages/core/test/durable   # just the durable suite
```

Fixtures: `test/fakes/clock.ts` (fake `now()`/`setTimer()` + `advance()` that fires due timers and
flushes queued work) and `test/fakes/executor.ts` (agents keyed by `requestId`, manual completion or
a scripted `complete(agent)` callback per attempt, blockable launches, creation counts per step,
and the captured `prompt`/`feedback` of every launch). The suite covers: home/db modes and pid
single-writer (stale pid replacement, `storage_locked`), mirror-vs-checkpoint equality for every
record-changing commit, the D6 generation/model guard, checkpoint JSON round-trip byte-identity, a
diamond that closes mid-step and reopens the same SQLite file with exactly one agent per step, a
crash inside `launch` that re-enters `launch` and adopts the same agent, timeout + one retry, gate
open/`sleeping` evidence, one-writer decisions with `gate_already_decided`, a pending gate that
survives close/reopen, loop-limit approve/reject, the gate comment reaching the next attempt's
`feedback`/prompt, and auto/manual after-tasks (`test/durable/{gates,after}.test.ts`;
`src/engine/decide.test.ts` covers the pure decision path).

## Commands (run from the repo root)

```sh
npm ci            # reproducible install from package-lock.json
npm test          # builds workspaces (tsc -b) then vitest run over all projects
npm run typecheck # tsc -b for src, then tsc --noEmit for test files
npm run build     # tsc -b (emits dist/ for every workspace)
node -e "import('argos-core')"   # workspace-link check; requires a build first
```

Package `exports` point at `dist/`, so anything that imports a sibling workspace
needs a build. `npm test` and `npm run typecheck` both run `tsc -b` first.

## Pinned dependency versions (FR5, D-spec)

Exact versions only — no `^` or `~`. Upgrades are an explicit PR that must keep
the durability suite green.

| Package | Version | Where | Why this version |
|---|---|---|---|
| `@earendil-works/pi-durable` | `1.5.2` | `packages/core` | durable task host (FR2, FR13) |
| `@earendil-works/chord` | `1.5.2` | `packages/core` | pinned alongside pi-durable |
| `@earendil-works/pi-ai` | `1.5.2` | `packages/core` | exact version `pi-durable@1.5.2` depends on |
| `@getpaseo/client` | `0.15.4` | `packages/core`, `packages/paseo-plugin` | Paseo adapter / RPC client |
| `@getpaseo/plugin` | `0.15.4` | `packages/paseo-plugin` | plugin runtime + panel |
| `typescript` | `7.0.2` | root dev | compiler |
| `vitest` | `5.1.0` | root dev | test runner |
| `@types/node` | `26.6.6` | root dev | Node types |
| `yaml` | `2.9.1` | `packages/core` | playbook parser |
| `zod` | `4.6.7` | `packages/core` | schema validation (also the future RPC contract) |

`@getpaseo/plugin` peer-depends on React `>=19.1.0 <20`; npm installs the peer
(`react@19.3.0` in the lock file) and it is not a direct dependency.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ARGOS_HOME` | `~/.argos` | state dir, mode `0700`; DB `argos.sqlite` (`0600`), `token`, `serve.pid` |
| `ARGOS_PORT` | `7676` | `argos serve` port on `127.0.0.1` |

## Invariants

- **No LLM in control flow.** Transitions are decided by the engine, never by a model.
- **One writer.** Only `argos serve` opens `$ARGOS_HOME/argos.sqlite`; CLI and plugin talk HTTP.
- **Loopback + token.** Errors are stable codes (`playbook_invalid`, `storage_locked`, …);
  secrets never reach the DB or logs.
