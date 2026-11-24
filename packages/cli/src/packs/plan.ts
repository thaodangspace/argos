/**
 * The pure half of the installer (spec FR11/FR12, plan Phase 2).
 *
 * `planInstall` and `planUninstall` take the *contents* of everything they need and return the
 * list of writes, links, removals, and the next manifest. No fs, no clock, no env read: `--dry-run`
 * prints this plan and the real install applies the same one, so the two cannot disagree.
 *
 * Rules encoded here:
 * - a version bump installs into `packs/<name>@<version>/`, never over a running terminal's file;
 * - identical content is no write at all, and a plan with nothing to do is `unchanged`;
 * - a `.md` without our marker is refused unless `--force`, and a marker naming another pack is
 *   refused too (two packs may not own one template name);
 * - the running Node must satisfy `requires.node`, and `requires.hcProtocol` must be 1;
 * - `hc`/`claude` floors are warnings: the API has no per-template probe, and a template that works
 *   today must not be blocked by a version string;
 * - `uninstall` deletes a file only when the file itself carries our marker.
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
  parseTemplate,
  renderTemplate,
  serializeManifest,
  type Pack,
  type PackManifest,
  type PackManifestPack,
} from "./pack.js";
import { PACK_DIR_RULE, manifestPath, packInstallDir, packsRoot } from "./templates-dir.js";

// ------------------------------------------------------------------ quoting

/**
 * One command argument, quoted for the platform that will parse it (FR11).
 *
 * POSIX gets single quotes with a `'\''` run for an embedded quote (correct for every byte a path
 * can hold), Windows gets CRT-style double quotes with a backslash-escaped `"`. A path containing
 * both quote styles therefore survives either way instead of producing a command hc cannot run.
 */
export function quoteCommandArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return quoteWindows(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteWindows(value: string): string {
  let out = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

// ------------------------------------------------------------------ node floors

const NODE_FLOOR = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * `satisfiesNodeFloor(">=22.13", "22.13.0")` → true. `undefined` means the floor is not a form this
 * installer understands, which the caller turns into a refusal rather than a guess.
 */
export function satisfiesNodeFloor(floor: string, version: string): boolean | undefined {
  const wanted = NODE_FLOOR.exec(floor.trim());
  if (wanted === null) return undefined;
  const have = version.split(".").map((part) => Number.parseInt(part, 10));
  if (have.length < 2 || have.some((part) => !Number.isInteger(part))) return undefined;
  const wantedParts = [wanted[1], wanted[2] ?? "0", wanted[3] ?? "0"].map((part) =>
    Number.parseInt(part as string, 10),
  );
  for (let index = 0; index < 3; index += 1) {
    const left = have[index] ?? 0;
    const right = wantedParts[index] as number;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

// ------------------------------------------------------------------ inputs

/** A template file that is already in the templates directory (its `.md` basename, content read). */
export interface DiskTemplate {
  readonly name: string;
  readonly content: string;
}

/** The program already installed at the destination path, as read by the caller. */
export interface InstalledProgram {
  readonly sha256?: string;
  readonly linkTarget?: string;
}

/** One pack to install, with its source files already read (this is what keeps the plan pure). */
export interface PackSource {
  readonly pack: Pack;
  /** Absolute `pack.json` path, for messages. */
  readonly file: string;
  /** Absolute pack directory (the program lives beside `pack.json`). */
  readonly dir: string;
  /** The manifest's `source`: `bundled`, or the `--from` directory. */
  readonly source: string;
  /** Program contents; absent for `--link`, where only the source path matters. */
  readonly programContent?: string;
  readonly installedProgram?: InstalledProgram;
}

export interface InstallInput {
  readonly packs: readonly PackSource[];
  readonly templates: readonly DiskTemplate[];
  readonly manifest: PackManifest;
  readonly templatesDir: string;
  readonly home: string;
  /** The running Node, e.g. `process.versions.node`. */
  readonly nodeVersion: string;
  /** Absolute `process.execPath`: hc starts the program from its own minimal `PATH`. */
  readonly nodePath: string;
  readonly link: boolean;
  readonly force: boolean;
  readonly platform?: NodeJS.Platform;
}

export interface PlannedWrite {
  readonly path: string;
  readonly content: string;
  /** `0700` for a program, `0644` for a template, `0600` for the manifest. */
  readonly mode: number;
}

export interface PlannedLink {
  readonly path: string;
  readonly target: string;
}

export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface InstallPlan {
  readonly writes: readonly PlannedWrite[];
  readonly links: readonly PlannedLink[];
  readonly manifest: PackManifest;
  /** The manifest write, applied **last** (NFR: an interrupted install is detectable). */
  readonly manifestWrite?: PlannedWrite;
  readonly warnings: readonly string[];
  readonly refusals: readonly Refusal[];
  readonly unchanged: boolean;
}

// ------------------------------------------------------------------ install

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sortedPacks(packs: Readonly<Record<string, PackManifestPack>>): PackManifest {
  const entries = Object.keys(packs)
    .sort()
    .map((name) => [name, packs[name] as PackManifestPack] as const);
  return { version: 1, packs: Object.fromEntries(entries) };
}

/** `<abs node> <abs program> <pack args> <template args>` — quoted, never re-split by us. */
function templateCommand(
  nodePath: string,
  programPath: string,
  programArgs: string | undefined,
  templateArgs: string,
  platform: NodeJS.Platform,
): string {
  const parts = [quoteCommandArg(nodePath, platform), quoteCommandArg(programPath, platform)];
  for (const extra of [programArgs, templateArgs]) {
    const trimmed = extra?.trim() ?? "";
    if (trimmed !== "") parts.push(trimmed);
  }
  return parts.join(" ");
}

export function planInstall(input: InstallInput): InstallPlan {
  const platform = input.platform ?? process.platform;
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const writes: PlannedWrite[] = [];
  const links: PlannedLink[] = [];
  const nextPacks: Record<string, PackManifestPack> = { ...input.manifest.packs };
  const claimed = new Map<string, string>();

  const refuse = (code: string, message: string): void => {
    refusals.push({ code, message });
  };

  if (input.link && platform === "win32") {
    refuse("link_unsupported", "--link is not supported on Windows (creating a symlink needs a privilege)");
  }

  const seen = new Set<string>();
  for (const source of input.packs) {
    const pack = source.pack;
    if (seen.has(pack.name)) {
      refuse("pack_duplicate", `${source.file}: pack "${pack.name}" is listed twice`);
      continue;
    }
    seen.add(pack.name);

    if (pack.requires.hcProtocol !== 1) {
      refuse(
        "unsupported_protocol",
        `${source.file}:requires.hcProtocol is ${pack.requires.hcProtocol}; this argos speaks protocol 1`,
      );
    }
    const nodeFloor = satisfiesNodeFloor(pack.requires.node, input.nodeVersion);
    if (nodeFloor === undefined) {
      refuse(
        "invalid_floor",
        `${source.file}:requires.node ${JSON.stringify(pack.requires.node)} is not a ">=x.y" floor`,
      );
    } else if (!nodeFloor) {
      refuse(
        "node_too_old",
        `${source.file}:requires.node ${pack.requires.node} is newer than the running Node ${input.nodeVersion}`,
      );
    }
    if (pack.requires.hc !== undefined) {
      warnings.push(
        `pack "${pack.name}" requires hc ${pack.requires.hc}; not checked offline (run \`hc --version\`)`,
      );
    }
    if (pack.requires.claude !== undefined) {
      warnings.push(
        `pack "${pack.name}" requires claude ${pack.requires.claude}; not checked offline (run \`claude --version\`)`,
      );
    }

    const previous = input.manifest.packs[pack.name];
    if (previous !== undefined && previous.version > pack.version) {
      warnings.push(
        `pack "${pack.name}" is installed at version ${previous.version}; installing ${pack.version} is a downgrade`,
      );
    }

    if (source.programContent === undefined && !input.link) {
      refuse("program_missing", `${source.file}: program "${pack.program.file}" could not be read`);
      continue;
    }

    const packDir = packInstallDir(input.home, pack.name, pack.version);
    const programDest = join(packDir, pack.program.file);
    const programSource = resolve(source.dir, pack.program.file);
    // A linked pack runs the program where the operator keeps it; a copied one runs the copy.
    const programPath = input.link ? programSource : programDest;

    if (input.link) {
      if (source.installedProgram?.linkTarget !== programSource) {
        links.push({ path: programDest, target: programSource });
      }
    } else {
      const content = source.programContent as string;
      if (source.installedProgram?.sha256 !== sha256(content)) {
        writes.push({ path: programDest, content, mode: 0o700 });
      }
    }

    const templates: Record<string, { file: string; minStepTimeoutMs: number }> = {};
    for (const template of pack.templates) {
      const owner = claimed.get(template.name);
      if (owner !== undefined && owner !== pack.name) {
        refuse(
          "template_conflict",
          `template "${template.name}" is claimed by both pack "${owner}" and pack "${pack.name}"`,
        );
        continue;
      }
      claimed.set(template.name, pack.name);

      const file = join(input.templatesDir, `${template.name}.md`);
      const existing = input.templates.find((candidate) => candidate.name === template.name);
      if (existing !== undefined) {
        const marker = parseTemplate(existing.content).pack;
        if (marker === undefined) {
          if (!input.force) {
            refuse(
              "template_conflict",
              `${file} exists and is not an argos pack template (pass --force to overwrite)`,
            );
            continue;
          }
        } else if (marker.name !== pack.name && !input.force) {
          refuse(
            "template_conflict",
            `${file} belongs to pack "${marker.name}"; pass --force to let pack "${pack.name}" take it`,
          );
          continue;
        }
      }

      const command = templateCommand(
        input.nodePath,
        programPath,
        pack.program.args,
        template.args,
        platform,
      );
      const content = renderTemplate({
        name: template.name,
        description: template.description ?? `${pack.name} template ${template.name}`,
        command,
        pack: { name: pack.name, version: pack.version },
      });
      if (existing?.content !== content) writes.push({ path: file, content, mode: 0o644 });
      templates[template.name] = { file, minStepTimeoutMs: template.minStepTimeoutMs };
    }

    const entry: PackManifestPack = {
      version: pack.version,
      source: source.source,
      program: programDest,
      ...(input.link
        ? { link: programPath }
        : { programSha256: sha256(source.programContent as string) }),
      templates,
    };
    nextPacks[pack.name] = entry;
  }

  // A refusal writes nothing, so a half-installed pack can never be the result of a bad input.
  if (refusals.length > 0) {
    return {
      writes: [],
      links: [],
      manifest: input.manifest,
      warnings,
      refusals,
      unchanged: false,
    };
  }

  const manifest = sortedPacks(nextPacks);
  const text = serializeManifest(manifest);
  const manifestWrite: PlannedWrite | undefined =
    text === serializeManifest(input.manifest)
      ? undefined
      : { path: manifestPath(input.home), content: text, mode: 0o600 };
  const plan: InstallPlan = {
    writes,
    links,
    manifest,
    warnings,
    refusals,
    unchanged: writes.length === 0 && links.length === 0 && manifestWrite === undefined,
  };
  return manifestWrite === undefined ? plan : { ...plan, manifestWrite };
}

// ------------------------------------------------------------------ uninstall

export interface UninstallInput {
  readonly packs: readonly string[];
  readonly templates: readonly DiskTemplate[];
  readonly manifest: PackManifest;
  readonly templatesDir: string;
  readonly home: string;
  /** Basenames of the directories that exist under `<home>/hc/packs`, as read by the caller. */
  readonly existingPackDirs: readonly string[];
  readonly prune: boolean;
}

export interface PlannedRemove {
  readonly path: string;
  /** `template` is a `.md`, `pack` is a whole `<name>@<version>/` directory. */
  readonly kind: "template" | "pack";
}

export interface KeptFile {
  readonly path: string;
  /** Why it stayed: `foreign`, `owned_by <pack>`, `missing`, `moved`, or a pruned-directory hint. */
  readonly reason: string;
}

export interface UninstallPlan {
  readonly removes: readonly PlannedRemove[];
  readonly keeps: readonly KeptFile[];
  readonly manifest: PackManifest;
  readonly manifestWrite?: PlannedWrite;
  readonly refusals: readonly Refusal[];
  readonly unchanged: boolean;
}

export function planUninstall(input: UninstallInput): UninstallPlan {
  const refusals: Refusal[] = [];
  const removes: PlannedRemove[] = [];
  const keeps: KeptFile[] = [];
  const nextPacks: Record<string, PackManifestPack> = { ...input.manifest.packs };

  for (const name of input.packs) {
    const entry = nextPacks[name];
    if (entry === undefined) {
      refusals.push({ code: "pack_unknown", message: `pack "${name}" is not installed` });
      continue;
    }
    delete nextPacks[name];
    for (const [templateName, template] of Object.entries(entry.templates)) {
      // The recorded path is authoritative: uninstalling under a different `--dir` must not reach
      // into a directory this pack never wrote. A moved file is reported, never guessed at.
      const expected = join(input.templatesDir, `${templateName}.md`);
      if (resolve(template.file) !== resolve(expected)) {
        keeps.push({ path: template.file, reason: `moved (not ${expected})` });
        continue;
      }
      const disk = input.templates.find((candidate) => candidate.name === templateName);
      if (disk === undefined) {
        keeps.push({ path: expected, reason: "missing" });
        continue;
      }
      const marker = parseTemplate(disk.content).pack;
      if (marker === undefined) {
        keeps.push({ path: expected, reason: "not an argos pack template" });
        continue;
      }
      if (marker.name !== name) {
        keeps.push({ path: expected, reason: `owned by pack "${marker.name}"` });
        continue;
      }
      removes.push({ path: expected, kind: "template" });
    }
  }

  if (refusals.length > 0) {
    return {
      removes: [],
      keeps: [],
      manifest: input.manifest,
      refusals,
      unchanged: false,
    };
  }

  const manifest = sortedPacks(nextPacks);
  const referenced = new Set(
    Object.values(manifest.packs).map((entry) => dirname(entry.program).split(/[\\/]/).at(-1) ?? ""),
  );
  // Prune is scoped to the packs the operator named: a stray `<pack>@<version>` directory of a
  // pack still installed is never touched, and a directory Argos does not name
  // (`<pack>@<version>`) is never ours to delete.
  const removedPacks = new Set(input.packs);
  const unreferenced = input.existingPackDirs
    .filter(
      (dir) =>
        PACK_DIR_RULE.test(dir) &&
        !referenced.has(dir) &&
        removedPacks.has(dir.slice(0, dir.indexOf("@"))),
    )
    .sort();
  for (const dir of unreferenced) {
    const path = join(packsRoot(input.home), dir);
    if (input.prune) removes.push({ path, kind: "pack" });
    else keeps.push({ path, reason: "program dir (pass --prune to remove)" });
  }

  const text = serializeManifest(manifest);
  const manifestWrite: PlannedWrite | undefined =
    text === serializeManifest(input.manifest)
      ? undefined
      : { path: manifestPath(input.home), content: text, mode: 0o600 };
  const plan: UninstallPlan = {
    removes,
    keeps,
    manifest,
    refusals,
    unchanged: removes.length === 0 && manifestWrite === undefined,
  };
  return manifestWrite === undefined ? plan : { ...plan, manifestWrite };
}
