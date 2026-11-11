# Compatibility with paseo-playbooks

Argos reads the same `.paseo/plugins/playbooks/` directory as
[`lerenn/paseo-playbooks`](https://github.com/lerenn/paseo-playbooks) and accepts its core playbook
surface. This document is the compatibility contract: every place Argos differs from upstream,
with the fixture or test that pins the behavior.

The golden fixtures in `packages/core/test/fixtures/compat/` are copied verbatim from upstream
(`packages/core/test/fixtures/ATTRIBUTION.md`, MIT). They must keep loading with an identical IR
hash on every run (`packages/core/src/playbook/load.test.ts`).

Run the compatibility checks with:

```sh
npx vitest run --project core src/playbook
npm run test:e2e   # the two real-process scenarios
```

## Discovery and identity

| Behavior | paseo-playbooks | Evidence |
|---|---|---|
| Discovery roots | `.argos/playbooks/*.yaml` first, then `.paseo/plugins/playbooks/*.yaml`; the first root wins an id collision. Roles/defaults/scripts follow the same fallback. | `packages/core/src/playbook/load.ts`; `test/fixtures/compat/.paseo/plugins/playbooks/` loads via the fallback in `src/playbook/load.test.ts` |
| Playbook id | File name without the extension (`pr.yaml` → `pr`). | `src/playbook/load.test.ts` (`discoverPlaybooks`) |
| Extensions | `.yaml` and `.yml`; other files ignored. | `src/playbook/load.ts` |
| Definition freeze | The fully resolved IR + `playbookHash` is stored in the run checkpoint; restarting a run never reloads the file. | `test/durable/run-checkpoint.test.ts`; `src/engine/record.ts` |

## Playbook surface divergences

| # | Behavior | paseo-playbooks | Evidence |
|---|---|---|---|
| 1 | An **agent step must declare a `prompt`**, either on the step or in its `role: { name, prompt }` block. A prompt-less agent step is `playbook_invalid` naming the step. | Upstream allows a prompt-less step whose work comes from the role's `instructions.md`. | `test/fixtures/invalid/.argos/playbooks/missing-prompt.yaml`; `src/playbook/validate.test.ts` |
| 2 | Poll aliases normalized to `step.pollMs`: `poll_ms`, `pollMs`, and paseo's `poll: "3s"` duration string. | Upstream uses `poll` inside a script block only. | `src/playbook/resolve.ts` (`DEFAULT_POLL_MS`, `durationToMs`); `test/fixtures/aliases/.argos/playbooks/aliases.yaml` + `src/playbook/aliases.test.ts` |
| 3 | Model-mode aliases: `mode` and `mode_id` both normalize to `agent.modeId`. | Upstream spells it `mode`. | `test/fixtures/compat/.../defaults/main.yaml` (`mode: bypassPermissions`) in `src/playbook/load.test.ts`; `test/fixtures/aliases/.argos/playbooks/child.yaml` (`mode_id`) in `src/playbook/aliases.test.ts` |
| 4 | Gate forms: flat step-level `gate: "question"` + `choices: [approve, reject]`, **or** paseo's `gate: { question, choices: { approve: {…}, reject: {…} } }`. In the block form `choices` is a mapping, not a list. | Upstream uses the block form. | `test/fixtures/aliases/.argos/playbooks/aliases.yaml` + `src/playbook/aliases.test.ts`; `test/fixtures/compat/.../docs.yaml` in `src/playbook/load.test.ts` |
| 5 | Script forms: flat `script: <file>` with optional step `env`, or paseo's `script: { run, poll, env }`. | Upstream uses the block form. | `test/fixtures/aliases/.argos/playbooks/aliases.yaml` + `src/playbook/aliases.test.ts`; `src/playbook/schema.ts` |
| 6 | `goto` accepts a bare id (`goto: review`) with sibling `max_loops`, or the plan's object form (`goto: { target, max_loops }`). | Upstream uses the bare id + sibling `max_loops`. | `test/fixtures/compat/.../docs.yaml` and `pr.yaml` (`{ goto: write, max_loops: 2 }`) in `src/playbook/load.test.ts`; `src/engine/loops.test.ts` |
| 7 | **Additive step kind `branch`**: ordered `cases: [{ name, if, end? }]`; the engine selects the first matching case, the last case is the else. This kind does not exist upstream. | No branch step; upstream uses `on` outcomes and gates. | `test/fixtures/when/.argos/playbooks/conditional.yaml`; `src/playbook/resolve.test.ts`; `src/engine/ready.test.ts` |
| 8 | **Sub-playbooks**: `use: <id>` (plan spelling) or `playbook: <id>` / `playbook: { name }` (paseo spelling). Steps are inlined at load time with a `<blockId>.` prefix (e.g. `pr.investigate`), depth 1, cycles rejected as `playbook_cycle`; `needs: [blockId]` resolves to the block's terminal steps. | Upstream has its own sub-playbook expansion; Argos uses the prefix form and rejects recursion past depth 1. | `test/fixtures/subplaybook/.argos/playbooks/{parent,child,cycle-a,cycle-b,deep}.yaml`; `src/playbook/expand.test.ts`; `test/fixtures/aliases/...` (`playbook: { name }`) in `src/playbook/aliases.test.ts` |
| 9 | **`use` is rejected inside `after`**: after-task steps are validated as a separate scope; only the main graph may inline sub-playbooks. | No equivalent restriction (no after-tasks). | `test/fixtures/aliases/.argos/playbooks/after-use.yaml`; `src/playbook/aliases.test.ts` |
| 10 | **Argos-only blocks are strict**: `agent`, `agent.fallback`, `agent.labels`, playbook `defaults`, `isolation`, playbook/role `labels`, `role.fallback`, `after`, `branch`, and `decider` reject unknown keys with `playbook_invalid` naming the step. Paseo-compatible surfaces stay permissive. | Upstream ignores unknown keys. | `src/playbook/schema.ts` (`z.strictObject`); `test/fixtures/aliases/.argos/playbooks/strict-agent.yaml` + `src/playbook/aliases.test.ts` |
| 11 | **`after` tasks** (`after: [{ id, trigger: auto|manual, steps }]`) are additive. `auto` starts once the main graph is terminal; `manual` waits for `startAfterTask`; neither changes the parent `run.status`. | No after-tasks. | `test/durable/after.test.ts`; `packages/core/src/durable/tasks/run.ts` |
| 12 | **Gate deciders** parse `decider: { by: human|role|manager, role?, agent? }` and preserve it in the IR. v1 always waits for an external decision through the RPC/CLI/plugin; a `by: role` decider is validated but **not** auto-launched (see limitations). | Upstream has human gates only. | `src/playbook/resolve.ts` (`resolveDecider`); `test/fixtures/compat/.../pr.yaml` (`gatekeeper` decider) in `src/playbook/load.test.ts`; gate execution in `test/durable/gates.test.ts` |
| 13 | **Ask-gate choice extensions**: an `ask` choice may carry `goto`, `outcome`, `max_loops`, and `outputs`, so one gate can re-route or write outputs. A step gate's `choices` only keep `label`/`comment`/`color`; the decision id **is** the step outcome. | Upstream choices are labels only. | `src/playbook/schema.ts` (`RawChoiceSchema`); `src/playbook/resolve.ts` (`gateChoices` vs `askChoices`); `src/engine/decide.test.ts` |
| 14 | **Implicit outcomes**: an agent step with no `outcomes` gets `success`/`failure`; a gate step gets its choice ids; a branch step gets its case names. An outcome with no `on` entry completes the step; an undeclared outcome that reaches the engine is a runtime `step_failed`. | Upstream has its own implicit outcome rules. | `src/playbook/resolve.ts` (`stepOutcomes`); `src/engine/reducer.test.ts`; `src/engine/transition.ts` |
| 15 | **Loop limits are enforced by the engine**: `max_loops: N` allows exactly N returns; the next return opens a `loop_limit` gate (`approve` grants one more traversal, anything else fails the step). | Upstream leaves loops to the playbook/manager. | `test/fixtures/compat/.../pr.yaml`; `src/engine/loops.test.ts`; `test/durable/gates.test.ts` |
| 16 | **Concurrency** is a scheduling bound, not an error: ready steps beyond `concurrency` stay `ready`; there is no `concurrency_limit` refusal for normal parallel runs. | No engine-level parallel scheduler. | `src/engine/ready.ts`; `src/engine/reducer.ts`; `packages/core/test/durable/durability.test.ts` |
| 17 | **Inputs** are wired from playbook inputs or earlier step outputs; a name with two possible sources is `playbook_invalid` and must be written explicitly as `{{ steps.<id>.outputs.<name> }}`. | Upstream uses name-based wiring. | `src/playbook/resolve.ts` (`wireInputs`); `src/playbook/load.test.ts` (`pr` inputs); `src/playbook/validate.test.ts` |
| 18 | **Agent precedence and fallbacks**: `step > role > playbook > defaults/main.yaml`; a `tier` expands from defaults; `fallback` targets become the ordered quota-fallback chain (FR24). Unknown targets refuse the run before any task exists (`model_unavailable`). | Upstream has tiers; no quota-fallback validation. | `test/fixtures/precedence/*` in `src/playbook/resolve.test.ts`; `src/paseo/model-catalog.ts`; `test/paseo/host.test.ts` |
| 19 | Paseo keys accepted but **not** part of the v1 IR: playbook `hidden`, `manager`, `workspace`, `next`, `singleton`; step `silence`, `archive_agents`; defaults `providers`, `manager`, `workspace`, `role`, `reload_stale_sessions`. They load (so upstream files do not fail) but have no effect. | Upstream may act on them. | `src/playbook/schema.ts`; `src/playbook/load.test.ts` (compat files load) |
| 20 | **Script steps**: run `.argos/scripts/<name>` (or the `.paseo/plugins/playbooks/scripts/` fallback) with `cwd` = the run worktree when isolation is on, a filtered env (see below), bounded stdout/stderr tails, and exit-code semantics. Exit `75` (`SCRIPT_NOT_YET`) parks the task and re-runs after `pollMs`; any other non-zero exit fails the step. Outputs are only `stdout`, `stderr`, `exitCode`/`exit_code`, `runs`. | Upstream's script block has its own `poll`/`env` semantics; Argos never parses script output as JSON. | `test/durable/scripts.test.ts`; `packages/core/src/durable/tasks/script.ts`; `test/fixtures/scripts/*` |
| 21 | **Script env filtering** (D10): keys matching `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` are removed unless the step declares them in `env`; `PATH`, `HOME`, `LANG`, `TMPDIR` (plus `TMP`/`TEMP`/`SystemRoot`) are always kept, case-insensitively. | Upstream inherits the full environment. | `src/engine/env.ts`; `test/durable/scripts.test.ts` (`MY_API_KEY` absent/present); `test/fixtures/scripts/env-keys.mjs` |
| 22 | **Read-only roles** are enforced by a git snapshot (`HEAD` + `status --porcelain=v1 -z`) before and after the step; any difference fails the step with `readonly_violation` and keeps the worktree. This **detects, does not prevent**. A read-only step in a non-git directory fails `step_failed` instead of pretending the guard ran. | Upstream uses the same snapshot mechanism. | `packages/core/src/git/snapshot.ts`; `test/durable/readonly.test.ts`; `test/git/snapshot.test.ts` |
| 23 | **Read-only blind spots**: a file created and deleted inside one step, a new file inside an already-untracked directory (the `?? dir/` entry does not change), and `.git`-ignored paths are invisible to the guard. | Same limitation upstream. | `src/git/snapshot.ts` header; `docs/architecture.md` |
| 24 | **Worktree isolation** (D9): `<ARGOS_HOME>/worktrees/<runId>` on branch `argos/<runId>`, from `origin/<base>` after `git fetch --prune origin`. Base order: `isolation.base` → `origin/HEAD` → the current branch if `origin/<branch>` exists → `origin/main` → `origin/master`. A dirty source checkout is refused `worktree_base_dirty` **before** any worktree or agent exists; other git failures are `worktree_failed` with redacted stderr. Worktrees are never removed automatically. | Upstream has its own isolation implementation; Argos uses `git` via `execFile` (no shell/library). | `test/git/worktree.test.ts`; `test/durable/worktree.test.ts`; `test/git/isolation.test.ts` |
| 25 | **A script can delete untracked files needed by later steps.** The engine does not sandbox scripts; this is outside its control and is documented rather than prevented. | Same practical limitation. | Spec edge case (`03_spec…` "Script deletes untracked files"); `test/durable/scripts.test.ts` |
| 26 | **No run/state migration from upstream.** Argos does not import paseo-playbooks run state or its JSON checkpoints; only playbook definitions are compatible. | Upstream state is its own format. | Spec "Out of Scope"; this document |

## What is intentionally not compatible

- Upstream's manager/handoff/singleton behavior is parsed and ignored (row 19).
- The `manager` agent is never launched; Argos has no LLM in the control path.
- Gate `by: role` deciders are metadata in v1; a decision always arrives through the RPC
  (`argos decide`, the plugin, or a direct HTTP call), so the gate latency budget stays a human
  decision plus a 2 s poll.
- Run history, approvals, and retries live in Argos' SQLite/documents, not in upstream files.

If a playbook validates under paseo-playbooks' core keys (steps, needs, on, outcomes, gate,
choices, inputs, outputs, role) it must validate under Argos with the same step order and outcomes;
the golden fixtures enforce that. Any new divergence must add a row here plus a fixture or test.
