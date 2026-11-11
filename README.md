# Argos

Durable YAML playbook engine for [Paseo](https://github.com/getpaseo) agents.

A repository declares its workflow as YAML (`.argos/playbooks/*.yaml`); a
deterministic engine executes it against agents launched through Paseo, with
parallel steps, human gates, loops, and crash-safe resumption. No LLM decides
control flow — models only do the work inside a step.

Spec: `brain/spec/2026/Nov/11/03_spec_argos_yaml_playbook_engine.md`.

> Status: Phase 1 (scaffold). The engine, CLI, and Paseo plugin are not usable yet.

## Layout

| Workspace | Package | Contents |
|---|---|---|
| `packages/core` | `argos-core` | loader, engine, durable host, RPC server, Paseo adapter |
| `packages/cli` | `argos-cli` | `argos` CLI (HTTP client of `argos serve`) |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel and chat tools (HTTP client) |

## Development

Requires Node `>=22.5` (built-in `node:sqlite`).

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`argos serve` is the single writer of `$ARGOS_HOME/argos.sqlite`
(`ARGOS_HOME` defaults to `~/.argos`, mode `0700`, file `0600`).

## License

MIT — see `LICENSE`.
