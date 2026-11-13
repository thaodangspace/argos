/** `argos run <playbook>` (FR25) — HTTP client only, never opens storage. */

import { resolve } from "node:path";

import type { Scalar, StartRunRequest } from "@thaodangspace/argos-core/rpc";

import { flag, flagValues, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";

function parseInputs(raw: readonly string[]): Record<string, Scalar> | undefined {
  const inputs: Record<string, Scalar> = {};
  for (const pair of raw) {
    const equals = pair.indexOf("=");
    if (equals <= 0) return undefined;
    inputs[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return inputs;
}

export async function runCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, [
    "input",
    "cwd",
    "isolation",
    "client-request-id",
  ]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const playbookId = args.positionals[0];
  if (playbookId === undefined) {
    io.stderr("argos: run needs a playbook id (argos run <playbook> --input k=v)\n");
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: run takes exactly one playbook id\n");
    return EXIT_RUNTIME;
  }
  const inputs = parseInputs(flagValues(args, "input"));
  if (inputs === undefined) {
    io.stderr("argos: --input expects k=v\n");
    return EXIT_RUNTIME;
  }
  const isolation = flag(args, "isolation");
  if (isolation !== undefined && isolation !== "none" && isolation !== "worktree") {
    io.stderr("argos: --isolation must be none or worktree\n");
    return EXIT_RUNTIME;
  }
  const cwdFlag = flag(args, "cwd");
  const clientRequestId = flag(args, "client-request-id");

  const request: StartRunRequest = {
    playbookId,
    inputs,
    // Default to the caller's directory: `argos run` in a repo must not depend on where the
    // long-lived `argos serve` process was started.
    cwd: cwdFlag === undefined ? process.cwd() : resolve(cwdFlag),
    ...(isolation === undefined ? {} : { isolation: { mode: isolation } }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  };

  return withRpc(io, args.json, async (client) => {
    const started = await client.startRun(request);
    return {
      jsonValue: started,
      human: `started run ${started.runId} (task ${started.taskId})`,
    };
  });
}
