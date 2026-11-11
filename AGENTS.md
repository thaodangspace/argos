# AGENTS.md

Argos — durable YAML playbook engine for Paseo agents. Implementation plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_impl_argos_yaml_playbook_engine.md`.
Current state: **Phase 3 (pure engine)**. Phase 4 (durable host) is next.

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
