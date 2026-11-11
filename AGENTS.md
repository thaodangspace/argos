# AGENTS.md

Argos — durable YAML playbook engine for Paseo agents. Implementation plan:
`/Users/dt/code/brain/spec/2026/Nov/11/03_impl_argos_yaml_playbook_engine.md`.
Current state: **Phase 1 (scaffold)**.

## Layout

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `argos-core` | loader, engine, durable host, RPC server, Paseo adapter |
| `packages/cli` | `argos-cli` | `argos` CLI; HTTP client of `argos serve`, never opens SQLite |
| `packages/paseo-plugin` | `argos-paseo-plugin` | Paseo panel + chat tools; HTTP client, never opens SQLite |

No source files live outside `packages/*`. TypeScript ESM, `module`/`moduleResolution`
`NodeNext` (relative imports need `.js` extensions), Node `>=22.5`.

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
