# Argos

Durable YAML playbook engine for [Paseo](https://github.com/getpaseo) agents.

A repository declares its workflow as YAML (`.argos/playbooks/*.yaml`); a deterministic engine
executes it against agents launched through Paseo, with parallel steps, human gates, loops,
script steps, and crash-safe resumption. **No LLM decides control flow** — models only do the
work inside a step.

- [docs/architecture.md](docs/architecture.md) — processes, layers, durability model.
- [docs/compat.md](docs/compat.md) — compatibility with paseo-playbooks and its limits.

## Requirements

- Node `>=22.5` (Argos uses the built-in `node:sqlite`).
- A running Paseo daemon (`ws://127.0.0.1:6767/ws` by default) with at least one provider ready.
- `git` for worktree isolation and the read-only guard.
- Paseo `>=0.15.3` for the panel/chat-tool plugin.

## Install and build

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
```

Every command supports `--json` with a stable shape. Exit codes: `0` success, `1` usage/runtime,
`2` playbook validation failure, `3` unauthorized/unreachable server.

## Paseo plugin

`packages/paseo-plugin` is a thin HTTP client of `argos serve` (manifest `id: argos`, requires
Paseo `>=0.15.3`). It adds a sidebar row/panel for runs, step statuses, and pending gates, plus the
chat tools `argos_start_playbook`, `argos_run_status`, `argos_decide_gate`, and
`argos_cancel_run`. Install the `packages/paseo-plugin` directory through Paseo's plugin install
flow (it contains `paseo-plugin.json`). Because the engine lives in `argos serve`, reloading the
plugin cannot kill a run; it reconnects to the same server and re-renders.

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
npm test            # build + 300+ loader/engine/host/RPC/plugin tests, no external processes
npm run typecheck   # tsc for every workspace and test graph
npm run test:e2e    # build + real `argos serve`, SIGKILL, restart (two scenarios)
```

`npm test` intentionally excludes `test/e2e`: that suite spawns real processes and runs in its own
CI job. It uses `ARGOS_FAKE_PASEO=1` (test-only; never for real work) so no daemon or model is
needed.

## Layout

| Workspace | Package | Contents |
|---|---|---|
| `packages/core` | `argos-core` | loader/IR, pure engine, durable host, RPC server, Paseo adapter |
| `packages/cli` | `argos-cli` | `argos` CLI (HTTP client of `argos serve`) |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel and chat tools (HTTP client) |

More: [AGENTS.md](AGENTS.md) for the implementation contract, storage layout, task kinds, error
codes, and test commands.

## License

MIT — see [LICENSE](LICENSE).
