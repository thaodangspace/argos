# @thaodangspace/argos

The `argos` command-line client for [Argos](https://github.com/thaodangspace/argos) — a durable YAML
playbook engine for [Paseo](https://github.com/getpaseo) agents and herdr-core (`hc`) terminals.

A repository declares its workflow in `.argos/playbooks/*.yaml`; a deterministic engine runs it,
launching agents through a named executor (`paseo` by default, or `hc`) for the work inside each
step, with parallel steps, human gates, loops, script steps, worktree isolation, crash-safe
resumption, and cron schedules that fire playbooks unattended. No LLM decides control flow — models
only do the work inside a step.

## Install

```sh
npm i -g @thaodangspace/argos     # provides `argos`
npx @thaodangspace/argos --help   # without installing
```

Requires Node `>=22.13` (Argos uses the built-in `node:sqlite`), `git`, and — for Paseo runs — a
running Paseo daemon with at least one provider ready. `executor: hc` runs instead need a running
herdr-core core (`hc`), which `argos serve` probes at startup.

## Use

```sh
argos serve                  # 127.0.0.1:7676, the only process that opens $ARGOS_HOME/argos.sqlite
argos serve --default-executor hc   # or ARGOS_EXECUTOR=hc; prints `[argos] executors: paseo, hc (default)`
argos doctor                 # storage, schema, port, Paseo, providers, executors, pending gates
argos validate               # check the playbooks in the current checkout
argos run fix --input issue="login returns 500"
argos run fix --executor hc  # one run on herdr-core (a playbook may also pin `executor:`)
argos ls                     # newest first; `[executor hc]` marks a non-default run
argos status <runId>
argos gates                  # pending gates
argos decide <runId> <gateId> approve --comment "ship it"
argos schedule ls            # cron schedules that fire playbooks unattended
argos schedule add nightly --cron "0 3 * * *" --executor hc
```

`argos serve` must be running: the CLI is an HTTP client of that process and never opens SQLite
itself. Every command supports `--json`.

## Related packages

- `@thaodangspace/argos-core` — loader, IR, pure engine, durable host, RPC server, Paseo and
  herdr-core adapters.
- `argos-paseo-plugin` — the Paseo panel and chat tools (installed from a checkout with
  `paseo plugin install`, not from npm).

## License

MIT
