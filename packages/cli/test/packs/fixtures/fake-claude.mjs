#!/usr/bin/env node
/**
 * Test-only stand-in for the `claude` CLI, so the pack tests never touch a real binary, a network,
 * or a token. It replays the `stream-json` events the agent program maps: `system/init`, one
 * `assistant` turn with a `tool_use` and a text block, and a `result` whose `result` is a fenced
 * ```json block.
 *
 * Mode comes from `--fake-mode` or `FAKE_CLAUDE_MODE` (the agent program spawns us with its own
 * argv, so the env var is how a mode reaches us through `claude-step.mjs`); the attempt counter
 * file comes from `--fake-state` or `FAKE_CLAUDE_STATE` and doubles as a pid ledger, so a test can
 * prove a killed process group is really gone.
 *
 * Modes: ok (default), fail, quota-once, hang, exit3.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = "999.0.0-fake";
const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const mode = flag("fake-mode") ?? process.env["FAKE_CLAUDE_MODE"] ?? "ok";
const statePath = flag("fake-state") ?? process.env["FAKE_CLAUDE_STATE"];

const state = { attempts: 0, pids: [] };
if (statePath) {
  try {
    Object.assign(state, JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    // first invocation
  }
  state.attempts += 1;
  state.pids = [...state.pids, process.pid];
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  } catch {
    // the ledger is diagnostic only
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function run(prompt) {
  emit({
    type: "system",
    subtype: "init",
    claude_code_version: VERSION,
    model: flag("model") ?? "fake-model",
    session_id: "session-fake",
    permissionMode: flag("permission-mode") ?? "auto",
  });
  if (mode === "exit3") process.exit(3);
  if (mode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "quota-once" && state.attempts === 1) {
    emit({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Date.now() + 1_000, rateLimitType: "five_hour" },
    });
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your 5-hour limit · resets soon",
      session_id: "session-fake",
      num_turns: 1,
      total_cost_usd: 0,
    });
    process.exit(1);
  }
  if (mode === "fail") {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "giving up" }] } });
    emit({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "the run hit its turn limit",
      session_id: "session-fake",
      num_turns: 4,
      total_cost_usd: 0.02,
    });
    process.exit(1);
  }
  emit({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        { type: "text", text: "Reading the tree before the change" },
      ],
    },
    session_id: "session-fake",
  });
  const fence = ["```json", JSON.stringify({ status: "ok", promptLength: prompt.trim().length }), "```"].join(
    "\n",
  );
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `Done.\n\n${fence}\n`,
    session_id: "session-fake",
    num_turns: 2,
    total_cost_usd: 0.01,
    api_error_status: null,
  });
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => run(input));
