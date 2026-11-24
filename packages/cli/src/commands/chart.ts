/**
 * `argos chart [path]` (FR9–FR12) — the playbook DAG as Mermaid (default) or JSON.
 *
 * Loader only, exactly like `argos validate`: no server, no SQLite, no side effects. The
 * file-vs-directory-vs-playbooks-directory rules are deliberately not repeated here —
 * `validatePlaybooks` (`./validate.js`) resolves the targets and reports every loader failure, and
 * this command then reloads each surviving playbook by the file the report named to get its IR.
 * The second load is a few microseconds and keeps the two commands from drifting.
 *
 * `--run <id>` is the one mode that needs a server, and it charts the *run's* graph, never the
 * working tree's (D9): a definition may have been edited since the run started, and the frozen
 * record is the truth. `--json` implies `--format json`, and an explicit conflicting `--format` is
 * a usage error rather than a silent override.
 *
 * Mermaid is the diffable form (one fenced block per playbook, `## <id>` only when the output
 * holds more than one), so `argos chart --out docs/graph.mmd` is stable in a PR.
 */

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { argosHome } from "@thaodangspace/argos-core";
import { buildPlaybookGraph, loadPlaybook, type PlaybookIR } from "@thaodangspace/argos-core/playbook";
import type { PlaybookGraph, ValidateError, ValidateWarning } from "@thaodangspace/argos-core/rpc";
import {
  decorateGraph,
  renderMermaid,
  stepStatusTone,
  type MermaidDirection,
} from "@thaodangspace/argos-core/view";

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_VALIDATION, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";
import { validatePlaybooks } from "./validate.js";

/** `mermaid` is the default; the global `--json` selects `json` too. */
type ChartFormat = "mermaid" | "json";

/** One charted playbook: the id, the content hash, and the projected graph. */
interface Charted {
  readonly id: string;
  readonly hash: string;
  readonly graph: PlaybookGraph;
}

/** The rendering choices every mode shares. */
interface Output {
  readonly format: ChartFormat;
  readonly direction: MermaidDirection;
  readonly out: string | undefined;
}

function fail(io: CliIo, message: string): number {
  io.stderr(`argos: ${message}\n`);
  return EXIT_RUNTIME;
}

/** One loader failure as a line an author can act on: `file: step <id>: <code>: <message>`. */
function errorLine(error: ValidateError): string {
  const where = error.stepId === null ? error.file : `${error.file}: step ${error.stepId}`;
  return `${where}: ${error.code}: ${error.message}`;
}

/** `validate`'s `WARN` line, kept on stderr so it can never break the diagram on stdout. */
function warningLine(warning: ValidateWarning): string {
  const where =
    warning.stepId === null ? warning.file : `${warning.file}: step ${warning.stepId}`;
  return `WARN  ${where}: ${warning.code}: ${warning.message}\n`;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write the rendered text, or print it: `--out` never also prints a copy (FR10). */
function emit(io: CliIo, text: string, out: string | undefined): number {
  if (out === undefined) {
    io.stdout(text);
    return EXIT_OK;
  }
  try {
    writeFileSync(out, text, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(io, `cannot write ${out}: ${message}`);
  }
  return EXIT_OK;
}

/**
 * The Mermaid document (FR10): one fenced block per playbook, headings only when the output holds
 * more than one, and one blank line between blocks. Byte-stable for the same repository.
 */
function mermaidText(playbooks: readonly Charted[], direction: MermaidDirection): string {
  const heading = playbooks.length > 1;
  const blocks = playbooks.map((playbook) => {
    const fence =
      "```mermaid\n" +
      renderMermaid(playbook.graph, {
        direction,
        identity: { id: playbook.id, hash: playbook.hash },
      }) +
      "```\n";
    return heading ? `## ${playbook.id}\n\n${fence}` : fence;
  });
  return blocks.join("\n");
}

/**
 * `--run <id>` (FR11, D9): fetch one run's detail and render the graph the record froze, decorated
 * with the statuses of its steps. The renderer is reached through `withRpc` so the transport
 * mapping (exit 3 unreachable, `run_unknown` exit 1) is the same as every other client command;
 * its output is captured so `--out` can write exactly those bytes instead.
 */
async function chartRun(runId: string, output: Output, io: CliIo): Promise<number> {
  let captured = "";
  const code = await withRpc(
    { stdout: (text) => (captured += text), stderr: io.stderr },
    output.format === "json",
    async (client) => {
      const detail = await client.getRun(runId);
      const graph = detail.graph;
      if (graph === undefined) {
        // An older server projects no graph. Render nothing rather than a lie about the run.
        throw new Error(`graph unavailable for run ${runId}`);
      }
      const steps = detail.steps.map((step) => ({
        id: step.id,
        status: step.status,
        tone: stepStatusTone(step.status),
      }));
      if (output.format === "json") {
        return {
          jsonValue: { runId: detail.id, graph: decorateGraph(graph, steps) },
          human: "",
        };
      }
      return {
        jsonValue: undefined,
        human: renderMermaid(graph, {
          direction: output.direction,
          identity: { id: detail.playbookId, hash: detail.playbookHash },
          statuses: steps,
        }),
      };
    },
  );
  if (code !== EXIT_OK) {
    // withRpc already chose the stream for the failure: a JSON envelope belongs on stdout, the
    // human line is already on stderr and left nothing captured.
    io.stdout(captured);
    return code;
  }
  return emit(io, captured, output.out);
}

/** `path` (or the current directory) → one entry per surviving playbook, in discovery order. */
async function chartRepo(
  args: ParsedArgs,
  playbookId: string | undefined,
  output: Output,
  io: CliIo,
): Promise<number> {
  // Same precedence as `argos serve`: `ARGOS_HOME`, else `~/.argos`, so a local render and a
  // running server agree on the global playbook library.
  const home = argosHome();
  let result: ReturnType<typeof validatePlaybooks>;
  try {
    result = validatePlaybooks(args.positionals[0], process.cwd(), home);
  } catch (error) {
    return fail(io, error instanceof Error ? error.message : String(error));
  }

  for (const warning of result.report.warnings) io.stderr(warningLine(warning));
  if (result.report.errors.length > 0) {
    // No partial output (FR12): a graph of the playbooks that happened to load would be a lie.
    for (const error of result.report.errors) io.stderr(`${errorLine(error)}\n`);
    return EXIT_VALIDATION;
  }

  const selected =
    playbookId === undefined
      ? result.report.playbooks
      : result.report.playbooks.filter((playbook) => playbook.id === playbookId);
  if (selected.length === 0 && playbookId !== undefined) {
    io.stderr(`argos: playbook_missing: no playbook "${playbookId}" under ${result.repoDir}\n`);
    return EXIT_VALIDATION;
  }

  const charted: Charted[] = [];
  for (const playbook of selected) {
    // Load the file the report named, with the repository root it resolved: the same IR, the same
    // hash, and no second discovery pass.
    const file = isAbsolute(playbook.file)
      ? playbook.file
      : resolve(result.repoDir, playbook.file);
    let ir: PlaybookIR;
    try {
      ir = loadPlaybook(result.repoDir, playbook.id, { file, home });
    } catch (error) {
      // The report already named every loader failure, so reaching this means the file changed
      // between the two loads. Report it the same way instead of charting something stale.
      io.stderr(`argos: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_VALIDATION;
    }
    charted.push({ id: ir.id, hash: ir.hash, graph: buildPlaybookGraph(ir) });
  }

  if (output.format === "json") return emit(io, jsonText({ playbooks: charted }), output.out);
  if (charted.length === 0 && output.out === undefined) {
    io.stderr(`argos: no playbooks found under ${result.repoDir}\n`);
  }
  return emit(io, mermaidText(charted, output.direction), output.out);
}

export async function chartCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["playbook", "format", "out", "direction", "run"]);
  if (unknown !== undefined) return fail(io, unknown);
  if (args.positionals.length > 1) return fail(io, "chart takes at most one path");

  const formatFlag = flag(args, "format");
  if (formatFlag !== undefined && formatFlag !== "mermaid" && formatFlag !== "json") {
    return fail(io, `--format takes mermaid or json, not "${formatFlag}"`);
  }
  if (args.json && formatFlag === "mermaid") {
    return fail(io, "--json implies --format json; drop --format mermaid");
  }
  const format: ChartFormat = args.json || formatFlag === "json" ? "json" : "mermaid";

  const directionFlag = flag(args, "direction");
  if (directionFlag !== undefined && directionFlag !== "LR" && directionFlag !== "TB") {
    return fail(io, `--direction takes LR or TB, not "${directionFlag}"`);
  }
  const direction: MermaidDirection = directionFlag === "TB" ? "TB" : "LR";

  // The parser hands a bare flag the value `"true"`, which is never a real id or path here.
  const out = flag(args, "out");
  if (out === "true") return fail(io, "--out needs a file path");
  const playbookId = flag(args, "playbook");
  if (playbookId === "true") return fail(io, "--playbook needs a playbook id");
  const runId = flag(args, "run");
  if (runId === "true") return fail(io, "--run needs a run id");

  const output: Output = { format, direction, out };
  if (runId === undefined) return chartRepo(args, playbookId, output, io);
  if (args.positionals.length > 0 || playbookId !== undefined) {
    return fail(io, "--run charts one run's graph; drop the path and --playbook");
  }
  return chartRun(runId, output, io);
}
