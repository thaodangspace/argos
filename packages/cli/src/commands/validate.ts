/**
 * `argos validate [path]` (FR25, FR12) — loader only: no server, no SQLite, no side effects.
 *
 * With no argument it validates every playbook discovered under the current directory (the same
 * `.argos/playbooks` / `.paseo/plugins/playbooks` roots the engine uses) plus the global library in
 * `$ARGOS_HOME/playbooks` (`--home`, else `ARGOS_HOME`, else `~/.argos`). A file argument is
 * validated as that exact file, with the repository root inferred from the standard directory
 * layout; a directory argument is treated as a repository root, unless it is itself a playbooks
 * directory or a loose folder of YAML files. Every error keeps its file and step id, and the
 * command exits 2 when at least one playbook is invalid.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { argosHome, errorLocation, isArgosError } from "argos-core";
import {
  discoverPlaybooks,
  loadPlaybook,
  type LoadWarning,
  type PlaybookEntry,
} from "argos-core/playbook";
import type {
  ValidateError,
  ValidatePlaybook,
  ValidateReport,
  ValidateWarning,
} from "argos-core/rpc";

import type { ParsedArgs } from "../args.js";
import { flag, rejectUnknownFlags } from "../args.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_VALIDATION,
  printJson,
  type CliIo,
} from "../output.js";

interface Candidate {
  readonly entry: PlaybookEntry;
  /** True when the file is outside the standard discovery roots and must be loaded by path. */
  readonly explicit: boolean;
}

interface ValidationResult {
  readonly report: ValidateReport;
  readonly repoDir: string;
}

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const ROOT_MARKERS = [
  "/.argos/playbooks",
  "/.paseo/plugins/playbooks",
] as const;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** The repository root a standard playbooks path belongs to. */
function inferRepoRoot(file: string): string {
  const posix = toPosix(file);
  for (const marker of ROOT_MARKERS) {
    const index = posix.indexOf(marker);
    if (index > 0) return posix.slice(0, index);
  }
  return dirname(file);
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => YAML_EXTENSIONS.has(extname(name)))
    .map((name) => join(directory, name))
    .filter((file) => statSync(file).isFile())
    .sort();
}

function candidatesFor(
  target: string,
  home: string,
): { repoDir: string; candidates: Candidate[] } {
  const absolute = resolve(target);
  if (!existsSync(absolute)) {
    throw new Error(`path not found: ${target}`);
  }
  const info = statSync(absolute);
  if (info.isFile()) {
    const id = basename(absolute, extname(absolute));
    return {
      repoDir: inferRepoRoot(absolute),
      candidates: [{ entry: { id, file: absolute, root: "" }, explicit: true }],
    };
  }
  if (!info.isDirectory()) {
    throw new Error(`not a file or directory: ${target}`);
  }
  const discovered = discoverPlaybooks(absolute, home);
  if (discovered.length > 0) {
    return {
      repoDir: absolute,
      candidates: discovered.map((entry) => ({ entry, explicit: false })),
    };
  }
  const files = yamlFiles(absolute);
  const explicit = files.map((file) => ({
    entry: { id: basename(file, extname(file)), file, root: "" },
    explicit: true,
  }));
  return { repoDir: inferRepoRoot(absolute), candidates: explicit };
}

function displayPath(repoDir: string, file: string): string {
  const path = relative(resolve(repoDir), resolve(file));
  return path === "" || path.startsWith("..") ? resolve(file) : toPosix(path);
}

/** Run the loader over every candidate and collect every failure (never stop at the first). */
export function validatePlaybooks(
  pathArg: string | undefined,
  cwd: string = process.cwd(),
  home: string = argosHome(),
): ValidationResult {
  const root = resolve(cwd);
  const { repoDir, candidates } =
    pathArg === undefined
      ? {
          repoDir: root,
          candidates: discoverPlaybooks(root, home).map((entry) => ({
            entry,
            explicit: false,
          })),
        }
      : candidatesFor(resolve(root, pathArg), home);

  const playbooks: ValidatePlaybook[] = [];
  const errors: ValidateError[] = [];
  const warnings: LoadWarning[] = [];
  for (const candidate of candidates) {
    try {
      const ir = loadPlaybook(
        repoDir,
        candidate.entry.id,
        candidate.explicit
          ? { file: candidate.entry.file, home, warnings }
          : { home, warnings },
      );
      playbooks.push({
        id: ir.id,
        file: displayPath(repoDir, candidate.entry.file),
        hash: ir.hash,
      });
    } catch (error) {
      const file = isArgosError(error) && error.file !== undefined ? error.file : candidate.entry.file;
      const code = isArgosError(error) ? error.code : "playbook_invalid";
      const errorStepId = isArgosError(error) ? (error.stepId ?? null) : null;
      const issues = isArgosError(error) ? (error.issues ?? []) : [];
      if (issues.length > 0) {
        // FR1.4: one `errors[]` entry per schema issue, so every typo is named in one run.
        for (const issue of issues) {
          errors.push({
            file: displayPath(repoDir, file),
            stepId: issue.stepId ?? errorStepId,
            code,
            message: `${issue.path}: ${issue.message}`,
          });
        }
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      const prefix = errorLocation(file, errorStepId ?? undefined);
      errors.push({
        file: displayPath(repoDir, file),
        stepId: errorStepId,
        code,
        message: message.startsWith(prefix) ? message.slice(prefix.length) : message,
      });
    }
  }
  return {
    repoDir,
    report: {
      valid: errors.length === 0,
      playbooks,
      errors,
      warnings: warnings.map(
        (warning): ValidateWarning => ({ ...warning, file: displayPath(repoDir, warning.file) }),
      ),
    },
  };
}

export function validateCommand(args: ParsedArgs, io: CliIo): number {
  const unknown = rejectUnknownFlags(args, ["home"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: validate takes at most one path\n");
    return EXIT_RUNTIME;
  }
  // Same precedence as `argos serve`: `--home`, else `ARGOS_HOME`, else `~/.argos`, so a local
  // check and a running server agree on the global playbook library.
  const homeFlag = flag(args, "home");
  const home = resolve(homeFlag ?? argosHome());
  let result: ValidationResult;
  try {
    result = validatePlaybooks(args.positionals[0], process.cwd(), home);
  } catch (error) {
    io.stderr(`argos: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_RUNTIME;
  }

  if (args.json) {
    printJson(io, result.report);
  } else {
    for (const playbook of result.report.playbooks) {
      io.stdout(`ok    ${playbook.id}  ${playbook.file}  ${playbook.hash}\n`);
    }
    for (const error of result.report.errors) {
      const location = error.stepId === null ? error.file : `${error.file}: step ${error.stepId}`;
      io.stdout(`FAIL  ${location}: ${error.code}: ${error.message}\n`);
    }
    // FR7.1: warnings print after the errors and never change the exit code.
    for (const warning of result.report.warnings) {
      const location = warning.stepId === null ? warning.file : `${warning.file}: step ${warning.stepId}`;
      io.stdout(`WARN  ${location}: ${warning.code}: ${warning.message}\n`);
    }
    const total = result.report.playbooks.length + result.report.errors.length;
    io.stdout(
      result.report.valid
        ? `${result.report.playbooks.length} playbook(s) valid\n`
        : `${result.report.errors.length} of ${total} playbook(s) invalid\n`,
    );
  }
  return result.report.valid ? EXIT_OK : EXIT_VALIDATION;
}
