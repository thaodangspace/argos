/**
 * Tiny argument parser for the `argos` CLI (no dependency).
 *
 * `--flag value`, `--flag=value`, and repeated `--input k=v` all work. `--json` and `--help` are
 * global booleans. Unknown flags are kept so each command can reject them with a usage error
 * instead of silently ignoring a typo.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly json: boolean;
  readonly help: boolean;
}

const BOOLEAN_FLAGS = new Set(["json", "help"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let json = false;
  let help = false;

  const record = (name: string, value: string): void => {
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const body = argument.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        record(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        record(body, "true");
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        record(body, next);
        index += 1;
        continue;
      }
      record(body, "true");
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      record(argument.slice(1), "true");
      continue;
    }
    positionals.push(argument);
  }

  const command = positionals[0];
  return {
    command,
    positionals: command === undefined ? [] : positionals.slice(1),
    flags,
    json,
    help,
  };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function flagValues(args: ParsedArgs, name: string): string[] {
  return [...(args.flags.get(name) ?? [])];
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Reject flags a command does not understand (a typo is a usage error, not a silent no-op). */
export function rejectUnknownFlags(
  args: ParsedArgs,
  allowed: readonly string[],
): string | undefined {
  const ok = new Set(allowed);
  for (const name of args.flags.keys()) {
    if (!ok.has(name)) return `unknown option --${name}`;
  }
  return undefined;
}
