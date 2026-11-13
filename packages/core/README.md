# @thaodangspace/argos-core

Library core of [Argos](https://github.com/thaodangspace/argos) — the durable YAML playbook engine
for [Paseo](https://github.com/getpaseo) agents. Most users want the CLI instead:
`npm i -g @thaodangspace/argos`.

This package has no entry in the playbook control path that consults a model: readiness,
transitions, loop limits, gates, retries, and timeouts are decided by a pure reducer. A model only
does the work inside a step.

## Subpaths

Everything is opt-in — the package root exports the error codes, the path helpers, and the
`playbook`/`engine` barrels, but never `durable`/`paseo`/`git`/`rpc`. A consumer therefore cannot
accidentally pull the SQLite owner into the wrong process.

| Import | Contains |
|---|---|
| `@thaodangspace/argos-core` | error codes, `$ARGOS_HOME` paths, plus `playbook` and `engine` |
| `@thaodangspace/argos-core/playbook` | YAML loader, resolver, sub-playbook expansion, validation, hashing, frozen IR |
| `@thaodangspace/argos-core/engine` | the pure decision layer (`next(record, event)` → record + effects); no I/O, no timers |
| `@thaodangspace/argos-core/durable` | `ArgosHost`: the one SQLite owner, run lifecycle, schedules, worktrees, scripts |
| `@thaodangspace/argos-core/paseo` | Paseo adapter, target/quota policy, deterministic fake |
| `@thaodangspace/argos-core/git` | the only `node:child_process` user (worktrees, snapshots) |
| `@thaodangspace/argos-core/rpc` | HTTP contracts + client; safe for CLIs and plugins |
| `@thaodangspace/argos-core/rpc/contracts` | Node-free contracts only |
| `@thaodangspace/argos-core/rpc/server` | the RPC server that wraps the durable host (serve-only) |

## Example

```ts
import { loadPlaybook } from "@thaodangspace/argos-core/playbook";
import { createRunRecord, next } from "@thaodangspace/argos-core/engine";

const ir = loadPlaybook(process.cwd(), "fix"); // deep-frozen IR + content hash
let record = createRunRecord({
  id: "01J...",
  ir,
  inputs: { issue: "login returns 500" },
  cwd: process.cwd(),
  now: Date.now(),
});
const { record: advanced, effects } = next(record, { type: "tick", now: Date.now() });
// `effects` names what the host should do (dispatchStep, openGate, finishRun, ...); `next` performs nothing.
```

A run writes to `$ARGOS_HOME/argos.sqlite` only through `ArgosHost`, which refuses a second live
owner. In practice you run the host with `argos serve` (the CLI package) rather than embedding it.

Requires Node `>=22.13`. See the
[repository](https://github.com/thaodangspace/argos/blob/main/docs/architecture.md) for the
architecture, the durability model, and the scheduler.

## License

MIT
