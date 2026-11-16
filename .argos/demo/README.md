# `demo-hc` — a 3-step playbook on herdr-core

`.argos/playbooks/demo-hc.yaml` pins `executor: hc` and runs:

1. `hello_one` — agent step, target `hc/opencode`
2. `hello_two` — agent step, target `hc/opencode` (after `hello_one`)
3. `announce` — script step (`.argos/scripts/hello.sh`), after `hello_two`

## What herdr-core needs

herdr-core runs *terminals*, and Argos targets a herdr-core **template** by name
(`agent: { provider: hc, model: opencode }` → target `hc/opencode`). Install the
template this demo uses:

```sh
mkdir -p ~/.config/herdr-core/templates
cp .argos/demo/herdr-core/opencode.md ~/.config/herdr-core/templates/opencode.md
hc templates          # should list: opencode
```

The template is a wrapper around `opencode run` that reports herdr-core's own
OSC 7501 status (`state=idle` → `state=working` → `state=done`), because
opencode does not report status itself. Without that report a herdr-core
terminal never looks finished, and the step would run to its timeout.

It also isolates opencode from the machine's global opencode setup (a separate
config dir and session database), so the demo does not depend on — or change —
your default opencode configuration:

```sh
mkdir -p ~/.config/hc-demo/opencode
printf '{"$schema": "https://opencode.ai/config.json"}\n' \
  > ~/.config/hc-demo/opencode/opencode.json
```

Change the model in the template (`-m opencode-go/glm-5.3-flash`) to one your
opencode can use: `XDG_CONFIG_HOME=~/.config/hc-demo opencode models`.

## Run it

```sh
argos serve                       # registers paseo and, when it answers, hc
argos doctor                      # executors: paseo (default, reachable), hc (reachable, v…)

argos run demo-hc --cwd "$PWD"
argos status <runId>
```

The script step's stdout/stderr are the step's outputs; the agent steps settle
from the terminal's exit code (their transcript stays in the terminal, never in
the database).
