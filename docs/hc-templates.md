# hc templates and template packs

An `hc` step runs a **template**: a Markdown file in herdr-core's templates directory whose
`command:` is the program hc starts in a new terminal. Templates are machine-level assets — hc
reads one directory per machine and knows nothing about repositories — but before packs they were
hand-maintained: a project vendored `claude-step.py`, symlinked `~/.config/herdr-core/templates/*.md`
at it, and any `git clean`/`git checkout` in that checkout silently broke every `hc` step on the
machine.

Argos now ships **packs**: data (`pack.json`) plus a standalone program, installed once per machine
with `argos hc templates`. The program is copied out of the CLI tarball, so nothing on the machine
points into a checkout. `argos hc templates verify` and `argos doctor` then answer "is what I
installed still what is running?".

`hc` is the substrate `argos serve` starts runs on whenever a core answered its startup probe, so a
fresh install makes these templates the default way a playbook's steps run; `executor: paseo` (or
`--default-executor paseo`) keeps a repository on Paseo.

## The three things

| Path | Owner | Contents |
|---|---|---|
| `~/.config/herdr-core/templates/<template>.md` | **hc** reads it | one generated file per template: `name`, `description` (carrying our marker), `command`, empty body |
| `$ARGOS_HOME/hc/packs/<pack>@<version>/` | Argos | the pack's program (`0700`), one directory per installed version |
| `$ARGOS_HOME/hc/packs.json` | Argos | the manifest: what this machine installed, and a **claim** `verify` checks against disk |

The templates directory resolves in exactly one place — `--dir` → `$XDG_CONFIG_HOME/herdr-core/
templates` → `~/.config/herdr-core/templates` — and is created `0700` on install. hc's own help
names the literal `~/.config/herdr-core/templates`, so an `XDG_CONFIG_HOME` mismatch is the most
likely "it installed but hc does not see it"; every command that writes prints the resolved path,
and `--dir` is the escape hatch.

## The pack format

`pack.json` sits at the root of a pack directory and is validated strictly (an unknown key or a
wrong type is a refusal naming the file and the field — an operator writes packs, so a typo must
not be a silent no-op):

```json
{
  "name": "claude",
  "version": 1,
  "description": "Headless Claude Code (claude -p) as one argos hc step",
  "requires": { "node": ">=22.13", "hcProtocol": 1 },
  "program": { "file": "claude-step.mjs" },
  "templates": [
    {
      "name": "claude-opus-high",
      "args": "--model claude-opus-5-5 --effort high --permission-mode auto --work-timeout 150m --quota-retry 30m --quota-max-wait 4h",
      "minStepTimeoutMs": 19800000,
      "description": "Headless Claude Code (Opus 5.5, effort high, auto mode) for one argos step"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | pack id, `^[a-z0-9][a-z0-9-]{0,31}$` |
| `version` | integer ≥ 1; a bump installs into a **new** `packs/<name>@<version>/` directory |
| `requires.node` | a `>=x.y` floor compared with the running Node; older is `node_too_old` |
| `requires.hcProtocol` | must be `1`; anything else is `unsupported_protocol` (Argos speaks generation 1) |
| `requires.hc` / `requires.claude` | version floors that are only ever **warnings** (nothing is probed offline) |
| `program.file` | the program's **bare file name beside `pack.json`** (no `/`, no `..`); it is copied to `packs/<name>@<version>/<file>` and must be standalone — `node:*` only, no repo or `node_modules` import, no `ARGOS_*` name |
| `program.args` | optional arguments placed before every template's own `args` |
| `templates[].args` | the template's command-line arguments, verbatim |
| `templates[].minStepTimeoutMs` | the step budget the pack declares for this template (data for authors and `list`/`doctor`; Argos never enforces it) |

`argos hc templates install` then writes one `.md` per template:

```md
---
name: claude-opus-high
description: "Headless Claude Code (Opus 5.5, effort high, auto mode) for one argos step · argos-pack claude 1"
command: "/opt/homebrew/bin/node" "/Users/dt/.argos/hc/packs/claude@1/claude-step.mjs" --model claude-opus-5-5 --effort high --permission-mode auto --work-timeout 150m --quota-retry 30m --quota-max-wait 4h
---
```

- The command is `<absolute node> <absolute program> <program.args> <template.args>`, single-quoted
  on POSIX and double-quoted on Windows. `process.execPath` is used, never a bare `node`: hc starts
  the program from its own minimal `PATH`.
- The marker `· argos-pack <name> <version>` in `description` is the **only** ownership signal
  (hc echoes name/description/command from `templates.list`). `uninstall` deletes a file only when
  it carries the marker for the pack being removed, so a hand-written template can never be
  removed by Argos.
- The body stays empty: hc sends a template's body *with* the prompt, and the step prompt is the
  whole task.

## Commands

```sh
argos hc templates list [--dir <path>] [--json]
argos hc templates install [pack ...] [--from <dir>] [--link] [--force] [--dry-run]
                           [--dir <path>] [--json]
argos hc templates uninstall <pack ...> [--prune] [--dry-run] [--dir <path>] [--json]
argos hc templates verify [--require-server] [--dir <path>] [--json]
```

Every command is offline: `node:fs` plus one HTTP question to `argos serve` (`verify`). Nothing
imports the hc socket client, opens SQLite, or runs an `hc` process.

| Command | `--json` | Notes |
|---|---|---|
| `list` | `{ dir, packs: [{ name, version, program, programSha256?, link?, templates: [{ name, file, command, minStepTimeoutMs, present }] }] }` | reads the manifest; `command` is `null` when the `.md` is missing |
| `install` | the `list` shape plus `{ manifest, dryRun, unchanged, writes: string[], links: [{path,target}], warnings: string[] }` | a bare `install` installs every bundled pack (`claude`, `smoke`); `--from <dir>` installs a pack directory you wrote |
| `uninstall` | `{ dir, packs, manifest, dryRun, unchanged, removed: string[], kept: [{path,reason}] }` | removes only marker-carrying `.md` files of the named packs and their manifest entry |
| `verify` | `{ dir, server: { reachable, templates: string[] \| null }, packs: [{ name, version, templates: [{ name, file, present, executable, hashMatches, inServer: boolean \| null, status: "ok"\|"warn"\|"error", messages: string[] }] }], ok, warnings, errors }` | `server.templates` is `null` for "cannot tell", never "empty" |

- `--dry-run` prints the plan the real run would apply (the planner is pure, so the two cannot
  disagree) and writes nothing, ever.
- `--force` overwrites an `.md` of that name that is foreign or belongs to another pack; without it
  a name collision is `template_conflict` naming the path.
- `--link` symlinks the program from `--from <dir>` instead of copying it: `argos hc templates
  install --from ./packs --link` makes the installed template run `<checkout>/packs/claude/
  claude-step.mjs` directly, so editing the program takes effect for the next terminal without a
  reinstall. The manifest then records the link `target` instead of `programSha256`; `verify`
  follows it and reports a dangling link as `link target missing: <link>`. Not supported on
  Windows (symlink privilege): `link_unsupported`.
- `--prune` lives on **`uninstall`**, and it is scoped to the packs you name: it removes the
  unreferenced `<name>@<version>/` program directories of those packs. `install` never prunes —
  an old program directory stays until you remove it explicitly, because a live or parked
  terminal may still be running it. So a version bump is cleaned up with
  `argos hc templates uninstall <pack> --prune` and then `argos hc templates install <pack>`.
- An install ends with the two next steps: run `hc templates` to confirm hc sees the files, and
  restart `argos serve` if it was already running — the server reads its template roster once, at
  startup.

## The `claude` pack

`claude-step.mjs` is one headless `claude -p` run per step. Its knobs:

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | **required** | the model id passed straight to `claude -p` |
| `--effort <level>` | none | `--effort` for `claude`; omitted when absent |
| `--permission-mode <mode>` | `auto` | `--permission-mode` for `claude` |
| `--work-timeout <dur>` | `60m` | bound on one `claude` invocation; on expiry the process group gets `SIGTERM`, then `SIGKILL` after 10 s, and the program exits `124` |
| `--quota-retry <dur>` | `30m` | how long to wait before retrying when Claude reports a limit with no reset time |
| `--quota-max-wait <dur>` | `8h` | total time the program may spend waiting for quota before it exits `75` |
| `--claude <path>` | resolved on `PATH` | the `claude` executable (tests and rehearsals) |
| `--prompt-file <path>` | — | read the prompt from a file (`-` = stdin) instead of the terminal; the non-tty entry point |
| `--log <path>` | see below | where the one JSONL outcome line is appended |

Durations are `<n>[s|m|h]`. With no flags at all the program reads the prompt from its terminal
(raw mode, bracketed paste, 2 s quiet fallback), which is how hc delivers a template's first
message.

What it does, in order: report `idle` **before** reading (hc only delivers the first message to a
program that says it is ready), read the prompt without echoing it, report `working`, resolve
`claude` on the **user's login-shell `PATH`** (hc starts the program under a minimal `PATH`; the
probe runs detached so an rc file cannot draw on the screen), run `claude -p --output-format
stream-json --verbose …` in its own process group with the prompt on stdin, wait out a usage limit
with the terminal still `working`, then — on success — clear the screen and scrollback and print
**only** Claude's final message. Exit codes: `0` success, `2` usage/no prompt, `75` quota budget
spent, `124` work timeout, `N` Claude's own non-zero exit (`1` when it produced no result), and
`143`/`129`/`130` for `SIGTERM`/`SIGHUP`/`SIGINT` (the process group is killed first).

Every run appends one JSON line to `$XDG_STATE_HOME/argos-hc/claude-step.log` (else
`~/.local/state/argos-hc/claude-step.log`) with `at`, `cwd`, `terminal` (hc's terminal id),
`session`, `status`, `cost_usd`, `turns`, `seconds`. It never contains the prompt: Argos records no
`usage`/cost for hc steps, so this log is where cost and session id survive. The log is diagnostic
— a read-only home never fails a step.

### Templates and step budgets

| template | model / effort | work timeout | quota budget | minStepTimeoutMs |
|---|---|---|---|---|
| `claude-opus-high` | `claude-opus-5-5` · `high` | 150m | 4h | 19800000 |
| `claude-opus-xhigh` | `claude-opus-5-5` · `xhigh` | 60m | 8h | 33300000 |
| `claude-sonnet-medium` | `claude-sonnet-5-5` · `medium` | 150m | 4h | 19800000 |
| `claude-fable-high` | `claude-fable-5-2` · `high` | 180m | 4h | 26100000 |
| `smoke` | — (no model) | — | — | 300000 |

All four `claude` templates pass `--permission-mode auto` and `--quota-retry 30m`.

**A step's `timeout` must exceed its work + quota wait.** The default step timeout is 30 minutes,
so a `claude` step without a `timeout:` fails `step_timeout` long before the agent is done. The
program may spend one work timeout in `claude`, then wait out a usage limit for up to the quota
budget, then run `claude` again; the step deadline is the only thing that can stop it. Write the
worst case into the step, with room to spare — for `claude-opus-high` that is 150m of work plus 4h
of quota wait (390m), so:

```yaml
- id: implement
  agent: { provider: hc, model: claude-opus-high }
  timeout: 7h            # > 150m work + 4h quota wait
  prompt: "…"
```

`minStepTimeoutMs` (shown by `argos hc templates list` and named by `argos doctor`) is the pack's
declared floor for the template, not a bound: the two Opus/Sonnet profiles inherit their number
from the templates that were in use before the pack existed, and 19800000 ms (5h30m) is less than
their 150m + 4h worst case. Treat it as the smallest acceptable value and use the rule above.
A duration is a single `<n><unit>` (`150m`, `7h`) or a plain number of milliseconds
(`19800000`): `timeout: 5h30m` is *not* a duration Argos understands, and an unparsable value
quietly falls back to the 30-minute default.

`smoke` is the zero-cost pack: `smoke.mjs` reports `idle`, reads the prompt, reports `working`,
prints one fenced `{"ok":true,"promptLength":<n>}` block, reports `done`, exits `0`. It spends no
token and proves the whole chain — terminal, labels, prompt delivery, screen read, output parse,
settle — so install it on any machine before blaming the model.

### What a program must do (the contract)

1. **Report `idle` before reading.** hc delivers a template's first message only after the program
   says it is ready, so a program that reads first waits forever.
2. **Report `working`, then `done`.** These are OSC 7501 records on stdout, and they are the only
   completion signal hc has.
3. **End with exactly one fenced JSON block on the screen.** Argos reads a step's declared
   `outputs` from the terminal text and parses one fenced ```` ```json ```` block (or one bare JSON
   object) — two fences are ambiguous and fail `invalid_output`. Clear the screen before printing
   the result if the program also prints progress, the way `claude-step.mjs` does.
4. **Exit with a status.** `0` settled; non-zero is `step_failed` (then the step's own `retries`).
5. **Resolve its own `PATH`.** Argos passes no `env` block, so the program inherits hc's
   environment.

**A TUI never settles.** hc learns that work finished from the program's own status report, so a
template that starts an interactive program (`claude` with no `-p`, an editor, a shell) never looks
done: the step runs to its deadline and fails `step_timeout`. That is the documented behaviour, not
a bug to work around — use a headless program, or a small wrapper that reports status like this
pack does, and keep the TUI for `hc attach`.

## `verify`'s three answers

`argos hc templates verify` answers three independent questions, per template:

| Question | How | `ok` | `warn` | `error` |
|---|---|---|---|---|
| manifest vs **disk** | the `.md` is present, the program exists and is executable, and (for a copied pack) its sha256 still matches the manifest | all true | — | any false |
| manifest vs the **running server** | `GET /info` → `executors[].templates` contains the template | in the roster | installed but absent (restart `argos serve`), or the roster is unknown | — |
| server **reachability** | `GET /health` | answered | not reachable (unless `--require-server`) | — |

The messages it prints are the whole diagnostic vocabulary:

- `template file missing: <path>` — the `.md` was deleted or moved; `install` repairs it.
- `program missing: <path>` / `program is not executable: <path>` — the copy under
  `$ARGOS_HOME/hc/packs/` is gone or lost its mode; `install` repairs it.
- `link target missing: <link>` — a `--link` pack whose source disappeared (a live terminal is
  unaffected; `install` restores it).
- ``program sha256 differs from the manifest; run `argos hc templates install` `` — the installed
  program was edited or replaced.
- ``installed but not in the running server's catalog; restart `argos serve` `` — the files are
  right; the **server** predates the install (it reads the roster once, at startup).
- `the running server does not publish its hc templates; cannot tell whether it has seen them
  (restart `argos serve`)` — an older `argos serve` without the roster field.
- `the running server does not register the hc executor; cannot tell whether it has seen them
  (restart `argos serve` with a reachable herdr-core)` — the server could not reach hc.
- `argos serve is not reachable; cannot tell whether it has seen them` — no server to ask.

`--require-server` turns "no server" from a warn into exit `3`; without it `verify` is usable
before `argos serve` has ever run. A broken on-disk install exits `1`; warnings only — an
unreachable server included — exit `0` with `ok: true`. `argos doctor` carries the same information
as one `hc templates` check: `ok` `<n> templates in the running server's catalog`, `warn` (a detail
naming the missing templates, ``<pack> <installed> installed, <bundled> bundled; run `argos hc
templates install` ``, or the "cannot tell" variants), and a "not installed" detail when nothing is
installed. The check exists only when a server answered; `DoctorReport` itself is unchanged.

## The manifest

```json
{
  "version": 1,
  "packs": {
    "claude": {
      "version": 1,
      "source": "bundled",
      "program": "/Users/dt/.argos/hc/packs/claude@1/claude-step.mjs",
      "programSha256": "…",
      "templates": {
        "claude-opus-high": {
          "file": "/Users/dt/.config/herdr-core/templates/claude-opus-high.md",
          "minStepTimeoutMs": 19800000
        }
      }
    }
  }
}
```

`source` is `bundled`, the `--from` directory, or `link`; a linked pack carries `link` instead of
`programSha256`. The file has **no timestamps**, so two installs of the same pack are byte-identical
and a templates directory tracked in a repository shows an empty diff after a no-op reinstall.

Argos owns this file and hc never reads it, deliberately: hc owns its templates directory, and an
unknown file there is untested hc behaviour. The manifest is a *claim* about what Argos installed —
`verify` and `doctor` compare it with disk and with the live roster, and a hand-edited manifest is
refused (`manifest_invalid`) rather than merged blind.

A pack is **not pinned to a run** the way a script is: there is no sha256 in the run record, so a
pack upgrade affects only terminals created afterwards (a running terminal already exec'd its
program). `programSha256` is diagnostic; `verify` reports drift and never refuses a run.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | ok, wrote, nothing to do, or (`verify`) warnings only |
| `1` | usage error, or (`verify`) a broken on-disk install |
| `2` | a refusal: `template_conflict`, `pack_unknown`, `pack_missing`, `pack_invalid`, `manifest_invalid`, `node_too_old`, `invalid_floor`, `unsupported_protocol`, `link_unsupported`, `program_missing`, `pack_duplicate`; nothing is written |
| `3` | `verify --require-server` only: `argos serve` is unreachable |

`--json` keeps the same exit codes and prints `{ error: { code, message } }` for a refusal.

## Migration from a vendored `claude-step.py`

The old setup is a project checkout that holds `claude-step.py`, with
`~/.config/herdr-core/templates/*.md` symlinked into that checkout. **Do not delete anything there
yet**: the symlinks are machine-level state pointing into a working copy, which is exactly the
failure this feature removes, and they must keep working until the Node program has proven itself.
Do this in order, on the machine that runs the templates:

1. Install the bundled packs, with `--force` this one time: the old `.md` files are symlinks to
   files no Argos version wrote, so they carry no marker and the first install refuses them with
   `template_conflict` naming the path.

   ```sh
   argos hc templates install --force
   ```

   It copies `claude-step.mjs` and `smoke.mjs` to `$ARGOS_HOME/hc/packs/<pack>@1/` and writes the
   five `.md` files (four `claude` templates plus `smoke`) beside the old ones. Each `.md` is
   written to a temp file and renamed over the symlink, so the link itself is replaced by a regular
   file and the checkout it pointed at is left untouched — but from here on Argos owns those files.

2. Read back what Argos thinks it installed:

   ```sh
   argos hc templates list
   ```

3. Confirm **hc** sees the same files (this is hc reading its own directory, not Argos):

   ```sh
   hc templates
   ```

4. Check disk, live roster, and reachability together, then restart the server and check again:

   ```sh
   argos hc templates verify            # disk ok; a server that predates the install says "not in the
                                        # running server's catalog" (or "not reachable", if none runs)
   # restart `argos serve` (launchd/systemd/a shell — Argos never signals a process)
   argos hc templates verify            # all ok: the running server's catalog has them
   ```

5. Prove the chain for free with `smoke` before spending a token: run one step with
   `agent: { provider: hc, model: smoke }` and check it settles with
   `{"ok":true,"promptLength":<n>}`.

6. Run **each of the four `claude` templates once for real** (one step each, not a whole playbook),
   and on the first one watch the status move `idle` → `working` → `done` and the step settle —
   that is hc parsing this program's OSC 7501 terminator. The port ends every record with ST
   (`ESC \`) where the Python program used BEL; hc 0.1.22 parses both, but only a real run proves
   it on your core. If the terminal stays `idle` (no prompt arrives) or never leaves `working`, the
   one edit is the `OSC_END` constant in `claude-step.mjs` (`"\u001b\\"` → `"\u0007"`), in a
   `--link`ed copy or a `--from` pack.

7. Only then delete `claude-step.py` and the symlinks in the `vsee` checkout — and commit that
   deletion there, so no future checkout re-creates them.

`argos doctor` is the last check: its `hc templates` line should read
`<n> templates in the running server's catalog`.
