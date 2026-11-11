# AGENTS.md

Argos is a durable YAML playbook engine for Paseo agents. A repository declares its workflow in
`.argos/playbooks/*.yaml`; a deterministic engine executes it, launching Paseo agents for the work
inside each step, with parallel steps, human gates, loops, script steps, worktree isolation, and
crash-safe resumption. v1 (Phases 1–10) is complete; `npm test`, `npm run typecheck`, and
`npm run test:e2e` are green.

Approved spec and plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_spec_argos_yaml_playbook_engine.md` and
`03_impl_argos_yaml_playbook_engine.md`. The earlier 02 spec is superseded (no LLM in the control
path; YAML playbooks/DAG/gates/loops replace the orchestrator loop).

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

## Invariants

- **No LLM in control flow.** Readiness, transitions, loop limits, gates, retries, and timeouts are
  decided by the pure engine. A model only does the work inside a step.
- **One writer.** Only `argos serve` opens `$ARGOS_HOME/argos.sqlite`. The CLI and plugin talk
  HTTP; a second live owner is refused with `storage_locked` naming `serve.pid`.
- **Loopback + token.** The server binds `127.0.0.1` and requires
  `Authorization: Bearer <token>`; tokens and secrets never reach the database or logs.
- **Stable codes.** Callers match on `ArgosError.code`, never on message text.
- **Same-commit mirrors.** Run/history documents are committed with the task checkpoint.
- **Definition freeze.** A run stores the fully resolved IR + hash; it never reloads the playbook.

## Commands (run from the repo root)

```sh
npm ci            # reproducible install from package-lock.json
npm test          # builds workspaces (tsc -b) then vitest over all projects; excludes e2e
npm run typecheck # tsc -b for src, then tsc --noEmit for every test/entry graph
npm run test:e2e  # builds, then the real-process SIGKILL/restart suite
npm run build     # tsc -b (emits dist/ for every workspace)
node -e "import('argos-core')"   # workspace-link check; requires a build first
```

`npm test` stays fast and process-free. The E2E suite is deliberately a separate project
(`vitest.e2e.config.ts`, `packages/core/test/e2e/`) and CI runs it after the unit suite.
Targeted runs:

```sh
npx vitest run --project core packages/core/test/durable
npx vitest run --project core packages/core/test/paseo
npx vitest run --project core packages/core/test/rpc
npx vitest run --project cli
npx vitest run --project paseo-plugin
npx vitest run --config vitest.e2e.config.ts
```

Package `exports` point at `dist/`, so anything importing a sibling workspace needs a build.

## Storage layout and permissions

| Path | Mode | Purpose |
|---|---|---|
| `$ARGOS_HOME` | `0700` | default `~/.argos`; created/repaired on open and on serve |
| `$ARGOS_HOME/argos.sqlite` | `0600` | pi-durable SQLite; the single source of truth |
| `$ARGOS_HOME/token` | `0600` | 32 random bytes hex; created on first serve |
| `$ARGOS_HOME/serve.pid` | `0600` | single-writer pid file; dead pids are stale and replaced |
| `$ARGOS_HOME/worktrees/<runId>/` | — | isolated run checkouts (never auto-removed) |
| `$ARGOS_HOME/fake-paseo.json` | `0600` | **test-only** fake agent snapshot |
| `$ARGOS_HOME/fake-paseo-launches.jsonl` | `0600` | **test-only** fake creation ledger (E2E) |

`ArgosHost.open({ home?, storage?, executor, clock?, models? })` ensures the home, takes the pid
file, opens the database, installs the `argos` extension, and calls `resume()`; `close()` is
idempotent and removes the pid file only when it still names this process. A `storage` injection
(`MemoryStorage`) skips the home/pid setup for fast tests.

## Task kinds and versions

| Task | Version | Phases |
|---|---|---|
| `argos.run` | 1 | `select → await → settle → gate → done` |
| `argos.step` | 1 | `locate → launch → await → collect` |
| `argos.script` | 1 | `prepare → run → collect` |
| `argos.gate` | 1 | `await → decided` |

Checkpoints are discriminated unions of per-phase shapes (pi-durable narrows each handler with
`Extract<S, {phase: P}>`). The run task is conversation-owned by `argos.host`; step/script/gate
tasks are owned by their run task. Phase handlers must not depend on playbook content: the
definition is static and `migrate()` is the tool for a future shape change.

## Document kinds

| Kind | Key | Content |
|---|---|---|
| `argos.run` | `runId` | `{ taskId, record }` — the complete mirrored `RunRecord` |
| `argos.history` | `runId` | append-only `{ events: [...] }`, capped at 500 (oldest dropped) |
| `argos.gate` | `${runId}.${gateId}` | `{ status: pending\|decided, decision, comment, decidedBy, decidedVia, decidedAt, … }` |
| `argos.idempotency` | `clientRequestId` | replay cache for `POST /runs` and gate decisions, 24 h TTL |
| `argos.runs` | singleton | run-id index; listing never scans task records |

Run and history are written in the same `runtime.commit()` as the task checkpoint. A commit that
only advances a phase may write an identical document (Chord stores no new revision); that is
expected. Gate ids are `<stepId>:<n>`, so `${runId}.${gateId}` cannot collide.

## Error codes

Every deliberate failure is an `ArgosError` with one of these codes. The HTTP column is
`RPC_ERROR_STATUS` for the same code; CLI exit is `2` for validation codes
(`playbook_invalid`, `playbook_cycle`, `playbook_missing`, `model_unavailable`), `3` for
`unauthorized`/unreachable, and `1` otherwise.

| Code | When | HTTP |
|---|---|---|
| `playbook_invalid` | load/validate failure; message names file + step | 422 |
| `playbook_cycle` | dependency cycle or sub-playbook recursion | 422 |
| `playbook_missing` | unknown playbook id or unreadable file | 400 |
| `model_unavailable` | resolved `provider/model` absent from `providers.snapshot()`; refused before any task | 422 |
| `storage_locked` | another live process owns the home/SQLite (or host already closed) | 503 |
| `paseo_unreachable` | Paseo client cannot connect | 503 |
| `agent_missing` | agent archived/unknown after the one allowed handover | 409 |
| `launch_uncertain` | crash window and the daemon cannot filter by label; never blind-relaunch | 409 |
| `invalid_output` | schema-invalid step result after retries | 422 |
| `readonly_violation` | read-only step changed the working tree | 409 |
| `worktree_failed` | worktree creation/attachment failed | 409 |
| `worktree_base_dirty` | source checkout dirty before isolation | 409 |
| `provider_exhausted` | every fallback target quota-blocked | 503 |
| `gate_already_decided` | duplicate decision while the gate is active; names the winner | 409 |
| `gate_unknown` | unknown run/gate id, or a decision outside the gate's choices | 404 |
| `loop_limit` | reserved for the loop-limit gate contract; `max_loops` itself opens a gate, it is not an error | 409 |
| `step_failed` | step terminal failure (script non-zero exit, undeclared outcome, …) | 502 |
| `step_timeout` | step timeout after retries | 504 |
| `script_timeout` | script still running (or exiting 75) at its step deadline | 504 |
| `concurrency_limit` | reserved for callers that enforce a playbook-level concurrency refusal; the engine parks extra steps as `ready` instead | 409 |
| `unauthorized` | missing/bad bearer token | 401 |
| `run_terminal` | write attempted on a finished run (e.g. deciding a gate afterwards) | 409 |
| `invalid_request` | malformed/strict-body request, bad input coercion, body > 1 MiB | 400 |
| `run_unknown` | `GET /runs/:id` for an unknown run | 404 |
| `step_unknown` | `POST /runs/:id/retry` for an unknown step | 404 |

Protocol-only responses (`not_found`, `method_not_allowed`, `internal_error`) are not
`ArgosErrorCode`s; unknown codes map to HTTP 500.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `ARGOS_HOME` | `~/.argos` | state directory (`0700`); DB `argos.sqlite`, `token`, `serve.pid` |
| `ARGOS_PORT` | `7676` | `argos serve` port on `127.0.0.1`; `0` picks a free port |
| `ARGOS_PASEO_URL` | `ws://127.0.0.1:6767/ws` | Paseo daemon URL (read only by `src/paseo/client.ts`) |
| `ARGOS_PASEO_PASSWORD` | (unset) | daemon password; never logged, redacted from errors |
| `ARGOS_FAKE_PASEO` | (unset) | **test-only** `1` = deterministic executor for `argos serve` |
| `ARGOS_FAKE_PASEO_DIR` | `$ARGOS_HOME` | **test-only** fake state directory |
| `ARGOS_FAKE_PASEO_BLOCK_STEP` | (unset) | **test-only** step id whose fake agents report `running` until released |
| `ARGOS_FAKE_PASEO_RELEASE_FILE` | (unset) | **test-only** file whose appearance releases the blocked step (checked on every status poll) |

Never use `ARGOS_FAKE_PASEO*` for real work: it creates no real agents and reports deterministic
success.

## Playbook layer

`packages/core/src/playbook/` is the compatibility contract: `schema.ts` (zod raw YAML),
`load.ts` (discovery + read-only pipeline), `resolve.ts` (agent precedence, input wiring,
condition/transition normalization), `expand.ts` (sub-playbooks), `validate.ts` (graph checks),
`hash.ts` (canonical JSON + sha256), `ir.ts` (the frozen JSON IR the rest of Argos consumes).

- Discovery: `.argos/playbooks/*.yaml` then `.paseo/plugins/playbooks/*.yaml` (same fallback for
  `roles/`, `defaults/main.yaml`, `scripts/`); playbook id = filename. `loadPlaybook(repoDir, id)`
  returns a deep-frozen `PlaybookIR` with `hash`; it never writes.
- Aliases normalized: `poll_ms` | `pollMs` | `poll` → `pollMs` (D3 defaults 3000/2000/5000);
  `mode` | `mode_id` → `modeId`; `playbook: {name}` | `playbook: <id>` | `use: <id>` → sub-playbook;
  flat `gate`/`choices`/`script` and paseo block forms both load; `goto` accepts a bare id with
  sibling `max_loops` or `{target, max_loops}`.
- Errors are `ArgosError` with the plan's stable code; loader/validator failures are
  `playbook_invalid`, `playbook_cycle`, or `playbook_missing` and always name file + step.
- Golden compat fixtures live in `packages/core/test/fixtures/compat/` (copied from
  `lerenn/paseo-playbooks`, MIT; see `test/fixtures/ATTRIBUTION.md`). Alias, invalid, sub-playbook,
  precedence, `when`/`branch`, and discovery fixtures sit next to them. `docs/compat.md` lists
  every divergence with its fixture/test.

## Pure engine

`packages/core/src/engine/` is the pure decision layer: no I/O, no timers, no durable or Paseo
imports. `purity.test.ts` enforces the import graph. Consumers use the barrel
(`import { next, createRunRecord, hydrateRunRecord } from "argos-core/engine"`).

```ts
next(record: RunRecord, event: EngineEvent): { record: RunRecord; effects: readonly Effect[] }
```

- `RunRecord` is the whole checkpoint: frozen IR + inputs + step/gate/loop state.
  `createRunRecord` starts every step `pending`; `hydrateRunRecord` validates strictly and returns
  the input untouched, so `JSON.stringify(hydrate(json)) === json`.
- Run statuses: `pending | running | waiting | completed | failed | cancelled` (`waiting` = a gate
  is pending and nothing else runs). Step statuses: `pending | ready | running | waiting |
  completed | failed | skipped` (`ready` = eligible but held by `concurrency`; `waiting` = parked
  on a gate).
- Events: `tick`, `stepAttemptStarted`, `stepSettled`, `gateDecided`, `cancel`; all accept an
  optional `now`, and the record's `updatedAt` is the event time, never the wall clock.
- Effects: `dispatchStep`, `openGate`, `finishRun`, `startAfterTask`, `decisionRejected`,
  `scheduleWake`. The reducer never performs them.
- Readiness: a step is ready when it is `pending`/`ready`, every `needs` dependency is completed
  or skipped, `notBefore <= now`, and `when` holds. Steps whose dependencies are satisfied but
  `when` is false are skipped (and do not block). Conditions read
  `steps.<id>.outputs.<name>`, `steps.<id>.outcome`, `steps.<id>.status`, and
  `playbook.inputs.<name>` / `inputs.<name>`; operands are scalar equality, array membership, or
  `{empty: true|false}`. No LLM is consulted.
- `on` mapping: `complete` completes; `end` finishes the run with an optional outcome; `fail`
  fails step + run with `step_failed`; `goto` re-queues the target; `ask` opens a gate. An outcome
  without an `on` entry is a plain `complete`; an undeclared outcome is a runtime `step_failed`.
  A `fail`/executor error bypasses outcome routing.
- `goto` resets the target and every transitively downstream step; outputs and attempts are kept;
  `outcome`/`errorCode`/feedback are cleared. Feedback from the settle or gate comment lands on the
  re-queued roots as `StepRecord.feedback` for `{{ feedback }}`.
- Loops: edge label `<source>-><declaredTarget>` (e.g. `review->fix`); `loops[edge]` counts
  traversals, `loopAllowance[edge]` counts human grants. `max_loops: 2` allows exactly two
  returns; the next attempt opens a loop-limit gate. Approve adds one allowance and traverses;
  reject fails the step with `step_failed`. Absent `max_loops` = unlimited.
- Gate ids: `<stepId>:<n>`, 1-based per step; step and loop-limit gates share the counter. The
  loop gate's `edge` names the edge. A decision outside the choices is `gate_unknown`; duplicates
  emit `decisionRejected` without touching the record.
- `decideGate(record, request)` is the pure decision entry point; the host uses it before writing
  anything. It rejects unknown gates (`gate_unknown`), duplicates (`gate_already_decided` naming
  the winner), and finished runs (`run_terminal`).
- Timeouts: per-step `timeout` (default 30m) resolved at use time (number ms, duration string, or
  whole-value `{{ inputs.t }}`); timed-out attempts retry per `retries` with deterministic
  1s/2s/4s… backoff capped at 60s; otherwise `step_timeout`. `RunRecord.deadline` is absolute and
  fails the run immediately.
- Main loop: on every event, skip `when:false`, settle branch steps, open gate steps, then
  dispatch ready non-gate steps in IR order up to `concurrency` running steps; over-cap steps are
  `ready`. When all main steps are terminal the run finishes (`completed`, or `failed` if a step
  failed). `auto` after-tasks start once and never change `run.status`; `manual` stay pending.
- Attempt history is not capped in the checkpoint (the bounded history document is capped at 500).
  Outputs are append/overwrite only.

## Durable host

`packages/core/src/durable/` is the only importer of `@earendil-works/*` (and `src/git/`). The
public surface is the `argos-core/durable` subpath; it is deliberately **not** re-exported from
the package root so the CLI and plugin cannot open SQLite by accident.

`ArgosHost` (`host.ts`) owns one SQLite file. `startRun({ ir, inputs, cwd, worktree?, deadline?,
id? })` returns `{ runId, taskId }`: `runId` is a dependency-free ULID, `taskId` is pi-durable's
numeric task id stringified at the boundary. The run task is conversation-owned by the root
conversation (D5) and the initial mirror is written in the same commit. `resume()`/`close()`/
`getRun`/`getHistory`/`getTaskRecord`/`inspect` are the read/lifecycle surface; `open` and
`startRun` both resume so scheduling never depends on the caller.

`models` (D6) is a Proxy stub: `Harness.open` reads `getAuth` once, so the property returns a
function that throws when **called**; `has` reports `false`. The engine never asks for a model,
and no `pi.generation` task may ever appear in `inspect()`.

### Tasks

```ts
argos.run  v1: "select" | "await" | "settle" | "gate" | "done"
  { phase, record, childTasks, dispatched, awaiting, settles,
    gateTasks, gateSettles, afterTasks, finished? }

argos.step v1: "locate" | "launch" | "await" | "collect"
  { phase, requestId, attempt, label, deadlineAt, polls,
    agentId?, target?, launchedAt?, status?, errorCode?,
    launchAttempted, handoverAttempted?, exhausted, snapshotBefore?,
    readonlyViolation?, detail? }

argos.script v1: "prepare" | "run" | "collect"
  { phase, attempt, runs, deadlineAt, scriptPath?, exitCode?, signal?,
    stdout?, stderr?, lastRunAt?, detail?, errorCode?,
    snapshotBefore?, readonlyViolation? }

argos.gate v1: "await" | "decided"
  { phase, gateId, runId, stepId, kind, edge?, question, choices, seenAt,
    decision?, comment?, decidedBy?, decidedVia?, decidedAt? }
```

`select` feeds `next(record, {type:"tick"})`, creates one child per effect in the same commit as
the mirror/history, then commits `waiting { on: childIds, policy: "allSettled" }`. `await` maps
child outcomes to `stepSettled`/`gateDecided`; `settle` applies them through `next()`. `gate` is
the recovery path: a pending gate with no live child gets a fresh `argos.gate` child with the same
id. `done` creates `auto` after-task children and commits the terminal outcome.

`argos.step`:

1. `locate` commits `{ requestId, label, attempt, deadlineAt }` before any executor call (and the
   read-only snapshot, if `readonly`).
2. `launch` commits `launchAttempted` **before** the executor call, calls `launch()` (adopt by
   `requestId`, never create twice), and commits `agentId`.
3. `await` calls `status()` and parks in `sleeping { until: now + pollMs }` while running (D3 step
   default 3000). The first call happens on entry, then on every wake.
4. `collect` optionally calls `collect()`, normalizes outputs to scalars (`invalid_output` on a
   non-scalar), applies the readonly comparison, and commits a terminal completed task carrying
   `{ stepId, attempt, requestId, outcome?, outputs?, errorCode?, agentId?, target?, usage? }`.
   A failed step is a completed task with an `errorCode`.

Errors are explicit: `startAfterTask` is recorded as `after_queued` and executed by `done`;
`decisionRejected` is logged as `effect_skipped` (the host validates first, so it is a bug
signal); `scheduleWake` narrows the next poll. A phase that throws commits a cancelled, mirrored
run plus a `task_error` history event and a failed task outcome, so a run is never abandoned
without a terminal state.

**Retries/timeouts deviation.** The run task is parked in `waiting` and does not tick, so per-step
`timeout`/`retries` are enforced inside `argos.step`: a poll after `deadlineAt` either relaunches
with a fresh attempt/request id after backoff, or collects `step_timeout`. The run record records
one dispatch attempt per child task; local attempts are visible in the step checkpoint/history.

### Gates and after-tasks

`openGate` creates one `argos.gate` child and the pending document in the same commit, then the
run waits on it. `await` re-reads the document and parks in `sleeping` for `GATE_POLL_MS` (2000,
`durable/context.ts`) while pending; `decided` commits a terminal task whose result is
`{ runId, gateId, decision, comment?, decidedBy?, decidedVia?, decidedAt }`. A restart resumes the
same gate id — nothing is renumbered.

`ArgosHost.decideGate(runId, gateId, decision, {comment?, decidedBy?, decidedVia?})` reads the run
record and writes the document inside **one** `root.commit()`; the first writer wins. Codes:
`gate_unknown` (unknown run/gate id or out-of-choice decision), `gate_already_decided` (names the
winner), `run_terminal` (finished run). The gate child maps the result to `gateDecided`, so the
reducer applies it:

- `step` gate: the decision id is the step outcome, routed through `on`;
- `ask` gate: the chosen choice's `outcome`/`goto` (default: the ask target);
- `loop_limit` gate: `approve` adds exactly one allowance for the edge and re-fires it; anything
  else fails the step with `step_failed`.

The decision comment becomes `StepRecord.feedback` on the re-queued roots (rendered into the next
prompt and passed as `LaunchInput.feedback`).

`after[id]` starts `pending`. When the main graph is terminal, `auto` entries become `running` and
`startAfterTask` fires; the run's `done` phase creates one `argos.run` child per entry with a
scoped IR (`<playbookId>/<afterId>`, fresh content hash) and only then commits the parent's
terminal outcome. `manual` entries stay pending until `ArgosHost.startAfterTask(runId, afterId)`
(no HTTP route in v1; see limitations). An after-task never changes the parent's `run.status`:
the parent mirror's `after[id]` is host-owned bookkeeping.

## Paseo adapter

`packages/core/src/paseo/` is exposed on `argos-core/paseo`, never from the package root.
`client.ts` is the **only** file allowed to import `@getpaseo/*`; every test uses
`test/fakes/paseo.ts` or the deterministic fake, so no test opens a socket.

```ts
interface PaseoPort {
  readonly supportsLabelFilter: boolean;
  listByLabels(labels): Promise<AgentRef[]>;
  create(input): Promise<AgentRef>;
  refresh(agentId): Promise<AgentInfo | null>;
  waitForFinish(agentId, timeoutMs): Promise<FinishResult>;
  archive(agentId): Promise<void>;
  providersSnapshot(): Promise<ProviderCatalog>;
}
```

| Port error | Argos code / behavior |
|---|---|
| `PaseoUnreachableError` | `paseo_unreachable` (poll-time parks until deadline; launch-time fails the step) |
| `LabelFilterUnsupportedError` | `launch_uncertain` in the crash window |
| `QuotaError` | next fallback target; all blocked → `provider_exhausted` |
| `AgentMissingError` | one handover relaunch, then `agent_missing` |
| `ProviderTimeoutError` | keeps polling; the durable deadline owns retries |

Classification is centralized in `port.ts` (`isQuotaError`, `isLabelFilterUnsupported`,
`isConnectionError`, `isAgentMissing`, `classifyPaseoFailure`), matching message/code/HTTP status
because the daemon exposes no typed quota enum. `client.ts` maps connect/auth failures to
`paseo_unreachable`, redacts `ARGOS_PASEO_PASSWORD`, connects lazily, reuses the client, and
disables the SDK's reconnect loop (Argos paces retries).

**Targets/quota (FR24).** `model-catalog.ts` loads `providers.snapshot()`. `resolveStepTargets`
returns the resolved step agent then role fallbacks, deduped. `missingTargets` checks main and
after-task steps, renders whole-value `{{ inputs.x }}`, accepts aliases, and returns every unknown
target; `startRun` refuses `model_unavailable` before any task. Quota is a target hop, not a retry:
`agent-step.ts` keeps a ledger merged with the run record's `exhausted`, and `argos.run` merges it
into `RunRecord.exhausted` before mirroring. All blocked → `provider_exhausted`. The primary
target's `modeId`/`thinking` apply; fallbacks carry provider/model only.

**Structured output (D12).** `output.ts` compiles `outputs` + `outcomes` to
`{ type:"object", properties:{...}, required:[...], additionalProperties:false }`.
`parseStepResult` prefers a structured `output`; invalid output is not re-parsed as prose. Plain
text is parsed only when outputs are declared, and only from one fenced ```json block or a bare
JSON object; two fences is ambiguous → `invalid_output`. `invalid_output` retries like a timeout.
`PROVIDER_OUTPUT_CAPABILITIES` records the manual probe; unknown providers default to structured.

**Launch/crash/handover.** `launch` adopts the first non-archived agent matching
`{ "argos/launch": requestId }`, else creates with provider, `cwd`, rendered prompt (including
`{{ feedback }}`), labels `argos/launch|run|step|attempt`, and `outputSchema`; `idempotencyKey` is
the request id. `launchAttempted` is committed before the executor call; if labels cannot be
filtered and a re-entry sees it, `launch` fails `launch_uncertain` instead of blind-relaunching.
An archived/missing agent triggers one handover (archive + replacement with `argos/handover=1`
and a prompt note); a second occurrence is `agent_missing`.

The SDK's `waitForFinish()` exposes text but no structured JSON value, so the port leaves
`FinishResult.output` undefined and relies on the fenced-JSON fallback.

**Deterministic fake.** `fake.ts` is used only by `ARGOS_FAKE_PASEO=1`. In-memory by default;
file-backed when a `statePath` is passed (`argos serve` passes `$ARGOS_HOME`). `fake-paseo.json`
is the snapshot, `fake-paseo-launches.jsonl` the append-only creation ledger (the E2E counts
creations there). The fake reads the test-only block/release env knobs documented above.

## Scripts, worktrees, read-only

A script step is dispatched by the same `dispatchStep` effect and settles through the same
`stepSettled` event as an agent step. `argos.script` is created for a frozen `kind: script` step;
every other non-gate step keeps the agent executor.

- Resolution: `<script>` must be a bare file name (no `/`, no `..`, not absolute), looked up in
  `.argos/scripts/` then `.paseo/plugins/playbooks/scripts/` of the **run cwd**, and must be an
  executable regular file. Resolution uses the repo root (so local helpers work); execution uses
  `cwd = worktree.path` when isolation is on, otherwise the run cwd. Missing/non-executable →
  `step_failed` naming the tried paths.
- `run` spawns with `shell: false`, the filtered env, and bounded (8 KiB) stdout/stderr **tails**.
  Exit `75` (`SCRIPT_NOT_YET`) commits `sleeping { until: now + pollMs }` and re-runs with
  `runs + 1`; any other non-zero exit is terminal. A script still alive at the deadline is killed
  and fails `script_timeout`. The child is killed on `runtime.signal` abort and on deadline; on
  POSIX it is `detached` and killed by process group.
- `collect` commits a terminal completed task whose result is a `StepTaskResult`; success reports
  outcome `success` (or the first declared outcome) and exposes `stdout`, `stderr`,
  `exitCode`/`exit_code`, `runs`. Declared output names are never parsed as JSON. The receipt also
  carries `exitCode`, `runs`, `signal`, and a bounded `detail`.
- Env filter (D10, `src/engine/env.ts`): drop keys matching
  `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` unless declared in `env`; always keep `PATH`, `HOME`,
  `LANG`, `TMPDIR`, plus `TMP`, `TEMP`, `SystemRoot`. Baseline names match case-insensitively;
  declared names match exactly. Output keys are sorted for byte-stable checkpoints/logs. The same
  pattern redacts secrets from git error messages.

**Worktree isolation (D9).** `createRunWorktree({ repo, home, runId, base?, git? })` →
`{ path, branch, baseSha }`: `<ARGOS_HOME>/worktrees/<runId>`, branch `argos/<runId>`, created
from `origin/<base>` after `git fetch --prune origin`. Base order: `isolation.base` →
`refs/remotes/origin/HEAD` → the current branch when `origin/<branch>` exists → `origin/main` →
`origin/master`. A dirty source checkout is `worktree_base_dirty` before `git worktree add`; an
unresolvable base or other git failure is `worktree_failed` with redacted stderr. Idempotent per
run id: a clean existing worktree is returned, a branch without checkout is re-attached, a dirty
one is refused. `startRun` creates it when the effective isolation is `{mode:"worktree"}` (from the
IR or the `--isolation` override), stores it in `RunRecord.worktree`, and gives every agent/script
child the worktree as `cwd`. Refusals happen before the run task exists, so no agent launches.
Worktrees are never removed automatically; `removeRunWorktree` keeps the branch, and
`listRunWorktrees` lists them. `src/git/exec.ts` is the only git spawner: `execFile("git", [args])`,
never a shell/library; `GitRunner` is injectable.

**Read-only guard (D8).** `role.readonly` becomes `readonly: true` on the step/script input.
Before launch (or the script's first execution) `takeSnapshot(cwd)` records `git rev-parse HEAD`
plus `git status --porcelain=v1 -z`; `collect` takes a second snapshot and compares. Any
difference fails the step with `readonly_violation` and drops its outputs; changed paths are
committed as `readonlyViolation` before the terminal outcome, and the worktree is left as the step
left it. A read-only step in a non-git directory fails `step_failed` instead of pretending; a step
whose role is not read-only is not snapshotted. **The guard detects, it does not prevent**:
created-and-deleted files, new files inside an already-untracked directory (the `?? dir/` entry
does not change), and ignored paths are invisible.

## RPC + CLI

`packages/core/src/rpc/` has two subpaths: `argos-core/rpc` (`contracts.ts` + `client.ts`; no
durable imports, safe for CLI/plugin) and `argos-core/rpc/server` (`server.ts`; imports the
durable host and is imported only by `argos serve`). `rpc/summary.ts` projects mirrored documents
to the public read model. The CLI source never imports `argos-core/durable`, `argos-core/git`,
`node:sqlite`, or `@earendil-works/*`; only `commands/serve.ts` may import
`argos-core/rpc/server` (`packages/cli/test/import-graph.test.ts`).

Contract highlights: `StartRunRequest`, `DecideGateRequest`, `RunSummary`, `RunDetail`,
`ServerInfo`, `DoctorReport`. `RunSummary`/`RunDetail` never contain `ir`, prompts, agent
messages, transcripts, or credential-like inputs; `RunDetail.gates` comes from the gate documents
(fresher than the mirror after a decision). All bodies are strict zod schemas; `RPC_ERROR_STATUS`
is the single code → HTTP map; bodies are capped at 1 MiB.

| Route | Behavior |
|---|---|
| `POST /runs` | load + validate from `cwd`, then `host.startRun`; `playbook_invalid` before any task |
| `GET /runs` | `{ runs }` newest first, from the `argos.runs` index |
| `GET /runs/:id` | `RunDetail` = summary + bounded history + gate documents |
| `POST /runs/:id/cancel` | engine `cancel`; `run_terminal` if finished |
| `POST /runs/:id/retry` | clone a terminal run into a fresh task (same `runId`), reset the step + downstream; refuses non-terminal (`run_terminal`), unknown run/step |
| `POST /runs/:id/gates/:gateId` | first writer wins; `gate_unknown`/`gate_already_decided`/`run_terminal` |
| `GET /events` | SSE: one `snapshot` then `run` per changed mirror; `: ping` heartbeat; commit-driven |
| `GET /info`, `GET /health` | doctor data / liveness |

`POST /runs` defaults `cwd` to the server's cwd; the CLI always sends the caller's cwd. Declared
inputs are coerced (`number`/`boolean`/`enum`), defaults fill missing values, a missing required
input is `invalid_request`.

**Auth/idempotency.** `ensureToken()` writes 32 random bytes as hex to `$ARGOS_HOME/token`
(`0600`) on first serve; every request needs `Authorization: Bearer <token>` (SHA-256 +
`timingSafeEqual`). The token is never logged. `OPTIONS` is unauthenticated; CORS headers appear
only when configured. `clientRequestId` is stored in the run checkpoint (`lastClientRequestId`)
and in `argos.idempotency` (24 h TTL); the lookup + create share one commit, so concurrent
repeats return the same `{runId, taskId}`. A gate replay is idempotent by
`(gateId, decision, clientRequestId)`. The `argos.runs` singleton indexes every run id in the same
commit that creates the run task, including after-task children and retry clones.

### CLI

`bin: { "argos": "dist/index.js" }` with a shebang; `npm run build` runs a root `postbuild` that
`chmod +x`es it. `serve` is a **dynamic import**, so `argos run` never loads the durable host.

| Command | `--json` shape | Exit |
|---|---|---|
| `argos validate [path]` | `{valid, playbooks:[{id,file,hash}], errors:[{file,stepId,code,message}]}` | 0 valid, 2 invalid, 1 usage |
| `argos run <playbook> --input k=v [--cwd] [--isolation]` | `{runId, taskId}` | 0, 2 when refused |
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
`argos run` with no server prints "start it with `argos serve`" and exits 3; it never opens
SQLite. `argos doctor` works without a server (storage path/modes, schema version, port, Node
check) and adds `/info` data when reachable. `argos serve` retries `ArgosHost.open` once on a
transient failure, never on `storage_locked`, and closes server → host → Paseo port on
SIGINT/SIGTERM. `ARGOS_FAKE_PASEO=1` selects the deterministic executor/fake catalog; it is
test-only.

## Paseo plugin

`packages/paseo-plugin` is a thin HTTP client: a sidebar row, a screen listing runs/steps/gates,
and four chat tools. It never opens SQLite and keeps no run state, so a plugin reload cannot kill a
run (the engine lives in `argos serve`).

| File | Role |
|---|---|
| `paseo-plugin.json` | manifest: `id: argos`, `requirements.paseo: ">=0.15.3"` |
| `index.server.ts` | default-exports `contribute(server)`; `agent.open.before`; teardown removes the hook and closes the client |
| `index.client.tsx` | `addSidebarHeaderItem` + `addScreen` (`ARGOS_SCREEN_ID = "argos"`), theme tokens |
| `src/rpc-client.ts` | `createArgosClient()`; `PluginRpcError`, SSE parser/opener |
| `src/panel.ts` | pure panel model, `loadPanel`, `decideGateOnce`, `subscribeRuns`, `runView` |
| `src/tools.ts` | four `defineAgentTool` definitions + `appendArgosTools` |
| `src/plugin.ts` | `createArgosRuntime` / `createArgosContribution` / `withArgosTools` |

Tool names (exact): `argos_start_playbook` (`POST /runs`; playbook errors render as
`playbook_invalid`), `argos_run_status` (`GET /runs/:id`; never prompts), `argos_decide_gate`,
`argos_cancel_run`. Tools never throw; failures become `{error:{code,message}}`. A start call
generates a `clientRequestId` unless supplied.

`createArgosContribution({createClient?})` is the test seam. One call creates one runtime and
registers exactly one `agent.open.before` hook that appends the tools; teardown removes that hook
and closes the client (aborting streams). No settings screen: `ARGOS_PORT`/`ARGOS_HOME` are read
once per client. The panel publishes an in-flight model before deciding (buttons disable), calls
`decideGate` exactly once, treats an already-decided gate as refresh-without-retry, and reconnects
SSE with capped exponential backoff (1 s doubling to 8 s).

Import-graph rule (`test/import-graph.test.ts`): no file under `packages/paseo-plugin/src/` or
either entry may import `argos-core/durable`, `argos-core/git`, `argos-core/paseo`,
`argos-core/engine`, `argos-core/playbook`, `argos-core/rpc/server`, the `argos-core` root,
`@earendil-works/*`, `node:sqlite`, `node:fs`, or `node:child_process`. The only `argos-core`
subpath is `argos-core/rpc`; other imports are limited to `@getpaseo/*`, `react`, and `zod`.
`react`/`@types/react` are exact dev dependencies for the `.tsx` typecheck. Typecheck is split
(`tsconfig.json`, `tsconfig.test.json`, `tsconfig.entry.json`, `tsconfig.client.json`) so JSX never
leaks into the server graph.

## Tests

```sh
npm test                                        # all workspaces, excludes e2e
npm run typecheck
npm run test:e2e                                # build + real SIGKILL/restart
npx vitest run --project core packages/core/test/durable
npx vitest run --project core packages/core/test/paseo
npx vitest run --project core packages/core/test/rpc
npx vitest run --project cli
npx vitest run --project paseo-plugin
```

Fixtures: `test/fakes/clock.ts` (fake `now()`/timers), `test/fakes/executor.ts` (agents keyed by
`requestId`, scripted completion, captured prompts/feedback), `test/fakes/paseo.ts` (a labelled
daemon fake with quota, handover, and `blockCreate`), `test/support/git.ts` (temp repo + local bare
origin), `test/fixtures/{compat,aliases,invalid,subplaybook,precedence,when,discovery,scripts}`.
The durable suite covers home/db modes and pid single-writer, mirror-vs-checkpoint equality,
checkpoint byte identity, diamond/reopen with one agent per step, crash inside `launch` adoption,
timeout + retry, gate open/sleeping, one-writer decisions, pending gate survival, loop-limit
approve/reject, gate feedback, after-tasks, scripts (exit 75, timeout, kill, env, resolution),
worktrees, and `readonly_violation`. The Paseo suite covers create arguments, adoption with zero
extra creates, `launch_uncertain`, handover, quota fallback/exhaustion, `invalid_output`, fenced
JSON fallback, and `model_unavailable`. The RPC suite covers auth, idempotency, SSE, retry, gates,
and response projection. The plugin suite covers manifest, hook/teardown, decide-once/SSE
reconnect, tool names/errors, reload survival, and the import graph. The CLI suite covers validate
exit codes, golden JSON shapes, the no-storage import graph, and a real-serve sentinel.

**E2E (`packages/core/test/e2e/kill-restart.test.ts`, `npm run test:e2e`).** Spawns the built CLI
with a temp `ARGOS_HOME` and `ARGOS_FAKE_PASEO=1`:

1. *Kill mid-step*: 3-step playbook; the fake holds step 2 `running`; poll `argos status --json`
   and the fake ledger until step 2's agent exists; `SIGKILL`; create the release file; restart;
   wait for `completed`. Asserts one creation per step across both lifetimes (ledger length 3,
   distinct request/agent ids, step 3 created by the second pid), the same run id, and one attempt
   per step.
2. *Gate restart*: wait for `argos gates --json` to show a pending gate; `SIGKILL`; restart; the
   same gate id is still pending; `argos decide <runId> <gateId> approve --comment …`; assert the
   run completes and the decision/comment survive; a later decide is `run_terminal`.

Both scenarios clean up every child (`SIGTERM` then `SIGKILL`) and temp directory in `afterEach`;
timeouts are 120 s per scenario, 60 s per wait.

## Pinned dependency versions

Exact versions only — no `^` or `~`. Upgrades are an explicit PR that must keep the durability
suite green.

| Package | Version | Where | Why |
|---|---|---|---|
| `@earendil-works/pi-durable` | `1.5.2` | core | durable task host |
| `@earendil-works/chord` | `1.5.2` | core | pinned alongside pi-durable |
| `@earendil-works/pi-ai` | `1.5.2` | core | exact version pi-durable depends on |
| `@getpaseo/client` | `0.15.4` | core, plugin | Paseo adapter / RPC client |
| `@getpaseo/plugin` | `0.15.4` | plugin | plugin runtime + panel |
| `typescript` | `7.0.2` | root dev | compiler |
| `vitest` | `5.1.0` | root dev | test runner |
| `@types/node` | `26.6.6` | root dev | Node types |
| `yaml` | `2.9.1` | core | playbook parser |
| `zod` | `4.6.7` | core, plugin | schema, RPC contract, tool inputs |
| `react` | `19.3.0` | plugin dev | `.tsx` client entry |
| `@types/react` | `19.3.0` | plugin dev | JSX types |

## Known limitations and deviations

- **No exactly-once across the daemon boundary.** At-most-once launch *attempt* + label
  reconciliation; a daemon that cannot filter labels yields `launch_uncertain` rather than a
  duplicate. A launch-time `paseo_unreachable` fails the step; only poll-time unreachability parks
  and retries until the deadline.
- **Gate role deciders are metadata only.** `decider: {by: role}` is parsed/validated/preserved,
  but v1 gates always wait for an external decision (CLI/plugin/HTTP). Human gates and loop-limit
  gates are fully implemented.
- **Manual after-tasks have no RPC route.** `ArgosHost.startAfterTask` exists and is tested, but
  the v1 HTTP surface does not expose it; `auto` after-tasks run normally.
- **`concurrency_limit` and `loop_limit` are reserved codes.** Over-cap ready steps are parked as
  `ready` (no error), and `max_loops` opens a gate rather than throwing `loop_limit`.
- **Local retries are not separate run-record attempts.** The run record shows one dispatch per
  child task; the step checkpoint/history shows each local attempt.
- **Read-only detects, it does not prevent** (created-and-deleted files, same-entry untracked
  directories, ignored paths; see `docs/compat.md`). A script can delete untracked files later
  steps needed; the engine does not sandbox scripts.
- **Worktrees are never cleaned up automatically**; a failed/violating step leaves its worktree
  for inspection (`removeRunWorktree` is manual).
- **No migration** from spec 02, paseo-playbooks run state, or pre-Phase-8 run indexes
  (pre-release; no migration path).
- **Paseo SDK limitation.** `waitForFinish()` exposes text but no structured JSON value, so the
  production port relies on the fenced-JSON fallback when a provider ignores `outputSchema`.
- **The plugin reads `ARGOS_HOME`/`ARGOS_PORT` once per client** and has no settings screen; the
  server must be started with matching values.
