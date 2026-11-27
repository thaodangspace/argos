# Argos

Durable YAML playbook engine for [Paseo](https://github.com/getpaseo) agents — or herdr-core (`hc`)
terminals.

A repository declares its workflow as YAML (`.argos/playbooks/*.yaml`); a deterministic engine
executes it against agents launched through a named **executor**, with parallel steps, human gates,
loops, script steps, crash-safe resumption, and cron schedules that fire playbooks unattended.
Paseo and herdr-core (`hc`) are both first-class; `hc` is the default substrate whenever a core is
reachable, `paseo` otherwise, and the same playbook runs on either. The
substrate a run started on is frozen in its run record. **No LLM decides control flow** — models
only do the work inside a step.

- [docs/architecture.md](docs/architecture.md) — processes, layers, durability model, scheduler.
- [docs/compat.md](docs/compat.md) — compatibility with paseo-playbooks and its limits.

## Requirements

- Node `>=22.13` (Argos uses the built-in `node:sqlite`, which needs no flag from 22.13 on).
- A running Paseo daemon (`ws://127.0.0.1:6767/ws` by default) with at least one provider ready —
  only for Paseo runs; an `hc` run never touches it.
- `git` for worktree isolation and the read-only guard.
- Optional: a running herdr-core core (`hc`, protocol generation 1) for `executor: hc` runs. Argos
  talks to its socket (`HC_SOCKET`, or `HC_SESSION`'s socket) and never spawns `hc` itself.

## Install

```sh
npm i -g @thaodangspace/argos     # provides the `argos` command
# or, without installing:
npx @thaodangspace/argos --help
```

Both published packages are public on npm: `@thaodangspace/argos` (the CLI) and
`@thaodangspace/argos-core` (the library: loader, engine, durable host, RPC server, Paseo and
herdr-core adapters). The web UI ships inside the CLI tarball and is served by `argos serve` under
`/ui`.

## Build from source

```sh
npm ci
npm run build
```

The build emits `packages/*/dist`. Use the CLI directly:

```sh
node packages/cli/dist/index.js --help
```

or link it once:

```sh
npm link ./packages/cli   # then `argos ...`
```

## Release (maintainers)

Versions are kept in lockstep: the root, `@thaodangspace/argos-core`, `@thaodangspace/argos`, and
the private web UI all share one version, and every workspace pins the core version it ships with.

```sh
npm run version:bump -- patch         # 0.1.1 -> 0.1.2 in every manifest + the lockfile
npm run version:check -- v0.1.2       # guard: tag must match every manifest
git commit -am "chore(release): v0.1.2"
```

Merging that commit into `main` publishes: `.github/workflows/release.yml` probes npm, and when the
version is not there yet it re-runs the version guard, the unit suite, the typecheck, the UI build
and the end-to-end suite, then publishes core first and the CLI second with npm provenance
(`NPM_TOKEN` repository secret, or npm trusted publishing). Pushing a `v*` tag is the same publish
path. The job sits behind the `npm-publish` environment, so a reviewer approves between merge and
publish; a merge that does not bump the version is a no-op. To publish by hand, use
`npm run release:publish`.

## Run the server

`argos serve` is the only process that opens `$ARGOS_HOME/argos.sqlite` (`ARGOS_HOME` defaults to
`~/.argos`, mode `0700`; database and token `0600`). It creates a bearer token on first start and
reopens/resumes any interrupted runs.

```sh
argos serve                 # 127.0.0.1:7676
argos serve --port 7800     # explicit port
argos serve --default-executor paseo   # both registered; hc is the default, paseo spelled out
argos doctor                # storage, schema, port, Paseo, providers, executors, gates
```

`argos serve` builds the executor registry at startup: `paseo` always, `hc` when a core answers
`hello`/`server.status` within 5 s (otherwise one warning and `hc` is left out). It prints one line
naming the registry in registry order, `[argos] executors: hc (default), paseo`, and `argos doctor`
reports each executor's reachability and version. (The default is `--default-executor`, else
`ARGOS_EXECUTOR`, else `hc` when its adapter registered, else `paseo` — so a machine with no
herdr-core behaves exactly as before.)

On `hc`, each step also carries the `herdr.space`/`herdr.tab` labels, so the Herdr app shows it as
a pane while it runs (space `argos`, one tab per run). No other client reads a label and an install
without the app keeps them as data; `ARGOS_HERDR=0` turns them off, `ARGOS_HERDR_SPACE` /
`ARGOS_HERDR_TAB` override the two ids.

The CLI and the web UI talk HTTP to this process; they never open the database. If the server is not
running, `argos run` tells you to start it and exits with code `3`.

## Web UI

`argos serve` also serves a browser UI on the same port. Open
[`http://127.0.0.1:7676/ui`](http://127.0.0.1:7676/ui) (or the `[argos] ui …` line `argos serve`
prints) after starting the server. It shows every workflow run grouped by playbook with filter
chips, opens a run into a GitHub-Actions-style step rail plus that step's log (attempts, declared
outputs, usage, gates), and lets you approve or reject a gate, cancel, retry a step, fork from a
step, and start a new run from a typed form. It updates live over `GET /events`.

The UI ships inside the CLI tarball. In a development checkout, build and point the server at it:

```sh
npm run build:ui                                  # writes packages/web/build
ARGOS_UI_DIR=packages/web/build argos serve       # then open /ui
ARGOS_UI_DIR= argos serve                         # API only
```

To rebuild this checkout and restart a locally running server in one step, use
`npm run local:restart` (`-- --help` lists flags such as `--tests`, `--no-ui`, `--no-restart`).

The browser never holds the bearer token: the server issues a per-process `HttpOnly` session cookie
(see `docs/architecture.md#browser-session-web-ui`). The UI is a projection of the same read model
as the CLI — it never shows prompts or agent transcripts, which the API does not expose.

## A minimal playbook

Put this in `.argos/playbooks/fix.yaml`:

```yaml
title: Fix an issue
inputs:
  issue: { type: string, required: true }
defaults:
  agent:
    provider: claude
    model: sonnet
steps:
  - id: investigate
    prompt: "Investigate this issue and propose a plan: {{ playbook.inputs.issue }}"
    outputs:
      plan: { type: string, required: true }
  - id: implement
    needs: [investigate]
    prompt: "Implement this plan:\n{{ steps.investigate.outputs.plan }}"
  - id: review
    needs: [implement]
    prompt: "Review the working tree and report any requested changes."
    outcomes: [approved, changes_requested]
    on:
      changes_requested: { goto: implement, max_loops: 2 }
  - id: approve
    needs: [review]
    gate:
      question: "Ready to merge?"
      choices:
        approved: { label: Approve, color: success }
        rejected: { label: Reject, color: danger }
```

```sh
argos validate                        # validates .argos/playbooks in the current repo
argos chart --format mermaid          # the playbook DAG as Mermaid (or --format json)
argos run fix --input issue="crash on empty config"
argos status <runId>
argos gates                           # pending gates across runs
argos decide <runId> <gateId> approved
argos cancel <runId>
argos retry <runId> <stepId>
argos rm <runId>                      # delete a finished run (its worktree is kept)
```

Every command supports `--json` with a stable shape. Exit codes: `0` success, `1` usage/runtime,
`2` playbook validation failure, `3` unauthorized/unreachable server.

The graph is derived, never stored: `argos chart` renders a discovered playbook — or, with
`--run <id>`, the definition a run froze — offline and without a server (see
[`docs/playbook-example.mmd`](docs/playbook-example.mmd)). The web UI draws the same projection as
an SVG DAG on `?view=graph` of a run page, next to the default rail view.

### Pausing inside a loop

A `delay` step waits a fixed time and then succeeds. Use it for "work, wait, repeat" loops instead
of a `sleep` script:

```yaml
steps:
  - id: tick
    prompt: "Do one round of work."
  - id: wait
    needs: [tick]
    delay: 30m            # ms, a duration (90s, 30m, 2h), or "{{ inputs.interval }}"
    on:
      success: { goto: tick, max_loops: 96 }
```

The wake time is computed once and stored durably, so restarting `argos serve` neither restarts
nor shortens the pause (a `sleep` script is killed by a restart and starts over). A delay step
has no step timeout and takes no `timeout`, `retries`, `prompt`, `script`, or `outputs`.

## Executors: herdr-core or Paseo

A run executes on exactly one **executor**. herdr-core (`hc`) is the default whenever a core is
reachable, and Paseo is the other substrate: the same playbook runs on either, and `paseo` behaves
exactly as it always did. The id is resolved once, at start:

`argos run --executor` / `POST /runs {executor}` → the schedule's `executor` → the playbook's
`executor` → the server's default (`--default-executor`, else `ARGOS_EXECUTOR`, else `hc` when its
adapter registered, else `paseo`).

Because `hc` is the default whenever a core answers at startup, a playbook that targets Paseo must
pin `executor: paseo` (or `defaults.executor: paseo`, or start the server with `--default-executor
paseo`). An unpinned Paseo-targeted playbook is refused `model_unavailable` before any task, naming
the `hc/<...>` targets it would have needed — never silently run on the wrong substrate.

```yaml
# .argos/playbooks/hello.yaml — or `executor:` in defaults or defaults/main.yaml
executor: hc

steps:
  - id: hello
    agent: { provider: hc, model: opencode }   # target = hc/<template>
    prompt: "Say hello and nothing else."
  - id: announce
    needs: [hello]
    script: announce.sh
```

`herdr`/`herdr-core` normalize to `hc`. The resolved id is written into the run record (the key is
omitted for `paseo`, so older records stay byte-identical), which means a restart with a different
`--default-executor` cannot move an in-flight run, `argos retry` keeps it, and `argos fork` inherits
it. An id the server does not carry is `executor_unavailable` (422) **before** any task, worktree,
or run-index entry exists.

```sh
argos run hello --executor paseo     # override for one run (an unknown id exits 1, no request)
argos schedule add nightly --cron "0 3 * * *" --executor hc   # pin an unattended run
argos ls                             # appends `[executor hc]` for a non-default run
```

### herdr-core targets and terminals

An `hc` step targets a **template**: `agent: { provider: hc, model: <name> }` → `hc/<name>`. The
catalog is `templates.list`, so a template the core does not offer is `model_unavailable` before any
terminal exists. Templates are Markdown files with YAML frontmatter (`name`, `description`,
`command`) under `~/.config/herdr-core/templates/<name>.md`; `hc templates` lists them.

Argos creates one terminal per step attempt (name `argos-<16 hex>`, labels `argos/launch`,
`argos/run`, `argos/step`, `argos/attempt`, `argos/home`), types the prompt into it, and removes it
when the step settles. Terminals are **headless**: they belong to the core, not to a Herdr
window/tab, so during a run they appear in `hc ls` (and can be watched with
`hc attach --observe <name>`) but not as a tab in the app.

- Completion comes from the program's own OSC 7501 status (or its exit code). A program that never
  reports status never looks finished and the step runs to its `timeout` (`step_timeout`), so a
  template whose agent does not report status needs a small wrapper that emits `state=working` /
  `state=done`.
- `blocked` is reported as still running (`detail: "blocked: <msg>"`), never as a gate in v1; the
  step deadline still governs.
- Declared `outputs` use the same fenced-JSON fallback as Paseo; `usage`/cost stays absent.
- A lost terminal gets one handover relaunch, then `agent_missing`; a transport failure is
  `executor_unreachable` (503) and parks the step until its `timeout`: a failed launch retries the
  same adopt-or-create call (adopting a terminal the failed call already made), a failed poll parks
  to the same deadline.

A runnable example lives in [`.argos/demo/README.md`](.argos/demo/README.md) (two opencode agent
steps and one script step, all on `hc`).

### Template packs

Argos ships two template packs and installs them once per machine: `claude` (four headless Claude
Code profiles — work timeout, quota wait, and the final-message shaping wrapped into one program)
and `smoke` (a short program that proves the whole chain without spending a token).

```sh
argos hc templates install          # claude + smoke; writes hc's templates dir and $ARGOS_HOME/hc/packs
argos hc templates list             # what this machine installed, and the command each template runs
argos hc templates verify           # disk vs manifest, manifest vs the running server's catalog
argos hc templates install --dry-run   # the plan, writing nothing
```

A pack is data (`pack.json`: program file, per-template args, and a `minStepTimeoutMs` budget) plus
one standalone `.mjs` program; `argos hc templates install` copies the program to
`$ARGOS_HOME/hc/packs/<pack>@<version>/` and generates one `.md` per template in hc's templates
directory, so nothing on the machine points into a checkout any more. The installed `.md` carries a
`· argos-pack <name> <version>` marker; `uninstall` deletes only files that carry it. `argos serve`
reads its template roster once at startup, so restart it after installing (or run `argos doctor`).
`verify` and the doctor's `hc templates` line are how you tell "not installed" from "installed but
the server has not seen it".

One rule for an author: **a step's `timeout` must exceed the template's work timeout plus its quota
wait.** The default is 30 minutes, and the program may wait out a usage limit with the terminal
still `working`; for `claude-opus-high` (150m of work, up to 4h of quota wait) that means
`timeout: 7h`. A program must also report OSC 7501 status (`working`/`done`) and leave exactly one
fenced JSON block on screen — a TUI that never reports status runs to the step deadline. See
[`docs/hc-templates.md`](docs/hc-templates.md) for the knobs, the per-template numbers, and the
migration from a vendored `claude-step.py`.

## Schedules

`argos serve` can fire a playbook on a cron expression, so recurring work is one normal run per
fire instead of an endless loop run:

```sh
argos schedule add nightly --cron "0 7 * * *" --cwd ~/code/repo
argos schedule add nightly --cron "0 3 * * *" --cwd ~/code/repo --executor hc
argos schedule ls                     # state, cron, tz, next fire, last fire
argos schedule show nightly           # policy, fire log, recent runs
argos schedule run nightly            # fire now, without touching nextFireAt
argos schedule pause nightly          # and `resume <id>` to re-arm
argos schedule rm nightly
argos ls --schedule nightly           # only the runs that schedule started
argos doctor                          # storage, providers, executors, gates, schedules
```

The playbook id is the default schedule id (`--id` overrides it), and `--tz` defaults to the CLI's
zone. The cron expression (5 fields, or `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`) and the
IANA zone are validated when the schedule is added, together with the same dry start check
`argos run` performs — a broken playbook, a missing script, or a bad `cwd` is refused immediately.
Each fire creates a separate, normal run whose record carries
`trigger: {kind: "schedule", scheduleId, fireAt, reason}`, so it shows up in `argos ls` /
`argos status` like any other run. `--executor` pins the substrate for every fire (the same dry
check refuses one the server cannot run); without it, each fire resolves the playbook then the
server default, so changing the default moves an unpinned schedule.

`--catch-up` decides what happens after a gap (a closed laptop, a stopped server): `all` (default)
fires once for the latest missed fire time, `0` only within two minutes, and a duration such as
`90m` inside that window — earlier missed times are recorded in the fire log as `missed` and are
never replayed one by one. `--overlap skip` (default) skips a fire while the previous run of that
schedule is still running (the fire log says `skipped_overlap`) and `allow` starts anyway.
`--keep` (default `30`, or `all`) removes that schedule's finished runs beyond the newest N after
a fire, with the same removal `argos rm` performs; a run whose worktree directory still exists is
kept until you clean the worktree up yourself (`argos worktree rm` / `gc`), and retention never
deletes a worktree or a branch.

## Database maintenance

One process owns `$ARGOS_HOME/argos.sqlite`, so cleanup is a command on the running server rather
than a second tool opening the file:

```sh
argos db stats                       # size, WAL, pages, runs, tasks, receipts
argos db purge --older-than 30d --dry-run   # what would go, without touching anything
argos db purge --older-than 30d --vacuum    # retire old runs, reclaim rows, compact
argos db vacuum                      # just compact the file
```

`purge` only considers **terminal** runs whose `updatedAt` is older than the window; a live run is
reported as `active`. It retires them with the same commit `argos rm` uses, then reclaims the
terminal task records (the bulk of the file) and the expired idempotency receipts. Worktrees are
never deleted by a purge — `argos worktree rm` / `gc` owns those. Nothing runs on a timer: the
window is always explicit.

## Isolation and read-only roles

```yaml
# .argos/playbooks/review.yaml
isolation:
  mode: worktree            # private worktree under $ARGOS_HOME/worktrees/<runId>
  base: main                # optional; fetched from origin
steps:
  - id: review
    role: reviewer
    prompt: "Review the change."
```

```yaml
# .argos/roles/reviewer/role.yaml
title: Reviewer
readonly: true              # any working-tree change fails the step
agent:
  provider: claude
  model: sonnet
```

A dirty source checkout refuses the run before any agent exists. Read-only enforcement uses a
before/after git snapshot: it detects changes and fails the step, but cannot prevent a write while
the step runs (see [docs/compat.md](docs/compat.md)).

## Development

```sh
npm test            # build + 900+ loader/engine/host/adapters/RPC tests, no external processes
npm run typecheck   # tsc for every workspace and test graph
npm run test:e2e    # build + real `argos serve`, SIGKILL, restart (step, gate, schedule, delay, hc)
```

`npm test` intentionally excludes `test/e2e`: that suite spawns real processes and runs in its own
CI job. It uses `ARGOS_FAKE_PASEO=1` and `ARGOS_FAKE_EXECUTOR=hc` (test-only; never for real work)
so no daemon, opencode or model is needed.

## Layout

| Workspace | Package | Contents |
|---|---|---|
| `packages/core` | `@thaodangspace/argos-core` | loader/IR, pure engine, durable host, RPC server, Paseo and herdr-core adapters (npm) |
| `packages/cli` | `@thaodangspace/argos` | `argos` CLI (HTTP client of `argos serve`; npm, `bin: argos`) |
| `packages/web` | `@thaodangspace/argos-web` | SvelteKit browser UI served by `argos serve` under `/ui` (HTTP client; private) |

More: [AGENTS.md](AGENTS.md) for the implementation contract, storage layout, task kinds, error
codes, and test commands.

## License

MIT — see [LICENSE](LICENSE).
