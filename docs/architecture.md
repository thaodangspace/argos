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
| `argos serve` | SQLite, the pi-durable harness, the schedule runner (one timer over durable schedule documents), the Paseo client, the loopback RPC server, the bearer token | nothing outside its home; no agent work itself |
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

`argos validate|run|ls|status|gates|decide|cancel|retry|rm|worktree|schedule|serve|doctor` are
HTTP clients of `argos serve` (except `validate`, which only reads files, and `doctor`, which also
inspects the local home when the server is down). `POST` writes accept `clientRequestId`; the
lookup and create share one commit, so a retried request returns the same run. `GET /events` is
commit-driven SSE with a snapshot frame and reconnecting clients; the plugin re-fetches on
reconnect.

The scheduler's operator surface is `argos schedule add|ls|show|edit|pause|resume|run|rm` and
`argos ls --schedule <id>`. A schedule's `cwd` (resolved `--cwd`, else the CLI's cwd) and `tz`
(`--tz`, else the CLI process zone) come from that invocation, never from the server, so an
unattended run means the same thing after a restart or from another machine; the RPC layer
requires `cwd` in the body for the same reason.

`RunSummary`/`RunDetail` never contain prompts, agent messages, transcripts, or credential-like
inputs. `RunDetail` adds what a CI-style step log needs — each step's attempts (`target`, timing,
usage), its declared outputs (credential-shaped output names dropped, long values truncated), its
outcome, and the run's bounded history; the list projection stays lean. The plugin holds no
durable state: teardown closes only its HTTP client and streams, and a new plugin instance
reconnects to the same `argos serve` run.

## Security

Argos is a **single-user, local** tool. It does not sandbox the work it starts: a playbook's scripts
and agents run as the local user, with that user's files, environment, and credentials (whatever
the env rules below allow). The security model is therefore about *who can ask Argos to run
something*, not about containing what the run does.

### Threat model

| Trusted | Untrusted / out of scope |
|---|---|
| The operator's account, `$ARGOS_HOME` (`0700`), the token file (`0600`), the `argos serve` process | A repository's playbook or script contents (they are code, reviewed like code), a compromised Paseo daemon or agent, a process running as the same user |
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
  checkouts. `GET` routes expose run metadata only: no prompts, transcripts, agent messages, or
  playbook IR ever appear in `RunSummary`/`RunDetail`.

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
(`ARGOS_PASEO_PASSWORD`, `ARGOS_HOME`, `ARGOS_PORT`, `ARGOS_PASEO_URL`, the `ARGOS_FAKE_PASEO*`
knobs) is never passed, even when named. `NODE_OPTIONS`, `SSH_AUTH_SOCK`, and `GIT_*` are absent
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
- **Definition freeze.** A run's IR and hash are immutable once started.
- **Durable schedules.** A schedule is a document, not a task; one in-process timer only wakes a
  tick, and the fire's single commit (guards plus a deterministic run id) is what makes a fire
  happen exactly once.

## Where to read more

- `AGENTS.md` — commands, storage layout, task/document kinds, error codes, env vars, tests.
- `docs/compat.md` — the paseo-playbooks divergences with fixtures.
- `docs/spikes/pi-durable-host.md` — the spike that pinned the pi-durable host behavior.
- The approved spec and plan in `brain/spec/2026/Nov/11/03_*`.
