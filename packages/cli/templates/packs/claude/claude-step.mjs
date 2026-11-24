#!/usr/bin/env node
/**
 * One argos agent step on herdr-core (`executor: hc`): a single headless Claude Code run.
 *
 * hc starts this program as a template command in a fresh terminal (the run's cwd) and, once the
 * program reports `idle` through OSC 7501, types the step prompt in as the template's first
 * message. Then:
 *
 * 1. Read the prompt. `--prompt-file` is the non-tty entry point (tests, `hc exec`, rehearsal);
 *    on a real terminal the read is raw + bracketed-paste, with a quiet-gap fallback for an hc
 *    that types the text raw. Nothing is echoed, so the prompt never lands on the screen argos
 *    reads later.
 * 2. Run `claude -p` with the model / effort / permission mode given on the command line, printing
 *    one short line per tool call and per assistant text block, so `hc attach --observe <terminal>`
 *    shows progress.
 * 3. Quota: argos's `providers.on_exhausted` only works on Paseo, and on hc a failed step is
 *    retried after 1s/2s/4s, which would end a long loop. So a Claude usage limit is waited out
 *    here (until the reset time when Claude gives one, else every --quota-retry, at most
 *    --quota-max-wait), then the prompt runs again in a new session. The terminal stays `working`
 *    while it waits.
 * 4. Clear the screen and scrollback and print only Claude's final message: argos reads the step's
 *    declared outputs from that screen (one fenced ```json block). Report done, exit 0. Any
 *    failure exits non-zero (argos: step_failed, then the step's own `retries`).
 *
 * argos records no usage for hc steps, so each run appends one line to
 * $XDG_STATE_HOME/argos-hc/claude-step.log (else ~/.local/state/argos-hc/claude-step.log): time,
 * cwd, hc terminal, session, cost, how it ended.
 *
 * Standalone by contract (FR5): imports only `node:*`, reads no ARGOS_* name, and resolves the
 * user's PATH itself because hc starts it from its own minimal environment. Node >= 22.13.
 */

import { execFile, spawn } from "node:child_process";
import { appendFileSync, accessSync, constants, mkdirSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** ECMA-48 OSC: `ESC ] 7501 ; state=<word> ST`. hc parses the root record and reports the word. */
const OSC_END = "\u001b\\";
const PASTE_START = Buffer.from("\u001b[200~");
const PASTE_END = Buffer.from("\u001b[201~");
/** Without bracketed paste (an hc that types the text raw), the prompt ends after this much quiet. */
const QUIET_MS = 2_000;
const CLEAR = "\u001b[3J\u001b[H\u001b[2J";
const KILL_GRACE_MS = 10_000;
const PATH_PROBE_TIMEOUT_MS = 5_000;
const QUOTA_TEXT =
  /usage limit|hit your limit|limit reached|rate.?limit|out of (extra )?usage|resets? at|resets \d/i;
const KNOWN_OPTIONS = new Set([
  "model",
  "effort",
  "permission-mode",
  "work-timeout",
  "quota-retry",
  "quota-max-wait",
  "claude",
  "prompt-file",
  "log",
]);

let currentChild = null;
let terminating = false;

// ------------------------------------------------------------------ screen

function write(text) {
  writeSync(1, text);
}

function writeStderr(text) {
  try {
    writeSync(2, `${text}\n`);
  } catch {
    // A closed stderr must never abort the run.
  }
}

function reportState(state) {
  write(`\u001b]7501;state=${state}${OSC_END}`);
}

function say(line) {
  write(`${line}\n`);
}

function oneLine(text, width = 180) {
  // Fences are rewritten so a progress line can never look like the final result to argos.
  const cleaned = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replaceAll("```", "'''")
    .trim();
  return cleaned.length <= width ? cleaned : `${cleaned.slice(0, width - 1)}…`;
}

// ------------------------------------------------------------------ arguments

class UsageError extends Error {}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(item)}`);
    let name = item.slice(2);
    let value;
    const equals = name.indexOf("=");
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    } else {
      value = argv[index + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      index += 1;
    }
    if (!KNOWN_OPTIONS.has(name)) throw new UsageError(`unknown option --${name}`);
    values.set(name, value);
  }
  return values;
}

/** Durations are `<n>[s|m|h]`, exactly as the Python program accepted them. */
function duration(text, name) {
  const match = /^(\d+)([smh])?$/.exec(String(text).trim());
  if (!match) throw new UsageError(`${name}: expected <n>[s|m|h], got ${JSON.stringify(text)}`);
  const unit = match[2] ?? "s";
  const scale = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return Number(match[1]) * scale;
}

function parseOptions(argv) {
  const values = parseArgs(argv);
  const model = values.get("model");
  if (!model) throw new UsageError("--model is required");
  return {
    model,
    effort: values.get("effort"),
    permissionMode: values.get("permission-mode") ?? "auto",
    workTimeoutMs: duration(values.get("work-timeout") ?? "60m", "--work-timeout"),
    quotaRetryMs: duration(values.get("quota-retry") ?? "30m", "--quota-retry"),
    quotaMaxWaitMs: duration(values.get("quota-max-wait") ?? "8h", "--quota-max-wait"),
    claude: values.get("claude"),
    promptFile: values.get("prompt-file"),
    log: values.get("log"),
  };
}

// ------------------------------------------------------------------ prompt

function normalizePrompt(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return normalizePrompt(Buffer.concat(chunks));
}

/**
 * Raw-mode read for the real hc terminal: no echo (the prompt must never reach the screen argos
 * parses later), bracketed paste when hc sends one, and a quiet-gap fallback when hc types raw.
 */
function readTerminal() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let quiet = null;
    const finish = (text) => {
      if (quiet !== null) clearTimeout(quiet);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      write("\u001b[?2004l");
      resolve(normalizePrompt(Buffer.from(text)));
    };
    const onEnd = () => finish(buffer);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const start = buffer.indexOf(PASTE_START);
      if (start !== -1) {
        // A paste has begun, so only its end marker finishes the read: a quiet gap armed before the
        // marker arrived must never fire on the raw buffer, or the prompt is truncated at the gap
        // and keeps the `ESC[200~` framing bytes.
        if (quiet !== null) {
          clearTimeout(quiet);
          quiet = null;
        }
        const end = buffer.indexOf(PASTE_END, start + PASTE_START.length);
        if (end !== -1) {
          finish(buffer.subarray(start + PASTE_START.length, end));
          return;
        }
      } else {
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(() => finish(buffer), QUIET_MS);
      }
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

/**
 * Report `idle` **before** the first read: hc delivers a template's first message only after the
 * program says it is ready, so the idle report is what makes the prompt arrive at all. Bracketed
 * paste is enabled first so that message is framed for {@link readTerminal}.
 */
async function readPrompt(promptFile) {
  if (promptFile !== undefined) {
    reportState("idle");
    if (promptFile === "-") return readStdin();
    return normalizePrompt(readFileSync(promptFile, "utf8"));
  }
  if (process.stdin.isTTY) {
    write("\u001b[?2004h");
    reportState("idle");
    return readTerminal();
  }
  reportState("idle");
  return readStdin();
}

// ------------------------------------------------------------------ environment

/**
 * The core runs under launchd (PATH=/usr/bin:/bin:…), and argos passes no env: take the PATH of
 * the user's interactive login shell so claude, its Bash tool and the step scripts find node, gh,
 * … as in a normal terminal. The probe runs detached so an rc file cannot draw on this screen.
 */
function userPath(inheritedPath) {
  const shell = process.env["SHELL"] || "/bin/sh";
  return new Promise((resolve) => {
    const fallback = () => resolve(inheritedPath);
    try {
      execFile(
        shell,
        ["-lic", 'printf __ARGOS_PATH__=%s "$PATH"'],
        {
          detached: true,
          timeout: PATH_PROBE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
          maxBuffer: 1 << 20,
        },
        (error, stdout) => {
          if (error) {
            fallback();
            return;
          }
          const match = /__ARGOS_PATH__=([^\n]*)\s*$/.exec(String(stdout).trimEnd());
          const probed = (match?.[1] ?? "").trim();
          if (!probed) {
            fallback();
            return;
          }
          const parts = [];
          for (const entry of [...probed.split(delimiter), ...inheritedPath.split(delimiter)]) {
            if (entry && !parts.includes(entry)) parts.push(entry);
          }
          resolve(parts.join(delimiter));
        },
      );
    } catch {
      fallback();
    }
  });
}

function findClaude(explicit, path) {
  if (explicit) return explicit;
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; keep looking
    }
  }
  return join(homedir(), ".local", "bin", "claude");
}

// ------------------------------------------------------------------ one claude run

function killGroup(child, signal) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone: nothing to kill.
    }
  }
}

function toolDetail(input) {
  const args = input ?? {};
  return (
    args["command"] ??
    args["file_path"] ??
    args["pattern"] ??
    args["description"] ??
    args["url"] ??
    ""
  );
}

function handleEvent(run, line) {
  const text = line.trim();
  if (!text) return;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    say(oneLine(text));
    return;
  }
  if (event === null || typeof event !== "object") {
    say(oneLine(text));
    return;
  }
  switch (event["type"]) {
    case "system":
      if (event["subtype"] === "init") {
        run.session = event["session_id"] ?? run.session;
        say(
          `claude ${event["claude_code_version"] ?? "?"} · ${event["model"] ?? "?"} · session ${run.session}`,
        );
      }
      return;
    case "assistant": {
      if (event["error"] === "rate_limit") run.quota = true;
      const content = event["message"]?.["content"];
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.["type"] === "tool_use") {
          say(`  → ${oneLine(`${block["name"] ?? "?"} ${toolDetail(block["input"])}`)}`);
        } else if (block?.["type"] === "text" && String(block["text"] ?? "").trim()) {
          say(`  · ${oneLine(block["text"])}`);
        }
      }
      return;
    }
    case "rate_limit_event": {
      const info = event["rate_limit_info"] ?? {};
      if (info["status"] === "rejected") {
        run.quota = true;
        const resets = info["resetsAt"];
        if (typeof resets === "number" && Number.isFinite(resets)) {
          run.resetsAt = resets > 1e12 ? resets : resets * 1_000;
        }
      }
      return;
    }
    case "result":
      run.result = event;
      run.session = event["session_id"] ?? run.session;
      return;
    default:
      say(oneLine(text));
  }
}

function runClaude({ command, args, prompt, env, workTimeoutMs }) {
  return new Promise((resolve) => {
    const run = {
      session: null,
      result: null,
      quota: false,
      resetsAt: null,
      timedOut: false,
      exitCode: null,
      failed: true,
      spawnError: null,
    };
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: ["pipe", "pipe", "inherit"],
        env,
      });
    } catch (error) {
      run.spawnError = error;
      resolve(run);
      return;
    }
    currentChild = child;
    let settled = false;
    let buffer = "";
    let killTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (killTimer !== null) clearTimeout(killTimer);
      currentChild = null;
      if (buffer) handleEvent(run, buffer);
      resolve(run);
    };
    const watchdog = setTimeout(() => {
      run.timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, workTimeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        handleEvent(run, buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      run.spawnError = error;
      finish();
    });
    child.on("close", (code) => {
      run.exitCode = code;
      finish();
    });
    child.stdin?.on("error", () => {
      // claude exited before reading its prompt; the exit code is the signal.
    });
    child.stdin?.end(prompt);
  });
}

/** Classify one run exactly as the Python program did. */
function classify(run) {
  const result = run.result ?? {};
  const failed =
    run.result === null ||
    Boolean(result["is_error"]) ||
    result["subtype"] !== "success";
  if (
    failed &&
    (result["api_error_status"] === 429 || QUOTA_TEXT.test(String(result["result"] ?? "")))
  ) {
    run.quota = true;
  }
  // A limit seen mid-run that Claude got past is not a quota failure.
  run.quota = run.quota && failed;
  run.failed = failed;
  return run;
}

// ------------------------------------------------------------------ log

function localTimestamp(epoch) {
  const date = new Date(epoch);
  const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}${minutes}`
  );
}

function logPath(explicit) {
  if (explicit) return explicit;
  const stateHome = process.env["XDG_STATE_HOME"];
  const base = stateHome ? stateHome : join(homedir(), ".local", "state");
  return join(base, "argos-hc", "claude-step.log");
}

/** One JSON line per outcome. Never the prompt, never a path outside the run cwd; never fatal. */
function log({ startedAt, cwd, run, status, explicitPath }) {
  const result = run?.result ?? {};
  const entry = {
    at: localTimestamp(startedAt),
    cwd,
    terminal: process.env["HC_TERMINAL_ID"] ?? null,
    session: run?.session ?? null,
    status,
    cost_usd: result["total_cost_usd"] ?? null,
    turns: result["num_turns"] ?? null,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  };
  try {
    const file = logPath(explicitPath);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is diagnostic: a read-only home must never fail a step.
  }
}

// ------------------------------------------------------------------ signals

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminate(code) {
  if (terminating) return;
  terminating = true;
  const child = currentChild;
  if (child) {
    killGroup(child, "SIGTERM");
    if (!(await waitForExit(child, 5_000))) {
      killGroup(child, "SIGKILL");
      await waitForExit(child, 5_000);
    }
  }
  reportState("done");
  process.exit(code);
}

function installSignalHandlers() {
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ]) {
    process.on(signal, () => {
      void terminate(code);
    });
  }
}

function exit(code) {
  if (!terminating) process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ main

function usage(error) {
  writeStderr(`claude-step: ${error instanceof Error ? error.message : String(error)}`);
  return 2;
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    return usage(error);
  }
  installSignalHandlers();

  let prompt;
  try {
    prompt = await readPrompt(options.promptFile);
  } catch (error) {
    return usage(error);
  }
  reportState("working");

  const startedAt = Date.now();
  const cwd = process.cwd();
  if (!prompt) {
    writeStderr("claude-step: no prompt arrived");
    log({ startedAt, cwd, run: null, status: "no_prompt", explicitPath: options.log });
    reportState("done");
    return 2;
  }

  const env = { ...process.env, PATH: await userPath(process.env["PATH"] ?? "/usr/bin:/bin") };
  if (!env["LANG"]) env["LANG"] = "en_US.UTF-8";
  const command = findClaude(options.claude, env["PATH"]);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--permission-mode",
    options.permissionMode,
  ];
  if (options.effort) args.push("--effort", options.effort);

  let giveUpAt = null;
  for (;;) {
    const run = classify(
      await runClaude({
        command,
        args,
        prompt,
        env,
        workTimeoutMs: options.workTimeoutMs,
      }),
    );
    const result = run.result ?? {};

    if (run.timedOut) {
      writeStderr(
        `claude-step: the claude run passed --work-timeout (${options.workTimeoutMs}ms) and was stopped`,
      );
      log({ startedAt, cwd, run, status: "timeout", explicitPath: options.log });
      reportState("done");
      return 124;
    }

    if (run.quota) {
      const now = Date.now();
      if (giveUpAt === null) giveUpAt = now + options.quotaMaxWaitMs;
      if (now >= giveUpAt) {
        writeStderr(
          `claude-step: Claude quota still exhausted after ${options.quotaMaxWaitMs}ms, giving up`,
        );
        log({ startedAt, cwd, run, status: "quota_exhausted", explicitPath: options.log });
        reportState("done");
        return 75;
      }
      // Nothing is written to the screen while waiting: the terminal stays `working` and argos
      // keeps polling. One sleep, no polling loop.
      const wake =
        run.resetsAt !== null && run.resetsAt > now
          ? Math.min(run.resetsAt + 60_000, giveUpAt)
          : Math.min(now + options.quotaRetryMs, giveUpAt);
      log({ startedAt, cwd, run, status: "quota_wait", explicitPath: options.log });
      await sleep(Math.max(0, wake - Date.now()));
      continue;
    }

    if (run.failed) {
      const detail = run.spawnError
        ? `could not run ${command}: ${run.spawnError.message}`
        : `claude failed (exit ${run.exitCode}, ${result["subtype"] ?? "no result"}): ${oneLine(result["result"] ?? "", 400)}`;
      writeStderr(`claude-step: ${detail}`);
      log({ startedAt, cwd, run, status: "error", explicitPath: options.log });
      reportState("done");
      // A run that reported no result is a failure even when claude exited 0 (parity with the
      // Python program's `exit_code or 1`): a zero exit must never read as a settled step.
      return run.exitCode === null || run.exitCode === 0 ? 1 : run.exitCode;
    }

    // Only the final message stays on the screen: that is what argos parses.
    write(CLEAR);
    write(`${String(result["result"] ?? "").trimEnd()}\n`);
    log({ startedAt, cwd, run, status: "success", explicitPath: options.log });
    reportState("done");
    return 0;
  }
}

main().then(exit, (error) => {
  writeStderr(`claude-step: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
