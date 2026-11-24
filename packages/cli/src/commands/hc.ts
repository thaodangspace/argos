/**
 * `argos hc templates list|install|uninstall` (spec FR10–FR12, FR15; plan Phase 2).
 *
 * Templates are **machine-level** assets: `hc` reads a directory, so an Argos install puts files
 * there once instead of every repository vendoring a script. Nothing on this path talks to `hc`,
 * opens a socket, reads SQLite, or spawns a process — `node:fs` only, plus Argos' own manifest at
 * `$ARGOS_HOME/hc/packs.json`.
 *
 * The command is deliberately a thin shell around the pure planner: `--dry-run` prints the plan that
 * the real run applies, so the two cannot disagree.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { flag, hasFlag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_VALIDATION,
  printJson,
  printJsonError,
  type CliIo,
} from "../output.js";
import { PackApplyError, applyInstall, applyUninstall } from "../packs/apply.js";
import { PackAssetsError, bundledPacks } from "../packs/bundled.js";
import {
  emptyManifest,
  parseManifest,
  parsePack,
  parseTemplate,
  type PackManifest,
} from "../packs/pack.js";
import {
  planInstall,
  planUninstall,
  type DiskTemplate,
  type InstallPlan,
  type InstalledProgram,
  type PackSource,
  type Refusal,
  type UninstallPlan,
} from "../packs/plan.js";
import {
  argosStateDir,
  manifestPath,
  packInstallDir,
  packsRoot,
  templatesDir,
} from "../packs/templates-dir.js";

// ------------------------------------------------------------------ view

interface TemplateView {
  readonly name: string;
  readonly file: string;
  /** The command the installed `.md` carries; `null` when the file is missing or unreadable. */
  readonly command: string | null;
  readonly minStepTimeoutMs: number;
  readonly present: boolean;
}

interface PackView {
  readonly name: string;
  readonly version: number;
  readonly program: string;
  readonly programSha256?: string;
  readonly link?: string;
  readonly templates: readonly TemplateView[];
}

interface PacksView {
  readonly dir: string;
  readonly packs: readonly PackView[];
}

/** Read a file's text, or `undefined` when it is missing or unreadable (never throws). */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The one projection behind `list --json` and the `packs` key of `install --json`/`uninstall
 * --json`. `pending` is what the plan is about to write, so a `--dry-run` reports `present: true`
 * for the files it would create instead of pretending nothing happened.
 */
function describePacks(
  manifest: PackManifest,
  dir: string,
  pending?: ReadonlyMap<string, string>,
): PacksView {
  const packs = Object.keys(manifest.packs)
    .sort()
    .map((name): PackView => {
      const entry = manifest.packs[name];
      if (entry === undefined) throw new Error(`manifest lost pack ${name}`);
      const templates = Object.keys(entry.templates)
        .sort()
        .map((templateName): TemplateView => {
          const template = entry.templates[templateName];
          if (template === undefined) throw new Error(`manifest lost template ${templateName}`);
          const content = pending?.get(template.file) ?? readIfPresent(template.file);
          return {
            name: templateName,
            file: template.file,
            command: content === undefined ? null : (parseTemplate(content).command ?? null),
            minStepTimeoutMs: template.minStepTimeoutMs,
            present: content !== undefined,
          };
        });
      return {
        name,
        version: entry.version,
        program: entry.program,
        ...(entry.programSha256 === undefined ? {} : { programSha256: entry.programSha256 }),
        ...(entry.link === undefined ? {} : { link: entry.link }),
        templates,
      };
    });
  return { dir, packs };
}

function pendingContents(writes: readonly { path: string; content: string }[]): Map<string, string> {
  return new Map(writes.map((write) => [write.path, write.content]));
}

// ------------------------------------------------------------------ io helpers

function usage(io: CliIo, message: string): number {
  io.stderr(`argos: ${message}\n`);
  return EXIT_RUNTIME;
}

/** A validation refusal: exit 2, naming the code and the path or field (FR14). */
function refuse(io: CliIo, json: boolean, refusals: readonly Refusal[]): number {
  if (json) {
    printJsonError(
      io,
      refusals[0]?.code ?? "invalid_request",
      refusals.map((refusal) => refusal.message).join("; "),
    );
  } else {
    for (const refusal of refusals) io.stderr(`argos: ${refusal.code}: ${refusal.message}\n`);
  }
  return EXIT_VALIDATION;
}

function failure(io: CliIo, json: boolean, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (json) printJsonError(io, "internal_error", message);
  else io.stderr(`argos: ${message}\n`);
  return EXIT_RUNTIME;
}

const NEXT_STEPS = [
  "argos hc templates: run `hc templates` to confirm",
  "argos hc templates: restart `argos serve` if it was already running",
];

// ------------------------------------------------------------------ fs reads

type ManifestRead =
  | { readonly ok: true; readonly manifest: PackManifest }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

/** The manifest is a claim about disk, so an unreadable one is refused, never rewritten blind. */
function readManifestDocument(home: string): ManifestRead {
  const file = manifestPath(home);
  const text = readIfPresent(file);
  if (text === undefined) {
    // Missing is fine (nothing installed); present-but-unreadable is not, and neither is a
    // hand-edited document: rewriting it blind would silently drop another pack's entry.
    if (existsSync(file)) {
      return {
        ok: false,
        refusals: [{ code: "manifest_invalid", message: `${file}: not readable` }],
      };
    }
    return { ok: true, manifest: emptyManifest() };
  }
  const parsed = parseManifest(text, file);
  if (parsed.ok) return { ok: true, manifest: parsed.value };
  return {
    ok: false,
    refusals: parsed.issues.map((issue) => ({
      code: "manifest_invalid",
      message: `${issue.path}: ${issue.message}`,
    })),
  };
}

/** Every `.md` in the templates directory, content included: the plan needs bytes, not names. */
function readTemplates(dir: string): DiskTemplate[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const templates: DiskTemplate[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      templates.push({ name: entry.slice(0, -".md".length), content: readFileSync(path, "utf8") });
    } catch {
      // An unreadable file is not ours to reason about; treat it as absent.
    }
  }
  return templates;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What is already installed at a program path (a copy's hash, or a symlink's target). */
function installedProgram(path: string): InstalledProgram | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return { linkTarget: readlinkSync(path) };
  try {
    return { sha256: sha256(readFileSync(path, "utf8")) };
  } catch {
    return undefined;
  }
}

/** `<name>@<version>` directories that exist under `$ARGOS_HOME/hc/packs`. */
function existingPackDirs(home: string): string[] {
  try {
    return readdirSync(packsRoot(home))
      .filter(
        (entry) =>
          lstatSync(join(packsRoot(home), entry), { throwIfNoEntry: false })?.isDirectory() === true,
      )
      .sort();
  } catch {
    return [];
  }
}

/** A `--from` directory: one pack (`pack.json` inside), or a directory of packs. */
function packDirsIn(root: string): string[] {
  if (existsSync(join(root, "pack.json"))) return [root];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((entry) => join(root, entry))
    .filter((dir) => existsSync(join(dir, "pack.json")));
}

function declaredName(dir: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
    const name = (raw as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ list

async function listCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["dir"]);
  if (unknown !== undefined) return usage(io, unknown);
  if (args.positionals.length > 2) return usage(io, "hc templates list takes no arguments");

  const dir = templatesDir(flag(args, "dir"));
  const read = readManifestDocument(argosStateDir());
  if (!read.ok) return refuse(io, args.json, read.refusals);

  const view = describePacks(read.manifest, dir);
  if (args.json) {
    printJson(io, view);
    return EXIT_OK;
  }
  io.stdout(`${humanList(view)}\n`);
  return EXIT_OK;
}

function humanList(view: PacksView): string {
  const lines = [`argos hc templates: ${view.dir}`];
  if (view.packs.length === 0) {
    lines.push("  no packs installed; run `argos hc templates install`");
    return lines.join("\n");
  }
  for (const pack of view.packs) {
    lines.push(`  ${pack.name} ${pack.version}`);
    lines.push(`    program  ${pack.program}`);
    for (const template of pack.templates) {
      lines.push(
        `    ${template.name}  ${template.minStepTimeoutMs} ms  ${template.present ? "present" : "missing"}`,
      );
      lines.push(`      ${template.file}`);
      if (template.command !== null) lines.push(`      ${template.command}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ install

async function installCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["dir", "from", "link", "force", "dry-run"]);
  if (unknown !== undefined) return usage(io, unknown);

  const names = args.positionals.slice(2);
  const dir = templatesDir(flag(args, "dir"));
  const home = argosStateDir();
  const link = hasFlag(args, "link");
  const force = hasFlag(args, "force");
  const dryRun = hasFlag(args, "dry-run");
  const refusals: Refusal[] = [];

  let root: string;
  let source: string;
  let available: string[];
  try {
    const from = flag(args, "from");
    if (from === undefined) {
      const bundled = bundledPacks();
      root = bundled.dir;
      source = "bundled";
      available = bundled.names.map((name) => join(bundled.dir, name));
    } else {
      root = resolve(from);
      source = root;
      available = packDirsIn(root);
      if (available.length === 0) {
        refusals.push({ code: "pack_missing", message: `no pack found in ${root} (expected pack.json)` });
      }
    }
  } catch (error) {
    if (error instanceof PackAssetsError) return failure(io, args.json, error);
    throw error;
  }

  const selected: string[] = [];
  if (names.length === 0) {
    selected.push(...available);
  } else {
    for (const name of names) {
      const match =
        available.find((candidate) => basename(candidate) === name) ??
        available.find((candidate) => declaredName(candidate) === name);
      if (match === undefined) {
        refusals.push({ code: "pack_unknown", message: `no pack "${name}" in ${root}` });
      } else if (!selected.includes(match)) {
        selected.push(match);
      }
    }
  }

  const packs: PackSource[] = [];
  for (const packDir of selected) {
    const file = join(packDir, "pack.json");
    const text = readIfPresent(file);
    if (text === undefined) {
      refusals.push({ code: "pack_invalid", message: `${file}: not readable` });
      continue;
    }
    const parsed = parsePack(text, file);
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        refusals.push({ code: "pack_invalid", message: `${issue.path}: ${issue.message}` });
      }
      continue;
    }
    const pack = parsed.value;
    const programPath = resolve(packDir, pack.program.file);
    let programContent: string | undefined;
    if (!link) {
      try {
        programContent = readFileSync(programPath, "utf8");
      } catch {
        refusals.push({
          code: "program_missing",
          message: `${file}: program "${pack.program.file}" is missing or unreadable`,
        });
        continue;
      }
    }
    const destination = join(packInstallDir(home, pack.name, pack.version), pack.program.file);
    const installed = installedProgram(destination);
    packs.push({
      pack,
      file,
      dir: packDir,
      source,
      ...(programContent === undefined ? {} : { programContent }),
      ...(installed === undefined ? {} : { installedProgram: installed }),
    });
  }

  const read = readManifestDocument(home);
  if (!read.ok) return refuse(io, args.json, [...refusals, ...read.refusals]);
  if (refusals.length > 0) return refuse(io, args.json, refusals);

  const plan = planInstall({
    packs,
    templates: readTemplates(dir),
    manifest: read.manifest,
    templatesDir: dir,
    home,
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    link,
    force,
  });
  if (plan.refusals.length > 0) return refuse(io, args.json, plan.refusals);

  const view = describePacks(plan.manifest, dir, pendingContents(plan.writes));
  if (!dryRun) {
    try {
      applyInstall(plan, { home, templatesDir: dir });
    } catch (error) {
      if (error instanceof PackApplyError) return failure(io, args.json, error);
      throw error;
    }
  }

  if (args.json) {
    printJson(io, {
      ...view,
      manifest: manifestPath(home),
      dryRun,
      unchanged: plan.unchanged,
      writes: plan.writes.map((write) => write.path),
      links: plan.links.map((link) => ({ path: link.path, target: link.target })),
      warnings: [...plan.warnings],
    });
    return EXIT_OK;
  }
  io.stdout(
    `${humanInstall(plan, { dir, home, dryRun, names: packs.map((pack) => pack.pack.name) })}\n${NEXT_STEPS.join("\n")}\n`,
  );
  return EXIT_OK;
}

function humanInstall(
  plan: InstallPlan,
  context: {
    readonly dir: string;
    readonly home: string;
    readonly dryRun: boolean;
    readonly names: readonly string[];
  },
): string {
  const lines = [
    `argos hc templates install${context.dryRun ? " (dry run)" : ""}: ${context.names.join(", ")}`,
    `  templates  ${context.dir}`,
    `  manifest   ${manifestPath(context.home)}`,
  ];
  for (const write of plan.writes) lines.push(`  write      ${write.path}`);
  for (const link of plan.links) lines.push(`  link       ${link.path} -> ${link.target}`);
  if (plan.unchanged) lines.push("  unchanged  everything is already current");
  for (const warning of plan.warnings) lines.push(`  warning    ${warning}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ uninstall

async function uninstallCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["dir", "prune", "dry-run"]);
  if (unknown !== undefined) return usage(io, unknown);
  const names = args.positionals.slice(2);
  if (names.length === 0) {
    return usage(io, "hc templates uninstall needs at least one pack name");
  }

  const dir = templatesDir(flag(args, "dir"));
  const home = argosStateDir();
  const dryRun = hasFlag(args, "dry-run");
  const prune = hasFlag(args, "prune");

  const read = readManifestDocument(home);
  if (!read.ok) return refuse(io, args.json, read.refusals);

  const plan = planUninstall({
    packs: names,
    templates: readTemplates(dir),
    manifest: read.manifest,
    templatesDir: dir,
    home,
    existingPackDirs: existingPackDirs(home),
    prune,
  });
  if (plan.refusals.length > 0) return refuse(io, args.json, plan.refusals);

  const view = describePacks(plan.manifest, dir);
  if (!dryRun) {
    try {
      applyUninstall(plan, { home, templatesDir: dir });
    } catch (error) {
      if (error instanceof PackApplyError) return failure(io, args.json, error);
      throw error;
    }
  }

  if (args.json) {
    printJson(io, {
      ...view,
      manifest: manifestPath(home),
      dryRun,
      unchanged: plan.unchanged,
      removed: plan.removes.map((remove) => remove.path),
      kept: plan.keeps.map((keep) => ({ path: keep.path, reason: keep.reason })),
    });
    return EXIT_OK;
  }
  io.stdout(`${humanUninstall(plan, { dir, home, dryRun, names })}\n${NEXT_STEPS[1]}\n`);
  return EXIT_OK;
}

function humanUninstall(
  plan: UninstallPlan,
  context: {
    readonly dir: string;
    readonly home: string;
    readonly dryRun: boolean;
    readonly names: readonly string[];
  },
): string {
  const lines = [
    `argos hc templates uninstall${context.dryRun ? " (dry run)" : ""}: ${context.names.join(", ")}`,
    `  templates  ${context.dir}`,
  ];
  for (const remove of plan.removes) lines.push(`  remove     ${remove.path}`);
  for (const keep of plan.keeps) lines.push(`  keep       ${keep.path} (${keep.reason})`);
  if (plan.unchanged) lines.push("  unchanged  nothing to remove");
  if (plan.manifestWrite !== undefined) lines.push(`  manifest   ${plan.manifestWrite.path}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ entry

export async function hcCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const group = args.positionals[0];
  if (group !== "templates") {
    return usage(io, "hc needs a sub-command: hc templates list|install|uninstall");
  }
  const sub = args.positionals[1];
  if (sub === "list") return listCommand(args, io);
  if (sub === "install") return installCommand(args, io);
  if (sub === "uninstall") return uninstallCommand(args, io);
  return usage(io, "hc templates needs a sub-command: list|install|uninstall");
}
