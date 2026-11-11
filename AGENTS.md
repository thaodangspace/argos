# AGENTS.md

Argos — durable YAML playbook engine for Paseo agents. Implementation plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_impl_argos_yaml_playbook_engine.md`.
Current state: **Phase 9 (Paseo plugin) complete**. Phase 10 (durability E2E + docs) is next.

## Layout

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `argos-core` | loader, engine, durable host, git helpers, RPC server, Paseo adapter |
| `packages/cli` | `argos-cli` | `argos` CLI; HTTP client of `argos serve`, never opens SQLite |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel + chat tools; HTTP client, never opens SQLite |

No source files live outside `packages/*`. TypeScript ESM, `module`/`moduleResolution`
`NodeNext` (relative imports need `.js` extensions), Node `>=22.5`.
`packages/core/src/git/` is the only directory (with `durable/tasks/script.ts`) allowed to import
`node:child_process`, and it is exported on the `argos-core/git` subpath, never the root.

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
npx vitest run --project core packages/core/test/paseo     # just the Paseo adapter suite
```

Fixtures: `test/fakes/clock.ts` (fake `now()`/`setTimer()` + `advance()` that fires due timers and
flushes queued work), `test/fakes/executor.ts` (agents keyed by `requestId`, manual completion or
a scripted `complete(agent)` callback per attempt, blockable launches, creation counts per step,
and the captured `prompt`/`feedback` of every launch), and `test/fakes/paseo.ts` (a labelled-agent
daemon fake: seeded agents, quota targets, `blockCreate()` for the crash window, scripted
`complete`/timeout/handover). The durable suite covers: home/db modes and pid
single-writer (stale pid replacement, `storage_locked`), mirror-vs-checkpoint equality for every
record-changing commit, the D6 generation/model guard, checkpoint JSON round-trip byte-identity, a
diamond that closes mid-step and reopens the same SQLite file with exactly one agent per step, a
crash inside `launch` that re-enters `launch` and adopts the same agent, timeout + one retry, gate
open/`sleeping` evidence, one-writer decisions with `gate_already_decided`, a pending gate that
survives close/reopen, loop-limit approve/reject, the gate comment reaching the next attempt's
`feedback`/prompt, and auto/manual after-tasks (`test/durable/{gates,after}.test.ts`;
`src/engine/decide.test.ts` covers the pure decision path).

The Paseo suite (`test/paseo/`) covers: create arguments (provider/cwd/rendered prompt/labels/
compiled `outputSchema`), adoption after a crash with **zero** additional `create`, `launch_uncertain`
without a second create when labels are unsupported, exactly one handover then `agent_missing`,
`waitForFinish` timeout → local retry → `step_timeout`, quota fallback without consuming `retries`
plus `RunRecord.exhausted`, all-targets-blocked `provider_exhausted`, `invalid_output` after
retries, fenced-JSON fallback only when outputs are declared, `startRun` refusal with
`model_unavailable` and no task, and the publish-time import guard.

## Paseo adapter (Phase 6)

`packages/core/src/paseo/` is the real-agent half of FR16/FR17/FR24 (D11/D12). It is exposed as
the `argos-core/paseo` subpath, never from the package root. `src/paseo/client.ts` is the **only**
file allowed to import `@getpaseo/*` (`test/paseo/isolation.test.ts` enforces it); every test uses
`test/fakes/paseo.ts`, so no test opens a socket.

### Port and error taxonomy

`port.ts` is plain data + typed errors; `agent-step.ts` never sees an SDK handle.

```ts
interface PaseoPort {
  readonly supportsLabelFilter: boolean;                 // "unsupported" != "none found"
  listByLabels(labels): Promise<AgentRef[]>;             // throws LabelFilterUnsupportedError
  create(input: CreateAgentInput): Promise<AgentRef>;
  refresh(agentId): Promise<AgentInfo | null>;           // throws when the daemon rejects
  waitForFinish(agentId, timeoutMs): Promise<FinishResult>; // status includes "timeout"
  archive(agentId): Promise<void>;
  providersSnapshot(): Promise<ProviderCatalog>;         // { providers: [{ provider, enabled, models }] }
}
```

| Port error                    | Argos code / behaviour                              |
|-------------------------------|-----------------------------------------------------|
| `PaseoUnreachableError`       | `paseo_unreachable` (poll-time parks until deadline) |
| `LabelFilterUnsupportedError` | `launch_uncertain` in the crash window               |
| `QuotaError`                  | next fallback target; all blocked → `provider_exhausted` |
| `AgentMissingError`           | one handover relaunch, then `agent_missing`         |
| `ProviderTimeoutError`        | step keeps polling; the durable deadline owns retries |

Classification is centralized in `port.ts` (`isQuotaError`, `isLabelFilterUnsupported`,
`isConnectionError`, `isAgentMissing`, `classifyPaseoFailure`): message/code/HTTP-status matching,
because the daemon exposes no typed quota enum. `client.ts` maps connect/auth failures to
`paseo_unreachable`, redacts `ARGOS_PASEO_PASSWORD` from every message, connects lazily, reuses the
client between calls, and disables the SDK's internal reconnect loop (Argos paces retries).

### Target resolution, quota fallback, exhaustion (FR24)

`model-catalog.ts` loads `providers.snapshot()` and exposes a `TargetCatalog`:

- `resolveStepTargets(step)` = resolved step agent (`step.agent`, which already carries
  step > role > playbook > defaults) followed by `step.fallbacks` / role fallbacks, deduped.
- `ModelCatalog.missingTargets(ir, inputs)` checks the main graph **and** after-task steps, renders
  whole-value `{{ inputs.x }}` in provider/model, accepts aliases, and returns every unknown
  target sorted. `ArgosHost.startRun` refuses the run with `model_unavailable` **before any task is
  created** when this list is non-empty. `ArgosHostOptions.modelCatalog` is optional, so Phase 4
  tests that do not use Paseo are unchanged.
- `availableTargets` / `isTargetExhausted` implement the configurable skip window (default 15 min).

Quota is a **target** hop, not a retry: `agent-step.ts` keeps an in-memory ledger merged with the
run record's `exhausted`, tries candidates in order, and returns/throws the entries. `argos.step`
carries them in `StepTaskResult.exhausted`; `argos.run`'s `settle` merges them into
`RunRecord.exhausted: [{ target, at }]` (one entry per target, latest `at`, stable order) before it
mirrors the record. `retries` is not decremented. All targets blocked → `provider_exhausted`.
The primary target's `modeId`/`thinking` are applied; fallback targets carry provider/model only.

### Structured output (FR17, D12)

`output.ts` compiles `outputs` + `outcomes` into one object schema:
`{ type:"object", properties:{ <outputs>, outcome?: {enum} }, required:[required outputs, outcome],
additionalProperties:false }`. Types are string/number/boolean/enum; declared defaults fill missing
optional outputs. `validateStepOutput` returns `{ outcome, outputs }` or a precise `invalid_output`
error (`output count: expected number, received string`). `parseStepResult` prefers a structured
`output`; when that fails validation it does **not** re-parse prose. Plain text is parsed only when
the step declares `outputs`, and only from one fenced ```json block or a bare JSON object; two
fences is ambiguous → `invalid_output`. `invalid_output` retries like a timeout, per `retries`.
`PROVIDER_OUTPUT_CAPABILITIES` records the manual probe result (unknown providers default to
`structured`); the parser always accepts both shapes.

### Launch, crash window, handover

- `launch` adopts the first non-archived agent matching `{ "argos/launch": requestId }`, else
  creates with `config.provider`, `cwd`, the rendered prompt (including `{{ feedback }}`), labels
  `argos/launch`/`argos/run`/`argos/step`/`argos/attempt`, and `outputSchema`. `idempotencyKey` is
  the request id.
- The step checkpoint gained `launchAttempted`, committed **before** the executor call. If the
  daemon cannot filter labels and a re-entry sees `launchAttempted: true`, `launch` fails
  `launch_uncertain` instead of blind-relaunching. First attempts still create (the flag cannot be
  checked any other way).
- `refresh` returning null/archived or throwing `AgentMissingError` triggers **one** handover:
  archive the old agent, create a replacement with `argos/handover=1` and a handover note appended
  to the prompt, and return the new `agentId`; the task commits `handoverAttempted` and polls the
  replacement. A second occurrence fails the step with `agent_missing`.
- `waitForFinish`/`ProviderTimeoutError` keeps the step running; the durable deadline turns it into
  a local retry (fresh request id/agent) and finally `step_timeout`.

### Checkpoint additions (pre-release, migration-free)

`argos.step` gained `launchAttempted: boolean`, optional `handoverAttempted`, `exhausted`, and the
raw provider result (`status.raw`) so `collect` can re-validate after a restart that never
re-enters `launch`. `StepAgentContext` also carries `targets`, `agentConfig`, `outputDefs`, and
`exhausted`. These are additive fields; no existing Phase 4/5 assertion changed.

### Manual capability probe (never in CI)

```sh
npm run build
ARGOS_PASEO_URL=ws://127.0.0.1:6767/ws ARGOS_PASEO_PASSWORD='…' \
  node --experimental-strip-types scripts/probe-output-schema.ts [claude codex opencode pi]
```

Creates one tiny agent per provider with the real `outputSchema`, prints whether structured output
or a fenced-JSON text result came back, and archives the agents. Use its output to refresh
`PROVIDER_OUTPUT_CAPABILITIES` in `src/paseo/output.ts`. It is a developer tool only: no test or CI
job imports `scripts/`.

### Documented deviations

- A **launch-time** `paseo_unreachable` fails the step with `paseo_unreachable`; only poll-time
  unreachability parks and retries until the deadline.
- This SDK's `waitForFinish()` exposes `lastMessage` text but no structured JSON value, so the
  production port leaves `FinishResult.output` undefined and relies on the D12 fenced-JSON
  fallback.
- Local retries (timeout / `invalid_output`) create fresh request ids inside one `argos.step`
  child; the run record still shows one dispatch attempt per child (Phase 4 deviation), while the
  fake port's `create` ledger and the step checkpoint show each local attempt.

## Scripts, isolation, read-only (Phase 7)

`src/git/` (D9/D8), `src/engine/env.ts` (D10), `src/durable/tasks/script.ts` (FR22), and the
`readonly` field threaded through `argos.step` (FR23). Control flow is untouched: a script step is
dispatched by the same `dispatchStep` effect and settles through the same `stepSettled` event as an
agent step.

### `argos.script` v1

Phases `prepare → run → collect` (static, like every other Argos task).

```ts
argos.script v1: "prepare" | "run" | "collect"
  { phase, attempt, runs, deadlineAt,
    scriptPath?, exitCode?, signal?, stdout?, stderr?, lastRunAt?, detail?, errorCode?,
    snapshotBefore?, readonlyViolation? }
```

- The run task creates an `argos.script` child for a step whose frozen IR `kind` is `script`
  (owned by the run task, like `argos.step`); every other non-gate step keeps the Phase 6 executor.
  `await`/`settle` map the child result exactly like a step result, so gates, loops, and `when`
  behave identically.
- `prepare` resolves the executable **before** anything runs and commits its absolute path plus
  `deadlineAt = now + timeout` (the step's `timeout`, default 30m). A read-only step takes its D8
  snapshot here too.
- Resolution: `<script>` must be a bare file name (no `/`, no `..`, not absolute). It is looked up
  in `.argos/scripts/` and then `.paseo/plugins/playbooks/scripts/` of the **run cwd** (the repo
  root) and must be an executable regular file. Resolution uses the repo root so a local,
  uncommitted helper can drive an isolated run; *execution* happens in `cwd` = `worktree.path` when
  isolation is on, otherwise the run cwd. A missing or non-executable script fails the step with
  `step_failed`, naming the paths it tried.
- `run` spawns the file with `shell: false`, the filtered env (below), and bounded (8 KiB) *tails*
  of stdout/stderr. Exit `75` (`SCRIPT_NOT_YET`) commits `sleeping { until: now + pollMs }` (D3
  script default 5000) and re-runs on wake with `runs + 1`; any other non-zero exit is terminal
  (`step_failed`). A script still alive when the deadline elapses is killed and fails
  `script_timeout`, so "exit 75 forever" is bounded by the step timeout, never by a run count.
- `collect` commits a **terminal completed** task whose result is a `StepTaskResult`. A failing
  script is still a completed task carrying an `errorCode` (task failure stays reserved for broken
  task code). Success reports outcome `success` (or the step's first declared outcome) and exposes
  the declared script outputs: `stdout`, `stderr`, `exitCode`/`exit_code`, `runs`. Any other
  declared output name is simply absent — script outputs are never parsed as JSON.
- Diagnostics: a terminal task cannot carry a checkpoint, so the receipt result also carries
  `exitCode`, `runs`, `signal`, and a bounded `detail` (exit code + stderr tail, or the resolution
  error). The run record keeps only the stable `errorCode`.
- The child is killed on `runtime.signal` abort (run cancelled, `abortTask`, harness close) and when
  the deadline timer fires. On POSIX it is spawned `detached` and killed by process group, so a
  script's own children die with it; the task tracks its live child so the abort handler can kill a
  leaked process.

### Script env filter (D10)

`filterScriptEnv(env, declared)` in `src/engine/env.ts` (pure, covered by the purity guard):

- drop every key matching `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` unless the step lists it in
  `env: [...]`;
- always keep `PATH`, `HOME`, `LANG`, `TMPDIR`, plus `TMP`, `TEMP`, and `SystemRoot` when present
  (the win32 basics; harmless on POSIX). Baseline names match case-insensitively, declared names
  match exactly;
- a declared name the parent does not define is absent, not an error;
- output keys are sorted, so a checkpoint or log comparison is byte-stable.

The same pattern is reused by `src/git/exec.ts` to redact secrets from git error messages.

### Worktree isolation (D9, FR23)

`createRunWorktree({ repo, home, runId, base?, git? })` → `{ path, branch, baseSha }`:
`<ARGOS_HOME>/worktrees/<runId>` on branch `argos/<runId>`, created from `origin/<base>` **after**
`git fetch --prune origin`. Base resolution order: `isolation.base`; `refs/remotes/origin/HEAD`;
the branch the checkout is on when `origin/<branch>` exists; `origin/main`; `origin/master`.

- A source checkout with uncommitted changes is refused with `worktree_base_dirty` **before**
  `git worktree add`; a base that does not resolve is `worktree_failed`; every other git failure is
  `worktree_failed` with the redacted stderr tail. An unsafe base name (a leading `-`, `..`, …) is
  rejected before it reaches git.
- Idempotent per run id: an existing clean worktree is returned (the restart window between
  creation and the run task's first commit), a branch without its checkout is re-attached, and a
  dirty worktree is refused rather than silently reused.
- `ArgosHost.startRun` creates it when the effective isolation is `{mode:"worktree"}` — from the
  frozen IR, or from the `isolation` override that Phase 8's `argos run --isolation` will pass —
  stores `{path, branch, baseSha}` in `RunRecord.worktree`, and gives every agent and script child
  the worktree as `cwd`. Refusals happen before the run task exists, so no agent is ever launched.
  `mode: none` keeps `cwd` as given.
- Worktrees are never removed automatically: a failed or violating step leaves its worktree for
  inspection. `removeRunWorktree({repo, home, runId, force?})` removes the checkout and keeps the
  branch; `listRunWorktrees({repo})` lists them.
- `src/git/exec.ts` is the only place that starts git: `execFile("git", [args])`, never a shell,
  never a library. `GitRunner` is injectable so tests assert the exact argv and cwd.
  `test/git/isolation.test.ts` enforces both "no shell string" and "`node:child_process` only in
  `src/git/**` and `durable/tasks/script.ts`".

### Read-only guard (D8)

`role.readonly` becomes `readonly: true` on the `argos.step`/`argos.script` input. Before launch (or
before a script's first execution) the task takes `takeSnapshot(cwd)` — `git rev-parse HEAD` plus
`git status --porcelain=v1 -z` — and commits it as `snapshotBefore`; `collect` takes a second
snapshot and compares. Any difference (HEAD moved, an entry added or removed, a status code
changed) fails the step with `readonly_violation` and drops its outputs. The changed paths are
committed as `readonlyViolation` before the terminal outcome, and the worktree is left exactly as
the step left it. A read-only step in a non-git directory fails with `step_failed` instead of
pretending the guard ran; a step whose role is not read-only is not snapshotted.

**Limitation (to be recorded in `docs/compat.md`, Phase 10):** the guard *detects*, it does not
prevent. A file created and deleted inside one step leaves no trace; a new file inside an
already-untracked directory keeps the same `?? dir/` entry because D8 pins the default untracked
mode; `.git`-ignored paths are invisible to it. A script that deletes files later steps needed is
outside the engine's control (spec edge case).

### Tests

```sh
npx vitest run --project core src/engine/env.test.ts          # filterScriptEnv units
npx vitest run --project core test/git                        # git port, snapshots, worktrees, argv guard
npx vitest run --project core test/durable/scripts.test.ts    # exit 75, timeout, kill, env, resolution
npx vitest run --project core test/durable/worktree.test.ts   # run-level isolation + refusals
npx vitest run --project core test/durable/readonly.test.ts   # readonly_violation
```

Fixtures: `test/fixtures/scripts/` (`exit-75-twice.mjs`, `sleep-forever.mjs`, `fail.mjs`,
`env-keys.mjs`, `write-file.mjs`) and `test/support/git.ts` (`makeTempRepo` = checkout + local bare
origin + pushed commit + `origin/HEAD`, `installFixtureScript`, `writeScript`). Everything lives
under `os.tmpdir()`; no network and no daemon.

## RPC + CLI (Phase 8)

`packages/core/src/rpc/` is the control-plane contract (FR25–27). It has two subpaths:
`argos-core/rpc` (`contracts.ts` + `client.ts`; imports **no** durable code, safe for the CLI and the
plugin) and `argos-core/rpc/server` (`server.ts`; imports the durable host and is imported only by
`argos serve`). `rpc/summary.ts` projects mirrored documents to the public read model; it is
server-side only. The CLI source never imports `argos-core/durable`, `argos-core/git`, `node:sqlite`,
or `@earendil-works/*`, and only `commands/serve.ts` may import `argos-core/rpc/server`
(`packages/cli/test/import-graph.test.ts`).

### Contract (`contracts.ts`)

All bodies are strict zod schemas; `RPC_ERROR_STATUS` is the single code → HTTP status map.

```ts
StartRunRequest  { playbookId, inputs?: {name: scalar}, cwd?, isolation?: {mode, base?}, clientRequestId? }
StartRunResponse { runId, taskId }
DecideGateRequest { decision, comment?, decidedBy?, decidedVia?, clientRequestId? }
GateDecisionResponse { runId, gateId, decision, comment?, decidedBy?, decidedVia?, decidedAt }
RetryRequest { stepId }
CancelRunResponse { runId, status }
ErrorResponse { error: { code, message, details? } }
RunSummary { id, playbookId, playbookHash, status, inputs, cwd, worktree?,
             steps: [{id,title,kind,status,errorCode?,attemptCount,startedAt?,endedAt?}],
             gates: GateSummary[], after: [{id,title,trigger,status,...}], createdAt, updatedAt, seq }
GateSummary { runId, gateId, stepId, kind, question, choices, status,
              decision?, decidedBy?, decidedVia?, comment?, decidedAt? }
RunDetail = RunSummary + history: [{at, seq, type, stepId, attempt, detail}]   // bounded (≤500)
ServerInfo { name, rpcVersion, schemaVersion, pid, port, home, node, startedAt, uptimeMs,
             paseo, providers, pendingGates, runs: {total, active} }
DoctorReport = node/home/storage/schemaVersion/port/server/paseo/providers/pendingGates/runs/checks
```

`RunSummary`/`RunDetail` **never** contain `ir`, prompts, agent messages, or transcripts; inputs
whose names look like credentials (`SECRET_ENV_NAME_PATTERN`) are omitted. `RunDetail.gates` are the
gate documents projected to `GateSummary` (fresher than the mirrored record after a decision).

### Routes (`server.ts`, FR26)

| Route | Behaviour |
|---|---|
| `POST /runs` | load + validate the playbook from `cwd` (loader only), then `host.startRun`; `playbook_invalid` before any task |
| `GET /runs` | `{ runs: RunSummary[] }` from `argos.run.*` mirrors (newest first) |
| `GET /runs/:id` | `RunDetail` = summary + bounded history + gate documents |
| `POST /runs/:id/cancel` | `host.cancelRun` → engine `cancel`; `run_terminal` if already finished |
| `POST /runs/:id/retry` | `host.retryStep`: clone a terminal run into a fresh `argos.run` task (same `runId`), reset the step + downstream to `pending`, history `retry`; refuses non-terminal (`run_terminal`), unknown run/step (`run_unknown`/`step_unknown`) |
| `POST /runs/:id/gates/:gateId` | `host.decideGate`; first writer wins (`gate_already_decided`), `gate_unknown`, `run_terminal` |
| `GET /events` | SSE: `event: snapshot` (all summaries) then `event: run` per changed mirror; `: ping` heartbeat; commit-driven, no DB polling |
| `GET /info` | `ServerInfo` for `argos doctor` |
| `GET /health` | `{status:"ok"}` |

`POST /runs` defaults `cwd` to the server's cwd; the CLI always sends the caller's cwd. Declared
inputs are coerced (`number`/`boolean`/`enum`), defaults fill missing values, and a missing required
input is `invalid_request`. Bodies are capped at 1 MiB.

### Auth and idempotency

- **Token (FR27).** `ensureToken()` writes 32 random bytes as hex to `$ARGOS_HOME/token` (`0600`) on
  first serve; every request needs `Authorization: Bearer <token>` (SHA-256 + `timingSafeEqual`).
  Missing/bad → 401 `unauthorized`. The token is never logged. `OPTIONS` (CORS preflight) is the
  only unauthenticated method; CORS headers appear only when `cors` is configured.
- **D15.** `clientRequestId` is stored in the `argos.run` checkpoint (`lastClientRequestId`) **and**
  in the session document `argos.idempotency` keyed by the id (24 h TTL). The lookup + create is
  inside one commit, so concurrent repeats return the same `{runId, taskId}` and create one task.
  A gate decision is idempotent by `(gateId, decision, clientRequestId)` — an identical replay
  returns the winning receipt instead of `gate_already_decided`.
- **Run list.** `argos.runs` (singleton session doc) indexes every run id in the same commit that
  creates the run task (including after-task children and retry clones), so listing never scans
  task records. Runs created before Phase 8 are not in the index (pre-release; no migration).
- **New stable codes (Phase 8):** `invalid_request` (400), `run_unknown` (404), `step_unknown` (404).
  `RPC_ERROR_STATUS` also maps `unauthorized` 401, `playbook_missing` 400,
  `playbook_invalid`/`playbook_cycle`/`model_unavailable` 422, `gate_unknown`/`run_unknown`/
  `step_unknown` 404, `gate_already_decided`/`run_terminal`/worktree/concurrency codes 409,
  `paseo_unreachable`/`provider_exhausted`/`storage_locked` 503, unknown codes 500.

### CLI (`packages/cli`)

`bin: { "argos": "dist/index.js" }` with a shebang; `npm run build` runs a root `postbuild` that
`chmod +x`es it. `serve` is a **dynamic import**, so `argos run` never loads the durable host.

| Command | `--json` shape | Exit |
|---|---|---|
| `argos validate [path]` | `{valid, playbooks:[{id,file,hash}], errors:[{file,stepId,code,message}]}` | 0 valid, 2 invalid, 1 usage |
| `argos run <playbook> --input k=v [--cwd] [--isolation]` | `{runId, taskId}` | 0, 2 when the playbook/model is refused |
| `argos ls` | `{runs: RunSummary[]}` | 0 |
| `argos status <runId>` | `RunDetail` | 0 |
| `argos gates` | `{gates: GateSummary[]}` (pending only) | 0 |
| `argos decide <runId> <gateId> <decision> [--comment]` | `GateDecisionResponse` | 0 |
| `argos cancel <runId>` | `{runId, status}` | 0 |
| `argos retry <runId> <stepId>` | `{runId, taskId}` | 0 |
| `argos serve [--port] [--home]` | `{port, home, pid}` | 0 |
| `argos doctor [--home] [--port]` | `DoctorReport` | 0 (report), 1 old Node |

Human output is concise; JSON is pretty-printed (except `serve`, one compact line). Global exit
codes: **0** ok, **1** usage/runtime, **2** validation failure, **3** unauthorized/unreachable.
`argos run` with no server prints "start it with `argos serve`" and exits 3; it never opens SQLite.
`argos doctor` works without a server (storage path/modes, schema version, port, Node check) and adds
`/info` data when reachable (pid, Paseo reachability, providers, pending gates, run counters).
`argos serve` retries `ArgosHost.open` once on a transient failure, never on `storage_locked`, and
closes server → host → Paseo port on SIGINT/SIGTERM.

**`ARGOS_FAKE_PASEO=1`** is a **test-only** switch for `argos serve`: it uses
`createFakeStepExecutor()` (in-memory agents that finish on their first poll) and a fake provider
catalog from `argos-core/paseo`, so Phase 10's E2E needs no daemon or model. Never use it for real
work.

### Tests

```sh
npx vitest run --project core test/rpc                     # contract/auth/idempotency/SSE/retry/gates
npx vitest run --project cli test/validate.test.ts         # exit codes + file/step diagnostics
npx vitest run --project cli test/json-shapes.test.ts      # committed goldens (+ UPDATE_GOLDEN=1)
npx vitest run --project cli test/import-graph.test.ts     # CLI never imports durable/git/SQLite
npx vitest run --project cli test/sentinel.test.ts         # real serve/run children + DB sentinel
```

Goldens live in `packages/cli/test/golden/`; update deliberately with
`UPDATE_GOLDEN=1 npx vitest run --project cli`. The sentinel spawns the **built** CLI
(`packages/cli/dist/index.js`), so run `npm run build` first (root `npm test` already does). The
preload denies `node:sqlite`, `@earendil-works/*`, and any `argos.sqlite` open in the `argos run`
child; the test also asserts a second `argos serve` on the same home fails `storage_locked` naming
`serve.pid`, and that `argos doctor` reports the live server.

## Paseo plugin (Phase 9)

`packages/paseo-plugin` is a **thin HTTP client** of `argos serve` (FR28, FR29): a sidebar row, a
screen that lists runs/steps/gates, and four chat tools. It never opens SQLite and keeps no run
state, which is why a plugin reload cannot kill a run (D2: the engine lives in `argos serve`).

| File | Role |
|---|---|
| `paseo-plugin.json` | manifest: `id: argos`, `requirements.paseo: ">=0.15.3"` (validated by `test/manifest.test.ts`) |
| `index.server.ts` | default-exports `contribute(server)`; adds `agent.open.before`; teardown removes the hook and closes the HTTP client |
| `index.client.tsx` | default-exports `contribute(client)`; `addSidebarHeaderItem` + `addScreen` (`ARGOS_SCREEN_ID = "argos"`), theme tokens from props |
| `src/rpc-client.ts` | `createArgosClient()` — the only connection code; `PluginRpcError`, SSE parser/opener |
| `src/panel.ts` | pure panel model, `loadPanel`, `decideGateOnce`, `subscribeRuns`, `runView`/`panelView` |
| `src/tools.ts` | the four `defineAgentTool` definitions + `appendArgosTools` (dedupe by name) |
| `src/plugin.ts` | `createArgosRuntime` / `createArgosContribution` / `withArgosTools` (the server wiring) |
| `src/index.ts` | `PLUGIN_ID`, `REQUIRED_PASEO_VERSION` (cross-checked with the manifest) |

**Tool names (FR28, exact).** `argos_start_playbook` (`POST /runs`; `playbook_invalid`,
`invalid_request`, `playbook_cycle`, `playbook_missing`, and `worktree_base_dirty` all render as
`{isError:true, structuredContent:{error:{code:"playbook_invalid"}}}`), `argos_run_status`
(`GET /runs/:id`; step titles/statuses/error codes + gate choices, never prompts),
`argos_decide_gate` (`POST /runs/:id/gates/:gateId`, preserves `gate_already_decided`),
`argos_cancel_run` (`POST /runs/:id/cancel`, preserves `run_terminal`). Tools never throw: any
failure becomes a stable `{error:{code,message}}`. Inputs reuse the contract schemas
(`StartRunRequestSchema`, `DecideGateRequestSchema`) plus `runId`/`gateId`; a start call generates a
`clientRequestId` (D15) unless the caller supplies one.

**Server contribution.** `createArgosContribution({createClient?})` is the test seam; the default
export is the same factory with no options. One call creates one runtime (client + tools), registers
exactly one `agent.open.before` hook that returns
`{...request, tools: appendArgosTools(request.tools, runtime.tools)}`, and returns an idempotent
teardown that removes that hook and calls `client.close()` (which aborts every event stream). No
settings screen: `ARGOS_PORT`/`ARGOS_HOME` are read once per client (D2).

**Panel model (`src/panel.ts`, no React).** `PanelModel = {runs, gates (pending only), inFlight,
busyRuns, loading, connected, error, loadedAt}`; `loadPanel` sorts by `updatedAt` desc;
`decideGateOnce(model, action, {client, onModel})` publishes the in-flight model first (buttons
disable), performs **exactly one** `decideGate`, refreshes through `GET /runs`, returns
`decided | already_decided | failed | duplicate` (an action for a gate already in `inFlight` calls
nothing; `gate_already_decided` refreshes and never retries); `subscribeRuns({openEvents, onSnapshot,
onRun, onStatus, onReconnect, reconnect})` consumes `GET /events` (snapshot = full list, run = one
entry) and reconnects with capped exponential backoff (1 s doubling to 8 s), calling `onReconnect`
so the store re-fetches everything. `runView`/`panelView` map statuses to labels and semantic tones
(`neutral|accent|success|warning|danger`); `index.client.tsx` maps tones to `theme.colors`.

**Reload behaviour (FR29).** The plugin holds no durable state: teardown closes only HTTP, the run
continues in `argos serve`, and a new instance reconnects and sees the terminal status. The test
proves it in-process: a real `ArgosHost` (temp home, real SQLite) + `createRpcServer` + a
release-blocked fake executor; the panel sees `running`, the plugin is torn down, the run finishes,
and a second plugin instance sees `completed` with one launch per step.

**Import-graph rule (enforced by `test/import-graph.test.ts`).** No file under
`packages/paseo-plugin/src/` or either `index.*` entry may import `argos-core/durable`,
`argos-core/git`, `argos-core/paseo`, `argos-core/engine`, `argos-core/playbook`,
`argos-core/rpc/server`, the `argos-core` root, `@earendil-works/*`, `node:sqlite`, `node:fs`, or
`node:child_process`. The only `argos-core` subpath is `argos-core/rpc`; other imports are limited to
`@getpaseo/*`, `react`, and `zod`. `argos-core` is an exact workspace dependency (`0.0.0`);
`react`/`@types/react` are exact dev dependencies for the `.tsx` typecheck.

Typecheck is split so the JSX never leaks into the server graph: `tsconfig.json` (builds `src/` to
`dist/`), `tsconfig.test.json` (tests), `tsconfig.entry.json` (`index.server.ts`, node types),
`tsconfig.client.json` (`index.client.tsx`, `jsx: react-jsx` + DOM lib). All four run under
`npm run typecheck`.

```sh
npx vitest run --project paseo-plugin                              # all plugin tests
npx vitest run --project paseo-plugin test/manifest.test.ts        # manifest schema + entry
npx vitest run --project paseo-plugin test/contribute.test.ts      # hook, dedupe, teardown
npx vitest run --project paseo-plugin test/panel.test.ts           # decide-once, SSE reconnect
npx vitest run --project paseo-plugin test/tools.test.ts           # tool names + error shape
npx vitest run --project paseo-plugin test/reload.test.ts          # run survives a plugin reload
npx vitest run --project paseo-plugin test/import-graph.test.ts    # no storage/git/SQLite import
```

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
| `zod` | `4.6.7` | `packages/core`, `packages/paseo-plugin` | playbook schema, RPC contract, and tool inputs |
| `react` | `19.3.0` | `packages/paseo-plugin` dev | the `.tsx` client entry; matches the SDK peer range |
| `@types/react` | `19.3.0` | `packages/paseo-plugin` dev | types for the same JSX |

`@getpaseo/plugin` peer-depends on React `>=19.1.0 <20`; `react@19.3.0` is installed (the peer and
the plugin workspace's pinned dev dependency are the same version).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ARGOS_HOME` | `~/.argos` | state dir, mode `0700`; DB `argos.sqlite` (`0600`), `token`, `serve.pid` |
| `ARGOS_PORT` | `7676` | `argos serve` port on `127.0.0.1` |
| `ARGOS_PASEO_URL` | `ws://127.0.0.1:6767/ws` | Paseo daemon WebSocket URL (Phase 6, read only by `src/paseo/client.ts`) |
| `ARGOS_PASEO_PASSWORD` | (unset) | daemon password; never logged, redacted from errors |
| `ARGOS_FAKE_PASEO` | (unset) | `1` = test-only deterministic executor for `argos serve` (Phase 8/10) |

## Invariants

- **No LLM in control flow.** Transitions are decided by the engine, never by a model.
- **One writer.** Only `argos serve` opens `$ARGOS_HOME/argos.sqlite`; CLI and plugin talk HTTP.
- **Loopback + token.** Errors are stable codes (`playbook_invalid`, `storage_locked`, …);
  secrets never reach the DB or logs.
