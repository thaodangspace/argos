# AGENTS.md

Argos is a durable YAML playbook engine for Paseo agents. A repository declares its workflow in
`.argos/playbooks/*.yaml`; a deterministic engine executes it, launching Paseo agents for the work
inside each step, with parallel steps, human gates, loops, script steps, worktree isolation,
crash-safe resumption, and cron schedules that fire playbooks unattended. v1 (Phases 1–10) is
complete; `npm test`, `npm run typecheck`, and `npm run test:e2e` are green.

Approved spec and plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_spec_argos_yaml_playbook_engine.md` and
`03_impl_argos_yaml_playbook_engine.md`. The earlier 02 spec is superseded (no LLM in the control
path; YAML playbooks/DAG/gates/loops replace the orchestrator loop).

## Layout

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `@thaodangspace/argos-core` | loader, engine, durable host, git helpers, RPC server, Paseo adapter |
| `packages/cli` | `@thaodangspace/argos` | `argos` CLI; HTTP client of `argos serve`, never opens SQLite |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel + chat tools; HTTP client, never opens SQLite |

No source files live outside `packages/*`. TypeScript ESM, `module`/`moduleResolution`
`NodeNext` (relative imports need `.js` extensions), Node `>=22.13` (`node:sqlite` is unflagged
from 22.13).
`packages/core/src/git/` is the only directory (with `durable/tasks/script.ts`) allowed to import
`node:child_process`, and it is exported on the `@thaodangspace/argos-core/git` subpath, never the root.
`packages/core/src/schedule/` holds the two scheduler primitives: `next.ts` is the **only**
`croner` user (built paused, with no callback, so it is a calculator and never arms a timer) and
`model.ts` is the zod-only schedule model (ids, bounds, fire entries, `catchUp`/`keep`
normalization) that `rpc/contracts.ts` imports, so the CLI and the plugin bundle neither `croner`
nor a timer.

## Invariants

- **No LLM in control flow.** Readiness, transitions, loop limits, gates, retries, and timeouts are
  decided by the pure engine. A model only does the work inside a step.
- **One writer.** Only `argos serve` opens `$ARGOS_HOME/argos.sqlite`. The CLI and plugin talk
  HTTP; a second live owner is refused with `storage_locked` naming `serve.pid`.
- **Loopback + token.** The server binds `127.0.0.1` and requires
  `Authorization: Bearer <token>`; tokens and secrets never reach the database or logs.
- **Stable codes.** Callers match on `ArgosError.code`, never on message text.
- **Same-commit mirrors.** Run/history documents are committed with the task checkpoint.
- **Definition freeze.** A run stores the fully resolved IR + hash and never reloads it. An edited
  definition continues through `argos fork`, which starts a **new** run carrying `forkedFrom`
  provenance and the parent's settled prefix; one run document always contains exactly the IR it
  ran, so a resume can never execute a definition the record does not hold.
- **Durable schedules.** A schedule is a document, not a task: one in-process timer only wakes a
  tick, and the fire's single commit (guards + deterministic run id) is what makes a fire happen
  exactly once.

## Commands (run from the repo root)

```sh
npm ci            # reproducible install from package-lock.json
npm test          # builds workspaces (tsc -b) then vitest over all projects; excludes e2e
npm run typecheck # tsc -b for src, then tsc --noEmit for every test/entry graph
npm run test:e2e  # builds, then the real-process SIGKILL/restart suite
npm run build     # tsc -b (emits dist/ for every workspace)
node -e "import('@thaodangspace/argos-core')"   # workspace-link check; requires a build first
npm run version:check -- v0.1.0                 # release guard: tag must match every manifest
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

## Publishing (npm)

Two workspaces are public on npm and one is not:

| Package | npm | Notes |
|---|---|---|
| `@thaodangspace/argos-core` | yes | the library; published first |
| `@thaodangspace/argos` | yes | the CLI, `bin: {"argos": "dist/index.js"}` |
| `argos-paseo-plugin` | no (`private`) | Paseo bundles its TypeScript source; installed with `paseo plugin install <path>` |

The bare names `argos` and `argos-cli` are taken on npm by unrelated projects, which is why both
packages live under the `@thaodangspace` scope. `argos` remains the command name.

- **Lockstep versions.** The root (private), the two published packages, and the plugin share one
  version; the CLI pins `@thaodangspace/argos-core` to exactly that version and the plugin pins it
  too, because npm resolves a workspace by specifier + version.
- **Release guard.** `scripts/check-version.mjs` (`npm run version:check [-- vX.Y.Z]`) fails when a
  workspace drifts, when a published package is still `private` or `0.0.0`, when
  `publishConfig.access`/`engines.node`/`files`/`repository` is missing, or when the tag does not
  match. CI runs it on every push; the release workflow runs it again with the tag. The
  `GITHUB_REF_NAME` fallback applies only to a `refs/tags/` ref: a branch push (`main`) and a
  `pull_request` merge ref (`2/merge`) both set it too, and reading those as tags failed every run.
- **Release workflow.** Pushing a `v*` tag runs `.github/workflows/release.yml`: install, version
  guard, `npm test`, `npm run typecheck`, then `npm publish -w @thaodangspace/argos-core` and
  `npm publish -w @thaodangspace/argos` (in that order, `--provenance`, `NODE_AUTH_TOKEN` from the
  `NPM_TOKEN` secret). `npm run release:publish` is the same two publishes by hand.
- **What a tarball contains.** `files: ["dist", "!dist/.tsbuildinfo"]` plus `package.json`, the
  package's own `README.md`, and its own `LICENSE` (a copy of the repository licence — npm only
  packs what is inside the package directory; `packages/cli/test/publish.test.ts` keeps the copies
  byte-identical and the manifests publishable). `prepublishOnly: npm run build` builds that
  workspace, and `postbuild` chmods the bin entry from the script's own location, so it behaves the
  same from the root or from the workspace.
- **Node floor.** `engines.node` is `>=22.13`: `node:sqlite` exists from 22.5 but is only unflagged
  from 22.13, and `argos serve` is the one process that opens SQLite. The doctor check reports the
  same string.

## Storage layout and permissions

| Path | Mode | Purpose |
|---|---|---|
| `$ARGOS_HOME` | `0700` | default `~/.argos`; created/repaired on open and on serve |
| `$ARGOS_HOME/argos.sqlite` | `0600` | pi-durable SQLite; the single source of truth |
| `$ARGOS_HOME/token` | `0600` | 32 random bytes hex; created on first serve |
| `$ARGOS_HOME/serve.pid` | `0600` | single-writer pid file; dead pids are stale and replaced |
| `$ARGOS_HOME/worktrees/<runId>/` | — | isolated run checkouts; removed only by `argos worktree rm` / `argos worktree gc` (FR4) |
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
| `argos.delay` | 1 | `arm → wait` |
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
| `argos.schedule` | `<id>` | one schedule: playbook + `cwd` + `cron`/`tz`, `overlap`/`catchUp`/`keep`, `enabled`/`generation`, `nextFireAt`, `lastFire`, `liveRunId`, `runIds`, bounded `fires` |
| `argos.schedules` | singleton | schedule-id index — the roster every read and every fire commit consults |

Run and history are written in the same `runtime.commit()` as the task checkpoint. A commit that
only advances a phase may write an identical document (Chord stores no new revision); that is
expected. Gate ids are `<stepId>:<n>`, so `${runId}.${gateId}` cannot collide.

A schedule document is a complete value (`checkpointWhen: () => true`, like `argos.run`), read
through `hydrateScheduleDoc` so a hand-edited row is refused instead of fired. `argos.schedules`
is consulted **before** any schedule read: a document is only ever seeded for an id the index
lists, so a deleted schedule cannot be resurrected by a stale read. A fire's run task, mirror,
history, run-index entry **and** the schedule document (`lastFire`, `nextFireAt`, `liveRunId`,
`runIds`, `fires`) land in one commit.

The history event vocabulary lives in `src/history.ts` (`HISTORY_EVENT_TYPES`, shared with the
read model's schema): `run_started`, `select`, `dispatch`, `settle`, `gate`, `gate_decided`,
`finish`, `effect_skipped`, `task_error`, `after_queued`, `after_start`, `retry`, and
`script_repinned` (FR3.4 — one line per re-pinned script, `detail` = `<name>: <from> -> <to>`), and
`forked_from` (the first event after `run_started` on a forked run; `stepId` is the fork point and
`detail` = `<parentRunId>@<stepId>`; the hashes live in `RunRecord.forkedFrom`). Adding an event is
two edits, not one: the list in `src/history.ts` and the plugin's exhaustive `historyText`/
`historyTone` switches in `shared/panel.ts` (the compiler requires the second).

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
| `script_changed` | a pinned script was edited, moved, or deleted after the run started; no automatic retry | 409 |
| `concurrency_limit` | reserved for callers that enforce a playbook-level concurrency refusal; the engine parks extra steps as `ready` instead | 409 |
| `unauthorized` | missing/bad bearer token | 401 |
| `run_terminal` | write attempted on a finished run (e.g. deciding a gate afterwards) | 409 |
| `run_active` | a worktree operation named a run that has not finished (`worktree rm`/`gc`) | 409 |
| `invalid_request` | malformed/strict-body request, bad input coercion, body > 1 MiB, or a `cwd` that is not an absolute existing directory | 400 |
| `run_unknown` | `GET /runs/:id` for an unknown run | 404 |
| `step_unknown` | `POST /runs/:id/retry` for an unknown step | 404 |
| `schedule_unknown` | unknown schedule id (index read, show/edit/pause/resume/run/rm) | 404 |
| `schedule_exists` | `POST /schedules` / `argos schedule add` for an id already in the index | 409 |
| `definition_conflict` | a fork's reloaded definition differs outside the set the fork re-runs, or changes `inputs`/`isolation`/`after`/the step set; `issues` names the surfaces and step ids | 409 |

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
`hash.ts` (canonical JSON + sha256), `diff.ts` (the pure IR diff a fork's applicability guard uses),
`ir.ts` (the frozen JSON IR the rest of Argos consumes).

- Discovery: `.argos/playbooks/*.yaml` then `.paseo/plugins/playbooks/*.yaml` (same fallback for
  `roles/`, `defaults/main.yaml`, `scripts/`); playbook id = filename. An optional `home`
  (`loadPlaybook(repoDir, id, { home })`, and the same last argument on `discoverPlaybooks`,
  `discoverRoles`, `discoverScripts`, `defaultsFile`) also searches `<home>/playbooks`,
  `<home>/roles`, `<home>/defaults/main.yaml`, and `<home>/scripts`. Playbooks, defaults, and
  scripts stay repository-first: the repo copy wins an id collision and the first existing defaults
  file wins whole-file (no per-field merge). **Roles are root-local (FR8)**: a home playbook
  resolves `<home>/roles` then the repository roots, a repository playbook the reverse, and every
  sub-playbook uses the family of its own file; one IR that resolves a role id to different
  content fails `playbook_invalid` naming both role files (identical copies merge silently).
  Omitting `home` keeps discovery repo-only. `POST /runs` passes the host home and
  `argos validate` passes `--home` (else `ARGOS_HOME`, else `~/.argos`); a script step carries it as
  `ScriptTaskInput.scriptHome` and still executes in the run cwd/worktree, never in the home.
  `loadPlaybook(repoDir, id)` returns a deep-frozen `PlaybookIR` with `hash`; it never writes.
- Aliases normalized: `poll_ms` | `pollMs` | `poll` → `pollMs` (D3 defaults 3000/2000/5000);
  `mode` | `mode_id` → `modeId`; `playbook: {name}` | `playbook: <id>` | `use: <id>` → sub-playbook;
  flat `gate`/`choices`/`script` and paseo block forms both load; `goto` accepts a bare id with
  sibling `max_loops` or `{target, max_loops}`.
- Strict keys (FR1): the playbook, a step, and an input/output definition are `z.strictObject`, so
  a typo is `playbook_invalid` naming the step (also under `after[n].steps[m]`), with every issue
  (up to 20) in `ArgosError.issues`. Upstream-only keys stay declared as `z.unknown().optional()`
  (step `handoff`, `queue`, `settle`, `silence`, `archive_agents`; playbook `hidden`, `manager`,
  `workspace`, `next`, `singleton`) and never reach the IR. The origin of a file decides the
  unknown-key rule: `argos` and `home` fail, and a `.paseo/plugins/playbooks/` file whose **only**
  issues are unknown keys loads with one `unknown_key` warning per key (any other issue fails).
- Warnings sink (FR7): `loadPlaybook(repoDir, id, { warnings })` appends `LoadWarning`
  `{file, stepId, code, message}`; `ResolveContext` carries `origin` and `warn`. Warnings never
  change the IR or `hash`, and messages never contain YAML values — only keys, ids, and paths.
  `role_shadowed` (a resolved role id exists in both families with different content) and
  `playbook_shadowed` (a repository playbook hides a home playbook with the same id) are emitted
  only when the sink is present; identical role copies are silent. `argos validate` prints them
  after the errors and exits 0 when there are only warnings.
- Errors are `ArgosError` with the plan's stable code; loader/validator failures are
  `playbook_invalid`, `playbook_cycle`, or `playbook_missing` and always name file + step
  (`details.issues` carries the per-issue `{path, stepId?, message}` list).
- Golden compat fixtures live in `packages/core/test/fixtures/compat/` (copied from
  `lerenn/paseo-playbooks`, MIT; see `test/fixtures/ATTRIBUTION.md`). Alias, invalid, sub-playbook,
  precedence, `when`/`branch`, and discovery fixtures sit next to them. `docs/compat.md` lists
  every divergence with its fixture/test.

## Pure engine

`packages/core/src/engine/` is the pure decision layer: no I/O, no timers, no durable or Paseo
imports. `purity.test.ts` enforces the import graph. Consumers use the barrel
(`import { next, createRunRecord, hydrateRunRecord } from "@thaodangspace/argos-core/engine"`).

```ts
next(record: RunRecord, event: EngineEvent): { record: RunRecord; effects: readonly Effect[] }
```

- `RunRecord` is the whole checkpoint: frozen IR + inputs + step/gate/loop state, plus the optional
  additive `scripts` map (`Record<name, { path, sha256 }>`, FR3 pinning; absent when the playbook
  has no script step and on a record written before pinning — hydration of old JSON is unchanged),
  the optional additive `trigger` (`{kind: "schedule", scheduleId, fireAt, reason}`, FR8.1;
  absent on a manual run, so old records and JSON stay byte-identical), and the optional additive
  `forkedFrom` (`{runId, stepId, fromHash, toHash}`; only `forkRun` sets it, so a normally started
  run omits the key).
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
- The calendar lives outside the engine: `schedule/next.ts` (`parseScheduleSpec`, `nextFireAfter`,
  `dueFireTimes`) needs `Date`, which `purity.test.ts` bans. It is otherwise pure — no timer, no
  clock read — and its fixed-epoch tests (DST included) are the whole contract.

## Durable host

`packages/core/src/durable/` is the only importer of `@earendil-works/*` (and `src/git/`). The
public surface is the `@thaodangspace/argos-core/durable` subpath; it is deliberately **not** re-exported from
the package root so the CLI and plugin cannot open SQLite by accident.

`ArgosHost` (`host.ts`) owns one SQLite file. `startRun({ ir, inputs, cwd, worktree?, deadline?,
id? })` returns `{ runId, taskId }`, and `forkRun(runId, stepId, { home?, id? })` returns the same
shape for a **new** run that re-loads the definition and inherits the parent's settled prefix
(`definition_conflict` when the edit escapes `downstreamClosure(parentIr, [stepId])`). `startRun` is
the public front of two halves: `#prepareRun` (the
model check, the idempotency fast path, the run id, script pins, the worktree, the record — it
never writes) and `#commitRun` (task + mirror + history + run index + idempotency receipt, inside
the caller's commit). `runId` is a dependency-free ULID, unless a caller supplies one — a schedule
fire does (its deterministic id); `taskId` is pi-durable's numeric task id stringified at the
boundary. The half pair is exposed to the scheduler only, as `RunStartPort`
(`prepare`/`commitInTx`/`dryCheck`/`resume`/`root`), so a fire can write the run **and** its
schedule marker in one commit. `checkRunStart` is the `dryCheck` front used by
`argos schedule add|edit`: every prepare step (model check, script pins, worktree dirtiness, the
record shape) and no task, index entry, worktree, or run. The run task is conversation-owned by
the root conversation (D5) and the initial mirror is written in the same commit.
`resume()`/`close()`/`getRun`/`getHistory`/`getTaskRecord`/`inspect` are the read/lifecycle
surface; `open` and `startRun` both resume so scheduling never depends on the caller. `open` also
registers an optional `onScheduleFire` listener **before** the first scheduler tick (so a catch-up
fire during startup is still announced), loads the schedule cache, queues tick one, arms the one
timer, and `close()` disarms it and waits for an in-flight fire.

`models` (D6) is a Proxy stub: `Harness.open` reads `getAuth` once, so the property returns a
function that throws when **called**; `has` reports `false`. The engine never asks for a model,
and no `pi.generation` task may ever appear in `inspect()`.

The modules follow the responsibilities: `host.ts` (run lifecycle and the schedule methods),
`host-models.ts` (the D6 stub), `pid.ts` (single-writer pid file and database modes),
`host-types.ts` (public option/result types, `RunStartPort`, `ScheduleRunPort`, the fire-event
shape), `run-request.ts` (`resolveRunRequest` — the shared `cwd` validate → `loadPlaybook` →
`prepareInputs` front half of `POST /runs` and every fire), `schedule-docs.ts` (both document
families, hydration, `scheduleRunId`, the bounded `fires`/`runIds` pushes), and `schedules.ts`
(`ScheduleRunner`: registry CRUD, the one timer, tick/fire/run-now, retention). The `argos.run`
task keeps its definition in `tasks/run.ts` and spreads the rest over
`run-checkpoint.ts` (checkpoint shape, schema, `hydrateRunCheckpoint`), `run-events.ts`
(child-outcome → engine events, history), `run-plan.ts` (effects → next state, child inputs), and
`run-recovery.ts` (`guarded`); `tasks/after.ts` also owns `plannedAfterTasks` and
`createAfterRunTask`.

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

argos.delay v1: "arm" | "wait"
  { phase, attempt } | { phase: "wait", attempt, armedAt, until }

argos.gate v1: "await" | "decided"
  { phase, gateId, runId, stepId, kind, edge?, question, choices, seenAt,
    decision?, comment?, decidedBy?, decidedVia?, decidedAt? }
```

`argos.script` input: `{ runId, stepId, attempt, requestId, cwd, scriptRoot, scriptHome?,
script, pin?, env, pollMs, timeoutMs, outputs, outcomes, readonly? }`. `pin` is the
`{ path, sha256 }` pair from `RunRecord.scripts`; it is absent only on a record written before
pinning existed (FR3.6), and then `prepare` resolves the file as before.

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

### Schedules

`ScheduleRunner` (`durable/schedules.ts`) is the registry and the one timer. A schedule is a
document (never a task), so editing, pausing, and running it now are ordinary commits rather than
abort/re-create of a sleeping task; `croner` only answers "when is the next fire time"
(`schedule/next.ts`), and `model.ts` holds the zod-only values (`catchUp` `"all"`/ms/`<n><unit>`,
`keep` 1..1,000/"all", the 50-entry fire log, 100 schedules).

- `add` settles the id (default: the playbook id, which must match
  `^[a-z0-9][a-z0-9-]{0,63}$`; a 101st schedule is `invalid_request`, a duplicate id
  `schedule_exists`), validates `cron` (five fields or `@hourly|@daily|@weekly|@monthly|@yearly`;
  `@reboot` and a seconds field are `invalid_request`) and `tz` (whatever `Intl` accepts; default
  the server zone), computes the first `nextFireAt`, runs the same dry check as a start, and writes
  the document plus the index entry in one commit. `edit` merges the given fields, validates again,
  bumps `generation`, and recomputes `nextFireAt` from `now`; `pause` sets `enabled: false` /
  `nextFireAt: null`; `resume` computes `nextFireAt` from `now` (a pause is never caught up);
  `remove` retires the document and drops the id in one commit while live runs continue with their
  `trigger`.
- **One timer.** `#arm()` waits `min(earliest enabled nextFireAt, now + 60 s)` — never longer than
  a minute, so a laptop that slept notices a missed fire; no enabled schedule means no timer. Ticks,
  timer fires, and run-now all run on one serialized promise chain, so two fires never overlap and
  `close()` can await the fire already inside `prepare`.
- **A tick** reads only its in-memory `{enabled, nextFireAt}` cache and writes nothing when nothing
  is due. For a due schedule it takes the **latest** due fire time, counts the earlier ones
  (`dueFireTimes`, capped at `"10000+"`), and fires with reason `cron` when it is at most 120 s
  late, else `catch_up`. `catchUp: "all"` (default) always fires that latest time; `<ms>` fires it
  only inside the window; `0` only inside the 120 s tolerance. Skipped earlier times become one
  `missed` fire-log entry (`count`, `from`, `to`) and never start a run.
- **One fire commit.** The runner loads the playbook at fire time (`resolveRunRequest`), prepares
  outside any commit (model check, script pins, worktree), then in a single commit re-reads the
  document and re-checks the index, `uid`, `generation`, `enabled`, `lastFire.fireAt < fireAt`, the
  run index and the overlap rule; it then creates the run task, writes the run mirror/history/index
  entry (`run_started` detail `<playbookId> (schedule <id>)`) and the new schedule state
  (`lastFire`, `nextFireAt`, `liveRunId`, `runIds`, `fires`, `consecutiveFailures = 0`). The run id
  is deterministic — `scheduleRunId(uid, fireAt)` is a ULID whose time part is the fire time and
  whose random part is `sha256(uid:fireAt)` — so a crash before the commit re-fires the same instant
  with the same id (and reuses `<home>/worktrees/<runId>`), and a commit that already landed is
  adopted as this fire's outcome instead of starting a second run. Only after the commit does the
  host `resume()`.
- **A refusal** (the playbook load, input coercion, a script pin, the worktree, the model check) is
  a document-only commit: `lastFire`/fire-log `status: "refused"`, the `ArgosError.code`, its
  message cut to 500 characters (a non-`ArgosError` contributes only `error.name`),
  `consecutiveFailures + 1`, and the next `nextFireAt`. Nothing is retried before the next fire
  time and a schedule is never paused or deleted by itself. A failure *after* the run exists is a
  run failure, visible through `liveRunId`/the run status.
- **Overlap.** `skip` (default) checks `liveRunId` against one run document: a removed run, a
  terminal run, and a terminal parent with a running after-task are all "not live". A skipped fire
  writes `skipped_overlap` and advances `nextFireAt`; `allow` starts anyway and `liveRunId` names
  the newest run. Run now (`runSchedule`) uses a fresh ULID, `fireAt = now`, reason `run_now`,
  works on a paused schedule, never touches `nextFireAt`, waits behind an active fire, and refuses
  with `run_active` (naming the live run) when `skip` holds a live run and the request is refused
  before any write.
- **Retention.** After a fire that started a run, outside the fire's commit and unable to fail it,
  `#prune` removes runs beyond the newest `keep` through `ArgosHost.removeRun`. A run that is still
  live (or has a running after-task) and a run whose worktree directory still exists are skipped and
  retried after the next fire; retention never removes a worktree or a branch.

**Run provenance (FR8.3).** A scheduled run's record (and `RunSummary`) carries
`trigger: { kind: "schedule", scheduleId, fireAt, reason: "cron"|"catch_up"|"run_now" }`; a manual
run omits the key entirely, so old records and goldens are unchanged. An after-task child does
**not** copy its parent's `trigger`; a retry clone keeps it (same `runId`). `argos ls --schedule
<id>` filters on `trigger.scheduleId`, and the human `argos ls` line appends `[schedule <id>]`.

## Paseo adapter

`packages/core/src/paseo/` is exposed on `@thaodangspace/argos-core/paseo`, never from the package root.
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

A quota hit can also arrive **after** launch: an error status/refresh failure, or a turn that ends
on a bare usage-limit notice ("You've hit your 5-hour limit · resets …") instead of the schema
result. `isQuotaNotice` (short text, only checked once the result failed the schema) classifies
it; `status()` archives the agent, records the target, and relaunches the same attempt on the
next available target (`argos/handover=1` label + handover note). Nothing left →
`provider_exhausted` with the ledger.

**Quota policy.** `providers` (playbook `defaults.providers`, else `defaults/main.yaml`
`providers`, whole object) resolves to `PlaybookIR.providers` = `{ onExhausted, exhaustedForMs?,
maxWaitMs? }`; absent keeps the IR (and hash) unchanged. `exhausted_for` overrides the executor's
15 min window per step (`StepAgentContext.quotaWindowMs`). With `on_exhausted: wait`,
`argos.step` turns `provider_exhausted` into a sleep until the first candidate leaves its window
(min 30 s), then a fresh local attempt (new request id; the archived quota agent is never
adopted; preferred target first). These relaunches are counted in `quotaRelaunches` and do not
consume `retries`; `max_wait` bounds the total wait from the first exhaustion
(`quotaWaitSince`), after which the step fails `provider_exhausted`. Default `fail`. The upstream
`providers.fallback` key is parsed and ignored.

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

- Resolution and pinning (FR3): `<script>` must be a bare file name (no `/`, no `..`, not absolute),
  looked up in `.argos/scripts/` then `.paseo/plugins/playbooks/scripts/` of the **run cwd**, then
  `<home>/scripts` when the host has a home, and must be an executable regular file.
  `ArgosHost.startRun` resolves and hashes every main-step and after-step script **before the
  worktree exists** (`src/durable/tasks/script-pin.ts`) and stores `RunRecord.scripts:
  Record<name, { path, sha256 }>`; a missing or non-executable script is `playbook_invalid` naming
  the step with no task and no worktree. Resolution uses the repo root (so local helpers work);
  execution uses `cwd = worktree.path` when isolation is on, otherwise the run cwd. A script that
  an earlier step would create is therefore refused at start (documented compat divergence).
- `run` re-hashes the pinned file **before every spawn** (first run, an exit-75 re-run, a resume, a
  local retry). A changed, moved, or deleted file settles the step as `script_changed` (the detail
  says "missing" for a deleted file) and the engine never retries it; `argos retry` re-pins. A
  record without `scripts` (written before pinning) keeps resolve-at-prepare (FR3.6).
- `run` spawns with `shell: false`, the filtered env, and bounded (8 KiB) stdout/stderr **tails**.
  Exit `75` (`SCRIPT_NOT_YET`) commits `sleeping { until: now + pollMs }` and re-runs with
  `runs + 1`; any other non-zero exit is terminal. A script still alive at the deadline is killed
  and fails `script_timeout`. The child is killed on `runtime.signal` abort and on deadline; on
  POSIX it is `detached` and killed by process group.
- `collect` commits a terminal completed task whose result is a `StepTaskResult`; success reports
  outcome `success` (or the first declared outcome) and exposes `stdout`, `stderr`,
  `exitCode`/`exit_code`, `runs`. Declared output names are never parsed as JSON. The receipt also
  carries `exitCode`, `runs`, `signal`, and a bounded `detail`.
- Env filter (FR2, `src/engine/env.ts`): a script is deny-by-default. It inherits only the
  baseline — `PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`,
  `TMP`, `TEMP`, `SystemRoot`, `PATHEXT`, `COMSPEC` (matched case-insensitively) — plus the step's
  `env:` grants: an exact name (grants it even when it looks like a credential), `PREFIX_*` (a
  literal prefix ending in `_`; never a name matching
  `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i`), or `"*"` (every non-secret name — the old behavior;
  `argos validate` warns `env_inherit_all`). Anything else is `playbook_invalid` naming the step.
  `SCRIPT_ENV_DENY` — `ARGOS_PASEO_PASSWORD`, `ARGOS_HOME`, `ARGOS_PORT`, `ARGOS_PASEO_URL`, and
  the four `ARGOS_FAKE_PASEO*` knobs — is never passed, even when granted exactly; the loader
  warns `env_denied` and the IR keeps the entry verbatim. A spawned child therefore sees no name
  the playbook did not grant. Output keys are sorted for byte-stable checkpoints/logs. The same
  pattern redacts secrets from git error messages (FR2.6).

A delay step (`delay: 30m`, kind inferred, or `kind: delay`) gets an `argos.delay` child through
the same `dispatchStep`/`stepSettled` path. `run-plan.ts` resolves the duration against the run
inputs at dispatch (`resolveTimeoutValue`: ms, `"30m"`, or a whole-value `{{ inputs.x }}`); `arm`
commits the absolute `until`, and `wait` settles the outcome (`success`, or the first declared
one) once `now >= until`. Each park is `sleeping` for at most `DELAY_SLICE_MS` (60 s) because a
Node timer does not advance while macOS sleeps; every wake re-reads the wall clock. Nothing
recomputes `until`, so a host restart resumes the same instant, and a host that comes back late
settles on its first turn. `timedOutAttempts` skips delay steps (no step timeout); the loader refuses `timeout`,
`retries`, `prompt`, `role`, `agent`, `script`, `gate`, `choices`, `env`, `inputs`, `outputs`,
`poll*`, and `use` on them, a non-positive literal, and a template naming an undeclared input. An
unresolvable template at dispatch settles `step_failed`. A step without `delay` adds no IR key,
so existing playbook hashes are unchanged.

`retryStep` re-pins (FR3.4): when the record has `scripts`, every script step in the reset
`downstreamClosure` is resolved and hashed again — a missing one refuses the retry
(`playbook_invalid`) before any task exists — and each changed digest appends a `script_repinned`
history event whose `detail` is `<name>: <old sha256> -> <new sha256>`. An after-task child copies
the parent's pins (`planAfterRun`), and a record written before pinning (no `scripts`) keeps the
resolve-at-prepare path (FR3.6).

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
Worktrees are never removed automatically: `argos worktree rm` and `argos worktree gc` (FR4,
`durable/worktrees.ts`) are the only paths, they take the path and branch from the record only
(guarded against `runWorktreePath`/`runWorktreeBranch`), refuse a live run with `run_active`, and
keep `argos/<runId>` unless `--delete-branch` is passed. `reattachRunWorktree` puts the branch back,
so `argos retry` works after a removal (a deleted branch refuses the retry with `worktree_failed`).
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

`packages/core/src/rpc/` has two subpaths: `@thaodangspace/argos-core/rpc` (`contracts.ts` + `client.ts`; no
durable imports, safe for CLI/plugin) and `@thaodangspace/argos-core/rpc/server` (`server.ts`; imports the
durable host and is imported only by `argos serve`). `rpc/summary.ts` projects mirrored documents
to the public read model. The CLI source never imports `@thaodangspace/argos-core/durable`, `@thaodangspace/argos-core/git`,
`node:sqlite`, or `@earendil-works/*`; only `commands/serve.ts` may import
`@thaodangspace/argos-core/rpc/server` (`packages/cli/test/import-graph.test.ts`).

Contract highlights: `StartRunRequest`, `DecideGateRequest`, `RunSummary`, `RunDetail`,
`ServerInfo`, `DoctorReport`, and the schedule shapes (`ScheduleCreateRequest`,
`ScheduleEditRequest`, `ScheduleSummary`, `ScheduleDetail`, `ScheduleFire`). `RunSummary`/
`RunDetail` never contain `ir`, prompts, agent messages, transcripts, or credential-like inputs;
`RunDetail.gates` comes from the gate documents (fresher than the mirror after a decision). The
list projection stays lean; `RunDetail.steps` use `StepDetailSummary` instead of `StepSummary` and
add each step's `attempts` (`n`, timing, `target`, `usage`, `outcome`, `errorCode`), its `outcome`,
and its declared `outputs` (credential-shaped names dropped, values cut at
`STEP_OUTPUT_VALUE_LIMIT` = 4,000) — that is what the panel renders as a step log. All
bodies are strict zod schemas; `RPC_ERROR_STATUS` is the single code → HTTP map; bodies are capped
at 1 MiB. `ScheduleSummary` is the document without `uid`, `runIds`, and `fires` (inputs filtered
by `publicInputs`); `ScheduleDetail` adds `fires` and the 10 newest `recentRunIds`.

| Route | Behavior |
|---|---|
| `POST /runs` | validate `cwd` (absolute, NUL-free, existing directory — a git repo is not required; `invalid_request` before any task), then load + validate from `cwd`, then `host.startRun`; `playbook_invalid` before any task |
| `GET /runs` | `{ runs }` newest first, from the `argos.runs` index |
| `GET /runs/:id` | `RunDetail` = summary + bounded history + gate documents |
| `DELETE /runs/:id` | `host.removeRun`: one commit retires the run, history, gate, and idempotency documents and drops the id from `argos.runs`; refuses a live run or a running after-task (`run_terminal`); task records and the worktree are kept |
| `POST /runs/:id/worktree/remove` | `host.removeWorktree` (`argos worktree rm`): path and branch come from the record only (`runWorktreePath`/`runWorktreeBranch`, else `worktree_failed`); a dirty checkout without `force` is `worktree_failed` naming `--force`; `run_active` for a live run; `removed: false` when the run never had a worktree; `deleteBranch` runs `git branch -d` (`-D` with `force`) |
| `POST /worktrees/gc` | `host.gcWorktrees` (`argos worktree gc`): terminal runs whose `updatedAt < now - olderThan` (`<n>(s\|m\|h\|d)`), `dryRun`, per-run `skipped` reasons (`active`, `path_mismatch`, a stable code), and `orphans` under `<home>/worktrees` that no run claims (reported, never deleted) |
| `POST /runs/:id/cancel` | engine `cancel`; `run_terminal` if finished |
| `POST /runs/:id/retry` | clone a terminal run into a fresh task (same `runId`), reset the step + downstream; refuses non-terminal (`run_terminal`), unknown run/step |
| `POST /runs/:id/fork` | **new** run from one step with the definition reloaded from the run's `cwd`: inherits the settled prefix, records `forkedFrom`, drops gates/loops/trigger/deadline, re-pins the closure's scripts; `definition_conflict` when the edit escapes the reset closure |
| `POST /runs/:id/gates/:gateId` | first writer wins; `gate_unknown`/`gate_already_decided`/`run_terminal` |
| `GET /schedules` | `{schedules: ScheduleSummary[]}` sorted by id, from the `argos.schedules` index (never a run scan) |
| `POST /schedules` | 201 `ScheduleDetail`: `host.addSchedule` (id defaults to the playbook id, `tz` to the server's zone) runs the same dry start check as `POST /runs`; `schedule_exists`, `invalid_request` at 100 schedules |
| `GET /schedules/:id` | `ScheduleDetail` = summary + `fires` + the 10 newest `recentRunIds`; `schedule_unknown` |
| `POST /schedules/:id` | edit (`ScheduleDetail`): merge the given fields, revalidate, `generation + 1`, `nextFireAt` from now; an empty body is `invalid_request` |
| `POST /schedules/:id/pause`, `/resume` | `ScheduleSummary`; pause nulls `nextFireAt`, resume computes it from now (a pause is never caught up) |
| `POST /schedules/:id/run` | 201 `{runId, taskId}`: run now — fresh ULID, `reason: "run_now"`, serialized behind any fire, never changes `nextFireAt`, works on a paused schedule, `run_active` under `overlap: skip` while the live run is running |
| `DELETE /schedules/:id` | `{id, removed: true}`; the runs it started continue and keep their `trigger` |
| `GET /events` | SSE: one `snapshot` then `run` per changed mirror; `: ping` heartbeat; commit-driven |
| `GET /info`, `GET /health` | doctor data / liveness |

`POST /runs` and every schedule fire share `resolveRunRequest` (`durable/run-request.ts`): `cwd`
validation, then `loadPlaybook`, then input coercion/defaults. `POST /runs` defaults `cwd` to the
server's cwd; the CLI always sends the caller's cwd. Declared inputs are coerced
(`number`/`boolean`/`enum`), defaults fill missing values, a missing required input is
`invalid_request`. `validateRunCwd` runs before `loadPlaybook`: the effective `cwd` must be
absolute, NUL-free, exist, and be a directory (a git repository is not required); otherwise the
route answers 400 `invalid_request` and creates no run, task, or worktree. A fire validates the
stored `cwd` again, every time. `/schedules/...` is claimed by `handleSchedules` before the
`/runs` 404 guard, so an unknown schedule path is the protocol-only 404 (`not_found`) and never
falls through to the run routes. The plugin's start tool confines an agent-supplied `cwd` to the
calling agent's working directory (see the plugin section). The security model — what the token
grants, the env rules, script pinning, record-only worktree paths, unattended schedules, and
plugin confinement — is documented in
[`docs/architecture.md`](docs/architecture.md#security).

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
| `argos validate [path]` | `{valid, playbooks:[{id,file,hash}], errors:[{file,stepId,code,message}], warnings:[{file,stepId,code,message}]}` (one `errors[]` entry per schema issue; warnings never change `valid`) | 0 valid or warnings only, 2 invalid, 1 usage |
| `argos run <playbook> --input k=v [--cwd] [--isolation]` | `{runId, taskId}` | 0, 2 when refused |
| `argos ls [--schedule <id>]` | `{runs: RunSummary[]}` (newest first; `--schedule` keeps the runs whose `trigger.scheduleId` matches) | 0 |
| `argos status <runId>` | `RunDetail` | 0 |
| `argos gates` | `{gates: GateSummary[]}` (pending only) | 0 |
| `argos decide <runId> <gateId> <decision> [--comment]` | `GateDecisionResponse` | 0 |
| `argos cancel <runId>` | `{runId, status}` | 0 |
| `argos retry <runId> <stepId>` | `{runId, taskId}` | 0 |
| `argos fork <runId> <stepId>` | `{runId, taskId}` (a new `runId`, with `forkedFrom`) | 0, 2 `model_unavailable`, 1 otherwise |
| `argos rm <runId>` | `{runId, status, worktree?}` | 0 |
| `argos worktree rm <runId> [--force] [--delete-branch]` | `{runId, path, removed, branchDeleted}` | 0 |
| `argos worktree gc --older-than <dur> [--dry-run] [--force] [--delete-branch]` | `{removed: [{runId, path, branchDeleted}], skipped: [{runId, reason}], orphans: [path]}` | 0 |
| `argos schedule add <playbook> --cron <expr> [--id] [--tz] [--cwd] [--input k=v]… [--isolation none\|worktree] [--overlap skip\|allow] [--catch-up all\|0\|<n>(s\|m\|h\|d)] [--keep <n>\|all] [--paused]` | `ScheduleDetail` | 0, 1 usage |
| `argos schedule ls` | `{schedules: ScheduleSummary[]}` (sorted by id) | 0 |
| `argos schedule show <id>` | `ScheduleDetail` | 0 (`schedule_unknown` exits 1) |
| `argos schedule edit <id> [--cron] [--tz] [--cwd] [--input] [--isolation] [--overlap] [--catch-up] [--keep]` | `ScheduleDetail` | 0, 1 usage with no flag |
| `argos schedule pause <id>` / `resume <id>` | `ScheduleSummary` | 0 |
| `argos schedule run <id>` | `{runId, taskId}` | 0 (`run_active` while the live run still runs) |
| `argos schedule rm <id>` | `{id, removed: true}` | 0 |
| `argos serve [--port] [--home]` | `{port, home, pid}` | 0 |
| `argos doctor [--home] [--port]` | `DoctorReport` | 0 (report), 1 old Node |

Human output is concise; JSON is pretty-printed (except `serve`, one compact line). Global exit
codes: **0** ok, **1** usage/runtime, **2** validation failure, **3** unauthorized/unreachable.
`argos run` with no server prints "start it with `argos serve`" and exits 3; it never opens
SQLite. `argos doctor` works without a server (storage path/modes, schema version, port, Node
check) and adds `/info` data when reachable, including a `schedules` check (enabled/paused/refused
counts and the earliest `nextFireAt`, red when an enabled schedule's `lastFire.status` is
`refused`) — the `DoctorReport` shape itself is unchanged. `argos serve` retries `ArgosHost.open`
once on a transient failure, never on `storage_locked`, and closes server → host → Paseo port on
SIGINT/SIGTERM; it prints one stderr line per fire outcome,
`[argos] schedule <id> <iso> <status> run <runId>` (or the error code / missed count), and never an
input value. `ARGOS_FAKE_PASEO=1` selects the deterministic executor/fake catalog; it is test-only.

`argos schedule` fills the two values that must not depend on the server: `cwd` is the resolved
`--cwd` (else the CLI's own cwd) and `tz` is `--tz` (else the CLI process zone), so an unattended
run means the same thing on any machine. `--input` values are strings; `--isolation`, `--overlap`,
and `--keep` are refused locally (exit 1, no request sent), while a malformed `--catch-up` is sent
as typed and refused by the server with `invalid_request`. Every schedule command is an HTTP call:
the CLI never opens SQLite and never arms a timer.

## Paseo plugin

`packages/paseo-plugin` is a thin client: a sidebar row, a GitHub-CI-style screen (run list grouped
by playbook, filter chips, a run page with one row per step and an expandable step log), and four
chat tools. It never opens SQLite and keeps no run state, so a plugin reload cannot kill a run (the
engine lives in `argos serve`). The **chat tools** call `argos serve` over HTTP from the plugin
server (Node), while the **panel** calls the plugin server over Paseo RPC. That is deliberate: the
client bundle cannot read `$ARGOS_HOME/token`, browser CORS would block a direct HTTP call, and the
app may run on a different machine than the daemon.

| File | Role |
|---|---|
| `paseo-plugin.json` | manifest: `id: argos`, `requirements.paseo: ">=0.15.3"` |
| `index.server.ts` | default-exports `contribute(server)`; `agent.open.before` + the panel RPC handlers; teardown removes the hook and closes the client |
| `index.client.tsx` | `addSidebarHeaderItem` + `addScreen` (`ARGOS_SCREEN_ID = "argos"`), `SidebarRow` with the Lucide `Workflow` icon, theme tokens, `useRpc()` |
| `client/screen.tsx` | header (live pill, refresh, start form), error banner, list-or-run-page switch |
| `client/RunList.tsx` | filter chips + one collapsible group per playbook (newest run per row, older runs on demand) |
| `client/RunDetail.tsx` | run header/actions, pending-gate callouts, step rows with the log console, run log, after tasks |
| `client/GateCard.tsx` / `client/StartRunForm.tsx` | gate choices with a comment box / the start-run form |
| `client/ui.tsx` | theme-token React Native primitives (`Row`, `Txt`, `Button`, `PressableRow`, `Pill`, `StatusGlyph`, `RunId`, `StepProgress`) and `usePanel` |
| `client/react-native-host.d.ts` | narrow, strict types for the host-provided `react-native` module (client typecheck only) |
| `server/plugin.ts` | `createArgosRuntime` / `createArgosContribution` / `withArgosTools` |
| `server/tools.ts` | four `defineAgentTool` definitions + `appendArgosTools` |
| `server/connection.ts` | Node-only: resolves `ARGOS_HOME`/`ARGOS_PORT` + token, builds the tools client |
| `server/rpc.ts` | panel RPC handlers (`argos.runs.*`, `argos.gates.decide`) over the same client |
| `shared/rpc-api.ts` | zod RPC contracts + `{ok, data}` / `{ok:false, error}` result envelope |
| `shared/rpc-bridge.ts` | panel `ArgosRpc` over RPC: unwraps envelopes, polls snapshots every 2 s |
| `shared/rpc-client.ts` | portable `createArgosClient({url, token})` for the tools/HTTP path |
| `shared/panel.ts` | pure panel model: `loadPanel`, `decideGateOnce`, `subscribeRuns`, selection/detail sync, `groupRuns`, `buildStepLog`, `runView`/`panelView` |
| `shared/format.ts` | locale-free labels: duration, clock, relative time, short id, token/cost usage |
| `shared/panel-hub.ts` | one ref-counted panel per plugin instance (sidebar + screen share one poll loop) |
| `shared/identity.ts` | `PLUGIN_ID`, `REQUIRED_PASEO_VERSION` |

Tool names (exact): `argos_start_playbook` (`POST /runs`; playbook errors render as
`playbook_invalid`), `argos_run_status` (`GET /runs/:id`; never prompts), `argos_decide_gate`,
`argos_cancel_run`. Tools never throw; failures become `{error:{code,message}}`. A start call
generates a `clientRequestId` unless supplied. `argos_start_playbook` takes `execute(input,
context)`: it defaults `cwd` to `context.agent.cwd` and confines an explicit `cwd` to that directory
or a subdirectory (lexically: no `..` segment, absolute, exact match or `agentCwd + "/"` prefix); an
empty agent cwd is refused. A local refusal is `invalid_request` with **no** HTTP call, and a server
`invalid_request` stays `invalid_request` (not `playbook_invalid`). The confinement is lexical, not
a sandbox (symlinks pass); see `docs/architecture.md#security`.

`createArgosContribution({createClient?})` is the test seam. One call creates one runtime, registers
exactly one `agent.open.before` hook that appends the tools, and registers the panel RPCs
(`argos.runs.list`, `argos.runs.get`, `argos.runs.start`, `argos.runs.cancel`,
`argos.runs.remove`, `argos.runs.retry`, `argos.gates.decide`). Finished runs get a two-click
**Remove** button (no `window.confirm`: it does not exist on native). Teardown removes the hook and closes the client (aborting streams). No
settings screen: the **server** half resolves `ARGOS_PORT`/`ARGOS_HOME` + `$ARGOS_HOME/token`
lazily on first use (a plugin reload before `argos serve` still loads). RPC results are envelopes,
so stable codes such as `gate_already_decided` reach the panel unchanged. The panel publishes an
in-flight model before deciding (buttons disable), calls `decideGate` exactly once, treats an
already-decided gate as refresh-without-retry, and reconnects with capped exponential backoff (1 s
doubling to 8 s). Since Paseo RPC has no server push, `shared/rpc-bridge.ts` polls
`argos.runs.list` every 2 s and feeds the panel the same `snapshot` frames the SSE endpoint uses.

The screen is a two-level CI view. The list groups runs by playbook (a schedule would otherwise
flood it) with `All|Running|Failed|Completed` filter chips and one row per run (status glyph,
`#shortId`, trigger, relative time, duration, per-step progress); opening a run calls
`argos.runs.get` once and renders the run page: header + actions, pending-gate callouts, one row
per step, the selected step's log, the run log, and after tasks. The log is a pure projection of
`RunDetail` — the step's history events, its attempts (target, duration, usage), its declared
outputs, its outcome/error, and its gates — built by `buildStepLog`; agent transcripts are not
stored, so an agent step's log ends at its declared outputs. `selectRun` keeps the last detail
while refreshing and re-fetches only when the run's summary `seq` moved (`syncDetail`), so the 2 s
poll does not multiply requests. Copy-to-clipboard uses the host's `copyText` (no
`navigator.clipboard` assumption).

**Install (Paseo 0.15.4):** start `argos serve` first (it creates `$ARGOS_HOME/token`), then
`paseo plugin install /Users/dt/code/github.com/argos/packages/paseo-plugin`. Paseo bundles the
TypeScript **source** itself, so `npm run build` is not required for the plugin, and every module
must live in `server/`, `client/`, or `shared/` (Paseo rejects `src/`). Reload with
`paseo plugin reload argos`; check `paseo plugin ls` / `paseo plugin logs argos`.

Import-graph rule (`test/import-graph.test.ts`): no file under `packages/paseo-plugin/server/`,
`shared/`, `client/`, or either entry may import `@thaodangspace/argos-core/durable`, `@thaodangspace/argos-core/git`,
`@thaodangspace/argos-core/paseo`, `@thaodangspace/argos-core/engine`, `@thaodangspace/argos-core/playbook`, `@thaodangspace/argos-core/rpc/server`, the
`@thaodangspace/argos-core` root, `@earendil-works/*`, `node:sqlite`, or `node:child_process`. Only `server/` may
import `node:fs` (it reads the token); `shared/` and the client entry must stay portable. The only
`@thaodangspace/argos-core` subpaths are `@thaodangspace/argos-core/rpc` and `@thaodangspace/argos-core/rpc/contracts` (the latter is
Node-free); other imports are limited to `@getpaseo/*`, `react`, and `zod`, plus `react-native` in
the client half only.

**The client half is React Native, never DOM.** Paseo renders plugin UI natively on iOS/Android
and through react-native-web on desktop, so a DOM element (`<div>`, `<span>`, `<button>`) or a CSS
value (`padding: "0 8px"`, `lineHeight: "18px"`, `cursor`) works on desktop and breaks on mobile.
Build with `View`/`Text`/`Pressable` from `react-native` and `ScrollView`/`TextInput`/`copyText`
from `@getpaseo/plugin/client/ui` (the host resolves both at load time). Every string sits in a
`Text`; every outermost `Text` sets a color (native `Text` does not inherit it from a `View`); a
`View` is a column unless it says `row`. Three guards: `tsconfig.client.json` has no `DOM` lib and
types `react-native` through the strict `client/react-native-host.d.ts` (Paseo's template
installs `react-native` for types instead, ~290 packages); `test/import-graph.test.ts` rejects
lowercase JSX tags under `client/`; and `test/native-render.test.tsx` renders the list, form,
error banner, run page, and sidebar contribution with bare host components and checks the native
rules (host components only, text in `Text`, native style keys/values, explicit text color).

`react`/`@types/react` and `react-test-renderer`/`@types/react-test-renderer` are exact dev
dependencies for the `.tsx` typecheck and the native render test. Typecheck is split
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
script pinning (pins at start, `script_changed` on edit/delete/resume, `script_repinned` on retry,
after-task copy, pre-pinning records), `fork` (new run id, edited prompt reaching the executor,
prefix preserved and parent untouched, `forkedFrom` + `forked_from`, gates/loops/trigger/deadline
dropped, `definition_conflict` inside/outside the closure, script re-pin, fork worktree from the
parent branch), `definition-freeze` (a new start reads the edited YAML while a parked loop-limit
gate and a `retry` keep the frozen IR), worktrees, `readonly_violation`, and the scheduler:
`schedule-docs` (strict/hydrating documents, bounded `fires`/`runIds`, `scheduleRunId`),
`schedules` (CRUD, duplicate/limit refusals, the dry check), `schedule-runner` (arm/disarm, tick
order, cache), `schedule-fire` (one commit, guards, adopt-existing, run-now, refusal,
fire-time reload, announcement), `schedule-retention` (`keep`, live/worktree skips, failures
swallowed), and `run-request` (the shared resolve plus prepare/commit parity with `POST /runs`).
`test/schedule/` covers the pure `model` (ids, bounds, `catchUp`/`keep` normalization) and `next`
(`parseScheduleSpec`, `nextFireAfter`, `dueFireTimes`, DST in America/New_York, Europe/Berlin,
Asia/Saigon). The Paseo suite covers
create arguments, adoption with zero extra creates, `launch_uncertain`, handover, quota
fallback/exhaustion, `invalid_output`, fenced JSON fallback, and `model_unavailable`. The RPC suite
covers auth, idempotency, SSE, retry, gates, response projection, and the `/schedules` routes
(codes, statuses, projections). The plugin suite covers
manifest, hook/teardown, decide-once/SSE reconnect, tool names/errors, reload survival, the
CI-style grouping/filters/step log and the one-fetch detail sync (`test/detail.test.ts`), and the
import graph. The CLI suite covers validate exit codes, golden JSON shapes (including
`ls-schedule` and every `schedule-*` command), the no-storage import graph, the fire-line
formatter, a real-serve sentinel, and the npm channel (`test/publish.test.ts`: manifest metadata
and lockstep versions, byte-identical `LICENSE` copies, the release workflow order, and
`scripts/check-version.mjs` accepting a matching tag, refusing a mismatched one, and passing on a
branch).

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
3. *Schedule fire across `SIGKILL`*: add a 1-step schedule (`* * * * *`, `--tz UTC`, `--cwd` the
   temp repo), read `nextFireAt` from `argos schedule show --json`, `SIGKILL` **before** that
   instant, wait until the wall clock passes it, then restart on the same home and port. Waits for
   `argos ls --schedule <id> --json` to show exactly one run whose `trigger.fireAt` is that
   instant and whose ULID time prefix decodes to it (the random part is not hard-coded).
   `SIGKILL` + restart once more, then asserts: still one run for that fire time, one ledger
   creation per step of that run (`only:1`), `schedule show` reports `lastFire.status =
   "started"` for that fire time with a later `nextFireAt`, and the restarted server's stderr
   carries exactly one `[argos] schedule <id> <iso> started run <runId>` line.

All three scenarios clean up every child (`SIGTERM` then `SIGKILL`) and temp directory in
`afterEach`; A and B time out at 120 s, C at 180 s (it may wait a whole minute boundary), with 60 s
per wait.

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
| `croner` | `11.0.0` | core | cron next-fire calculator; it never arms its own timer |
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
- **Script pinning detects, it does not prevent (R4).** The hash is compared immediately before
  the spawn, so a writer that changes the file between the check and the `exec` is not stopped
  (and a script can still change its own file while it runs). A run also cannot use a script an
  earlier step creates: pins are resolved at `startRun`, so such a script is `playbook_invalid`
  at start (commit it instead).
- **Script environment is deny-by-default (R1).** A script no longer inherits `NODE_OPTIONS`,
  `SSH_AUTH_SOCK`, `GIT_*`, `CARGO_HOME`, or any other name its playbook does not grant, and
  Argos' own configuration (`ARGOS_HOME`, `ARGOS_PORT`, `ARGOS_PASEO_PASSWORD`, …) is never passed
  even when the step names it. `env: ["*"]` restores the old inherit-everything-that-is-not-secret
  behavior (`argos validate` then warns `env_inherit_all`); see `docs/compat.md` rows 21 and 30.
- **A fork cannot carry uncommitted worktree changes.** An isolated fork's checkout is cut from the
  parent's committed branch head (`argos/<parentRunId>`), so a dirty parent worktree stays behind
  for inspection instead of being copied. Nothing is fetched, and the source checkout's dirtiness
  is deliberately not checked (a normal isolated start still refuses it with `worktree_base_dirty`).
- **A fork needs a terminal parent and cannot change inputs.** Fork while a run is parked at a gate
  is `run_terminal` (cancel first), `--input` overrides are not accepted (that is a new run), and
  `after`-task edits are refused (`definition_conflict`) because a fork only rewrites the main
  graph.
- **A fork resets loop counters deliberately.** `retry` keeps them; a fork is a fresh attempt, so an
  operator can bypass a `max_loops` gate by forking. The gate is a human checkpoint, not a security
  control, and fork is an authenticated operator action.
- **`forkedFrom` may dangle.** `argos rm <parent>` retires the parent document while a fork keeps
  naming it; the reference is rendered as stored and never resolved.
- **Worktrees are never cleaned up automatically**; a failed/violating step leaves its worktree
  for inspection, and cleanup is the manual `argos worktree rm` / `argos worktree gc` pair (FR4).
  gc only *reports* a directory under `<home>/worktrees` that no run index entry claims.
- **Nothing fires while `argos serve` is down.** The timer lives in that process; the next start
  applies the catch-up rule once per schedule instead of replaying every missed fire time.
- **A schedule is unattended execution as the operator.** Only token-authenticated RPC (CLI or
  HTTP) creates, edits, or runs one; the Paseo plugin has no schedule panel or chat tool. `cwd` is
  validated at add/edit and again at every fire, scripts are pinned and re-hashed as for any run,
  and the document never stores environment values — but the work itself runs as the local user.
- **An aborted fire can leave an orphan worktree.** A fire that cuts `<home>/worktrees/<runId>`
  and then aborts in its commit (a pause, edit, or delete landed meanwhile) leaves that directory
  with no run to claim it; `argos worktree gc` reports it as an orphan.
- **A scheduled run uses whatever `origin/<base>` holds** when `isolation: worktree` fires,
  with no operator present to choose a base; the run record's frozen IR/hash is still what runs.
- **The model check can be skipped for schedules.** Without a loaded provider catalog (`argos
  serve` could not reach Paseo at startup) `add`/`edit`/a fire cannot refuse `model_unavailable`,
  exactly as with `POST /runs`; the run fails inside its first step instead.
- **Retention never removes a worktree.** A run whose checkout directory still exists is skipped
  by `keep` and retried after the next fire, so the operator must `argos worktree rm`/`gc` first.
- **No migration** from spec 02, paseo-playbooks run state, or pre-Phase-8 run indexes
  (pre-release; no migration path).
- **Paseo SDK limitation.** `waitForFinish()` exposes text but no structured JSON value, so the
  production port relies on the fenced-JSON fallback when a provider ignores `outputSchema`.
- **The plugin reads `ARGOS_HOME`/`ARGOS_PORT` once per client** and has no settings screen; the
  server must be started with matching values.
