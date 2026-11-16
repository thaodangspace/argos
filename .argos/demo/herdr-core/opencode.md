---
name: opencode
description: OpenCode one-shot agent with OSC 7501 status reporting
command: sh -c 'printf "\033]7501;state=idle\007"; IFS= read -r task; printf "\033]7501;state=working\007"; OPENCODE_DB="$HOME/.local/state/herdr-demo/opencode.db" XDG_CONFIG_HOME="$HOME/.config/hc-demo" opencode run -m opencode-go/glm-5.3-flash "$task"; code=$?; printf "\033]7501;state=done\007"; exit $code'
---
