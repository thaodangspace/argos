# Argos

Durable YAML playbook engine for [Paseo](https://github.com/getpaseo) agents.

A repository declares its workflow as YAML (`.argos/playbooks/*.yaml`); a deterministic engine
executes it against agents launched through Paseo, with parallel steps, human gates, loops,
script steps, crash-safe resumption, and cron schedules that fire playbooks unattended. **No LLM
decides control flow** — models only do the work inside a step.

- [docs/architecture.md](docs/architecture.md) — processes, layers, durability model, scheduler.
- [docs/compat.md](docs/compat.md) — compatibility with paseo-playbooks and its limits.

## Requirements

- Node `>=22.13` (Argos uses the built-in `node:sqlite`, which needs no flag from 22.13 on).
- A running Paseo daemon (`ws://127.0.0.1:6767/ws` by default) with at least one provider ready.
- `git` for worktree isolation and the read-only guard.
- Paseo `>=0.15.3` for the panel/chat-tool plugin.

## Install

```sh
npm i -g @thaodangspace/argos     # provides the `argos` command
# or, without installing:
npx @thaodangspace/argos --help
```

Both published packages are public on npm: `@thaodangspace/argos` (the CLI) and
`@thaodangspace/argos-core` (the library: loader, engine, durable host, RPC server, Paseo
adapter). The Paseo plugin is installed from a checkout, not through npm (see
[Paseo plugin](#paseo-plugin)).

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
the private plugin all share one version, and the CLI pins the core version it ships with.

```sh
npm run version:check -- v0.1.0        # tag must match every manifest
git tag v0.1.0 && git push origin v0.1.0
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which re-runs the version guard, the unit
suite and the typecheck, then publishes core first and the CLI second with npm provenance
(`NPM_TOKEN` repository secret). To publish by hand, use
`npm publish -w @thaodangspace/argos-core && npm publish -w @thaodangspace/argos`.

## Run the server

`argos serve` is the only process that opens `$ARGOS_HOME/argos.sqlite` (`ARGOS_HOME` defaults to
`~/.argos`, mode `0700`; database and token `0600`). It creates a bearer token on first start and
reopens/resumes any interrupted runs.

```sh
argos serve                 # 127.0.0.1:7676
argos serve --port 7800     # explicit port
argos doctor                # storage, schema, port, Paseo, providers, pending gates
```

The CLI and plugin talk HTTP to this process; they never open the database. If the server is not
running, `argos run` tells you to start it and exits with code `3`.

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

## Schedules

`argos serve` can fire a playbook on a cron expression, so recurring work is one normal run per
fire instead of an endless loop run:

```sh
argos schedule add nightly --cron "0 7 * * *" --cwd ~/code/repo
argos schedule ls                     # state, cron, tz, next fire, last fire
argos schedule show nightly           # policy, fire log, recent runs
argos schedule run nightly            # fire now, without touching nextFireAt
argos schedule pause nightly          # and `resume <id>` to re-arm
argos schedule rm nightly
argos ls --schedule nightly           # only the runs that schedule started
argos doctor                          # storage, providers, gates, schedules
```

The playbook id is the default schedule id (`--id` overrides it), and `--tz` defaults to the CLI's
zone. The cron expression (5 fields, or `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`) and the
IANA zone are validated when the schedule is added, together with the same dry start check
`argos run` performs — a broken playbook, a missing script, or a bad `cwd` is refused immediately.
Each fire creates a separate, normal run whose record carries
`trigger: {kind: "schedule", scheduleId, fireAt, reason}`, so it shows up in `argos ls` /
`argos status` like any other run.

`--catch-up` decides what happens after a gap (a closed laptop, a stopped server): `all` (default)
fires once for the latest missed fire time, `0` only within two minutes, and a duration such as
`90m` inside that window — earlier missed times are recorded in the fire log as `missed` and are
never replayed one by one. `--overlap skip` (default) skips a fire while the previous run of that
schedule is still running (the fire log says `skipped_overlap`) and `allow` starts anyway.
`--keep` (default `30`, or `all`) removes that schedule's finished runs beyond the newest N after
a fire, with the same removal `argos rm` performs; a run whose worktree directory still exists is
kept until you clean the worktree up yourself (`argos worktree rm` / `gc`), and retention never
deletes a worktree or a branch.

## Paseo plugin

`packages/paseo-plugin` is a thin HTTP client of `argos serve` (manifest `id: argos`, requires
Paseo `>=0.15.3`). It adds a sidebar row/panel for runs, step statuses, and pending gates, plus the
chat tools `argos_start_playbook`, `argos_run_status`, `argos_decide_gate`, and
`argos_cancel_run`.

Install it from the directory (Paseo bundles the TypeScript source itself):

```sh
argos serve                                      # first: creates $ARGOS_HOME/token
paseo plugin install /path/to/argos/packages/paseo-plugin
paseo plugin ls                                  # argos should be "running"
paseo plugin logs argos                          # load errors, if any
paseo plugin reload argos                        # after changing plugin source
```

The Paseo daemon and `argos serve` must agree on `ARGOS_HOME`/`ARGOS_PORT`. The plugin's server half
reads the token; the chat tools call `argos serve` over HTTP, and the panel calls the plugin's RPC
handlers (`argos.runs.list`, `argos.gates.decide`, …), which run beside the server. That is why the
panel works across remote hosts even though `argos serve` binds `127.0.0.1`. Because the engine
lives in `argos serve`, reloading the plugin cannot kill a run; it reconnects and re-renders.

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
npm test            # build + 600+ loader/engine/host/RPC/plugin tests, no external processes
npm run typecheck   # tsc for every workspace and test graph
npm run test:e2e    # build + real `argos serve`, SIGKILL, restart (step, gate, schedule)
```

`npm test` intentionally excludes `test/e2e`: that suite spawns real processes and runs in its own
CI job. It uses `ARGOS_FAKE_PASEO=1` (test-only; never for real work) so no daemon or model is
needed.

## Layout

| Workspace | Package | Contents |
|---|---|---|
| `packages/core` | `@thaodangspace/argos-core` | loader/IR, pure engine, durable host, RPC server, Paseo adapter (npm) |
| `packages/cli` | `@thaodangspace/argos` | `argos` CLI (HTTP client of `argos serve`; npm, `bin: argos`) |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel and chat tools (HTTP client; private, installed by path) |

More: [AGENTS.md](AGENTS.md) for the implementation contract, storage layout, task kinds, error
codes, and test commands.

## License

MIT — see [LICENSE](LICENSE).
