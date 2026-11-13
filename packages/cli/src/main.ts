/** The `argos` command dispatcher (FR25). No storage import anywhere on this path. */

import { parseArgs } from "./args.js";
import {
  cancelCommand,
  decideCommand,
  forkCommand,
  retryCommand,
  rmCommand,
} from "./commands/actions.js";
import { doctorCommand } from "./commands/doctor.js";
import { gatesCommand, lsCommand, statusCommand } from "./commands/runs.js";
import { runCommand } from "./commands/run.js";
import { scheduleCommand } from "./commands/schedule.js";
import { validateCommand } from "./commands/validate.js";
import { worktreeCommand } from "./commands/worktree.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  REQUIRED_NODE_VERSION,
  USAGE,
  nodeVersionOk,
  processIo,
  type CliIo,
} from "./output.js";

/** Run one CLI invocation and return its exit code (0/1/2/3). */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (args.command === undefined) {
    io.stderr(USAGE);
    return EXIT_RUNTIME;
  }
  if (!nodeVersionOk()) {
    io.stderr(
      `argos: Node ${process.versions.node} is too old; Argos needs ${REQUIRED_NODE_VERSION} (built-in SQLite)\n`,
    );
    return EXIT_RUNTIME;
  }

  switch (args.command) {
    case "validate":
      return validateCommand(args, io);
    case "run":
      return runCommand(args, io);
    case "ls":
      return lsCommand(args, io);
    case "status":
      return statusCommand(args, io);
    case "gates":
      return gatesCommand(args, io);
    case "decide":
      return decideCommand(args, io);
    case "cancel":
      return cancelCommand(args, io);
    case "retry":
      return retryCommand(args, io);
    case "fork":
      return forkCommand(args, io);
    case "rm":
      return rmCommand(args, io);
    case "worktree":
      return worktreeCommand(args, io);
    case "schedule":
      return scheduleCommand(args, io);
    case "doctor":
      return doctorCommand(args, io);
    case "serve": {
      // Lazy: `argos run` must never load the durable host (or SQLite) into its process (FR3).
      const module = await import("./commands/serve.js");
      return module.serveCommand(args, io);
    }
    default:
      io.stderr(`argos: unknown command "${args.command}"\n\n${USAGE}`);
      return EXIT_RUNTIME;
  }
}
