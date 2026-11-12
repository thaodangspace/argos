/** `argos decide`, `argos cancel`, `argos retry` (FR25), `argos rm`. */

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";

export async function decideCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["comment", "decided-by", "decided-via"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const [runId, gateId, decision] = args.positionals;
  if (runId === undefined || gateId === undefined || decision === undefined) {
    io.stderr("argos: decide needs <runId> <gateId> <decision>\n");
    return EXIT_RUNTIME;
  }
  const comment = flag(args, "comment");
  const decidedBy = flag(args, "decided-by");
  const decidedVia = flag(args, "decided-via");
  return withRpc(io, args.json, async (client) => {
    const receipt = await client.decideGate(runId, gateId, {
      decision,
      ...(comment === undefined ? {} : { comment }),
      ...(decidedBy === undefined ? {} : { decidedBy }),
      ...(decidedVia === undefined ? {} : { decidedVia }),
    });
    const note = receipt.comment === undefined ? "" : ` — ${receipt.comment}`;
    return {
      jsonValue: receipt,
      human: `gate ${receipt.gateId} decided "${receipt.decision}"${note}`,
    };
  });
}

export async function cancelCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const runId = args.positionals[0];
  if (runId === undefined) {
    io.stderr("argos: cancel needs a run id\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const result = await client.cancelRun(runId);
    return { jsonValue: result, human: `run ${result.runId} ${result.status}` };
  });
}

export async function rmCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const runId = args.positionals[0];
  if (runId === undefined) {
    io.stderr("argos: rm needs a run id\n");
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: rm takes exactly one run id\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const result = await client.removeRun(runId);
    const kept = result.worktree === undefined ? "" : `; worktree kept at ${result.worktree}`;
    return { jsonValue: result, human: `removed run ${result.runId} (${result.status})${kept}` };
  });
}

export async function retryCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const [runId, stepId] = args.positionals;
  if (runId === undefined || stepId === undefined) {
    io.stderr("argos: retry needs <runId> <stepId>\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const started = await client.retryStep(runId, stepId);
    return {
      jsonValue: started,
      human: `run ${started.runId} retried from ${stepId} (task ${started.taskId})`,
    };
  });
}
