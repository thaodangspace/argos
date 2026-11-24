#!/usr/bin/env node
/**
 * The `smoke` pack's program: prove the whole hc chain without a model and without a token.
 *
 * hc starts it in a fresh terminal, waits for `idle` (OSC 7501), types the step prompt in, and
 * later reads the screen for one fenced JSON block. So it does exactly what the real agent pack
 * does — idle before the read, working once the prompt is in, one fence, done — and nothing else.
 * Exit 2 when no prompt arrives or an argument is not understood (argos: step_failed).
 *
 * Standalone by contract (FR5): imports only `node:*`.
 */

import { readFileSync, writeSync } from "node:fs";

const PASTE_START = Buffer.from("\u001b[200~");
const PASTE_END = Buffer.from("\u001b[201~");
const QUIET_MS = 2_000;

const osc = (state) => writeSync(1, `\u001b]7501;state=${state}\u001b\\`);
const say = (text) => writeSync(1, text);

function terminalPrompt() {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let quiet = null;
    const finish = (part) => {
      if (quiet !== null) clearTimeout(quiet);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      say("\u001b[?2004l");
      resolve(Buffer.from(part).toString("utf8"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const start = buffer.indexOf(PASTE_START);
      if (start !== -1) {
        const end = buffer.indexOf(PASTE_END, start + PASTE_START.length);
        if (end !== -1) finish(buffer.subarray(start + PASTE_START.length, end));
      } else {
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(() => finish(buffer), QUIET_MS);
      }
    };
    stdin.on("data", onData);
  });
}

async function stdinPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Same reader as the agent pack: `idle` first, because that is what makes hc deliver the prompt. */
async function readPrompt(promptFile) {
  if (promptFile !== undefined) {
    osc("idle");
    return promptFile === "-" ? stdinPrompt() : readFileSync(promptFile, "utf8");
  }
  if (process.stdin.isTTY) {
    say("\u001b[?2004h");
    osc("idle");
    return terminalPrompt();
  }
  osc("idle");
  return stdinPrompt();
}

async function main() {
  const argv = process.argv.slice(2);
  const valid = argv.length === 0 || (argv.length === 2 && argv[0] === "--prompt-file");
  if (!valid) {
    writeSync(2, "smoke: usage: smoke.mjs [--prompt-file <path>]\n");
    return 2;
  }
  let prompt;
  try {
    prompt = (await readPrompt(argv[1])).replace(/\r\n?/g, "\n").trim();
  } catch (error) {
    writeSync(2, `smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  osc("working");
  if (!prompt) {
    writeSync(2, "smoke: no prompt arrived\n");
    osc("done");
    return 2;
  }
  say(`\`\`\`json\n${JSON.stringify({ ok: true, promptLength: prompt.length })}\n\`\`\`\n`);
  osc("done");
  return 0;
}

main().then((code) => process.exit(code));
