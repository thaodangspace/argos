import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";

import { argosError } from "../errors.js";
import { expandPlaybook } from "./expand.js";
import { playbookHash } from "./hash.js";
import type { PlaybookIR, RoleIR, UnhashedPlaybookIR } from "./ir.js";
import { deepFreeze, toPlainJson } from "./ir.js";
import { resolvePlaybook, type LoadedDefaults, type LoadedRole, type ResolveContext } from "./resolve.js";
import { RawPlaybookSchema, RawRoleFileSchema, RawDefaultsSchema, stepIdAtPath } from "./schema.js";
import { validatePlaybook } from "./validate.js";

/** Playbook roots, in precedence order (FR6). */
export const PLAYBOOK_DIRS = [".argos/playbooks", ".paseo/plugins/playbooks"] as const;
/** Role roots, in precedence order (FR6). */
export const ROLE_DIRS = [".argos/roles", ".paseo/plugins/playbooks/roles"] as const;
/** Defaults files, in precedence order (FR6). */
export const DEFAULTS_FILES = [".argos/defaults/main.yaml", ".paseo/plugins/playbooks/defaults/main.yaml"] as const;
/** Script roots, in precedence order (FR6). */
export const SCRIPT_DIRS = [".argos/scripts", ".paseo/plugins/playbooks/scripts"] as const;

/**
 * Workflow roots inside `$ARGOS_HOME`, searched **after** both repository roots so a project copy
 * always wins an id collision. The home mirrors `.argos`, not the Paseo fallback.
 */
export const HOME_PLAYBOOK_DIR = "playbooks";
export const HOME_ROLE_DIR = "roles";
export const HOME_DEFAULTS_FILE = "defaults/main.yaml";
export const HOME_SCRIPT_DIR = "scripts";

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

export interface PlaybookEntry {
  readonly id: string;
  readonly file: string;
  /** Repo-relative directory the file was found in, or the absolute home root. */
  readonly root: string;
}

export interface RoleEntry {
  readonly id: string;
  readonly dir: string;
  readonly roleFile: string;
  readonly instructionsFile: string;
}

export interface ScriptEntry {
  readonly name: string;
  readonly file: string;
  readonly root: string;
}

export interface LoadOptions {
  /** Load this exact file instead of resolving the id (for `argos validate <path>`). */
  readonly file?: string;
  /** `$ARGOS_HOME`; adds `<home>/playbooks`, `<home>/roles`, `<home>/defaults/main.yaml` last. */
  readonly home?: string;
}

function absolute(repoDir: string): string {
  return resolve(repoDir);
}

/** One discovery root: the absolute directory plus the label entries and messages use. */
interface Root {
  readonly dir: string;
  readonly label: string;
}

/** The repository roots for one workflow kind, in precedence order. */
function repoRoots(base: string, roots: readonly string[]): Root[] {
  return roots.map((root) => ({ dir: join(base, root), label: root }));
}

/**
 * The optional home root for one workflow kind, appended last. A missing home directory is simply
 * skipped by the `readdirSync` below, exactly like a missing repository directory.
 */
function homeRoot(home: string | undefined, sub: string): Root[] {
  if (home === undefined) return [];
  const dir = join(resolve(home), sub);
  return [{ dir, label: dir }];
}

function rootsFor(
  repoDir: string,
  roots: readonly string[],
  home: string | undefined,
  sub: string,
): Root[] {
  return [...repoRoots(absolute(repoDir), roots), ...homeRoot(home, sub)];
}

/** Every directory a playbook id is looked in, for `playbook_missing` messages. */
function searchedPlaybookDirs(repoDir: string, home: string | undefined): string[] {
  return rootsFor(repoDir, PLAYBOOK_DIRS, home, HOME_PLAYBOOK_DIR).map((root) => root.label);
}

/** Discover every playbook under both roots and the optional home; the first root wins (FR6). */
export function discoverPlaybooks(repoDir: string, home?: string): PlaybookEntry[] {
  const byId = new Map<string, PlaybookEntry>();
  for (const root of rootsFor(repoDir, PLAYBOOK_DIRS, home, HOME_PLAYBOOK_DIR)) {
    let entries;
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!YAML_EXTENSIONS.has(extname(entry.name))) continue;
      const id = basename(entry.name, extname(entry.name));
      if (byId.has(id)) continue;
      byId.set(id, { id, file: join(root.dir, entry.name), root: root.label });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Discover roles: `<root>/<id>/role.yaml` plus optional `instructions.md` (FR6). */
export function discoverRoles(repoDir: string, home?: string): RoleEntry[] {
  const byId = new Map<string, RoleEntry>();
  for (const root of rootsFor(repoDir, ROLE_DIRS, home, HOME_ROLE_DIR)) {
    let entries;
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const roleDir = join(root.dir, entry.name);
      const roleFile = join(roleDir, "role.yaml");
      if (!existsSync(roleFile)) continue;
      if (byId.has(entry.name)) continue;
      byId.set(entry.name, {
        id: entry.name,
        dir: roleDir,
        roleFile,
        instructionsFile: join(roleDir, "instructions.md"),
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Discover script executables; names are file names (FR6/FR22). */
export function discoverScripts(repoDir: string, home?: string): ScriptEntry[] {
  const byName = new Map<string, ScriptEntry>();
  for (const root of rootsFor(repoDir, SCRIPT_DIRS, home, HOME_SCRIPT_DIR)) {
    let entries;
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (byName.has(entry.name)) continue;
      byName.set(entry.name, {
        name: entry.name,
        file: join(root.dir, entry.name),
        root: root.label,
      });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Find the defaults file, if any. The repo copies win; `<home>/defaults/main.yaml` is last. */
export function defaultsFile(repoDir: string, home?: string): string | undefined {
  const base = absolute(repoDir);
  for (const relative of DEFAULTS_FILES) {
    const file = join(base, relative);
    if (existsSync(file)) return file;
  }
  if (home === undefined) return undefined;
  const file = join(resolve(home), HOME_DEFAULTS_FILE);
  return existsSync(file) ? file : undefined;
}

function parseFile(file: string, repoDir: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw argosError(
      "playbook_missing",
      { file },
      `cannot read ${relativeTo(repoDir, file)}: ${(error as Error).message}`,
      error,
    );
  }
  try {
    return parseYaml(text) ?? {};
  } catch (error) {
    throw argosError(
      "playbook_invalid",
      { file },
      `invalid YAML: ${(error as Error).message}`,
      error,
    );
  }
}

function relativeTo(repoDir: string, file: string): string {
  return relative(absolute(repoDir), file);
}

function parseSchema<T>(
  schema: ZodType<T>,
  value: unknown,
  file: string,
  stepId?: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path ?? [];
  const located = stepId ?? stepIdAtPath(value, path);
  const where = path.length > 0 ? path.map((part) => String(part)).join(".") : "(root)";
  throw argosError(
    "playbook_invalid",
    { file, ...(located === undefined ? {} : { stepId: located }) },
    `${where}: ${issue?.message ?? "invalid playbook"}`,
  );
}

function loadDefaults(repoDir: string, home: string | undefined): LoadedDefaults | undefined {
  const file = defaultsFile(repoDir, home);
  if (file === undefined) return undefined;
  const raw = parseSchema(RawDefaultsSchema, parseFile(file, repoDir), file);
  return { file, raw };
}

interface LoadContext {
  readonly repoDir: string;
  /** `$ARGOS_HOME`, when the caller passed one; every home root is searched last. */
  readonly home: string | undefined;
  readonly defaults: LoadedDefaults | undefined;
  readonly roleIndex: ReadonlyMap<string, RoleEntry>;
  readonly roles: Map<string, LoadedRole | null>;
}

function roleLoader(ctx: LoadContext): (id: string, stepId: string) => LoadedRole | undefined {
  return (id, stepId) => {
    const cached = ctx.roles.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const entry = ctx.roleIndex.get(id);
    if (entry === undefined) {
      ctx.roles.set(id, null);
      return undefined;
    }
    const raw = parseSchema(RawRoleFileSchema, parseFile(entry.roleFile, ctx.repoDir), entry.roleFile, stepId);
    let instructions = "";
    if (existsSync(entry.instructionsFile)) {
      try {
        instructions = readFileSync(entry.instructionsFile, "utf8");
      } catch (error) {
        throw argosError(
          "playbook_invalid",
          { file: entry.instructionsFile, stepId },
          `cannot read role instructions: ${(error as Error).message}`,
          error,
        );
      }
    }
    const role: LoadedRole = { id, raw, instructions };
    ctx.roles.set(id, role);
    return role;
  };
}

function resolveEntry(repoDir: string, id: string, options: LoadOptions): PlaybookEntry {
  if (options.file !== undefined) {
    const file = isAbsolute(options.file) ? options.file : resolve(repoDir, options.file);
    return { id, file, root: "" };
  }
  const found = discoverPlaybooks(repoDir, options.home).find((entry) => entry.id === id);
  if (found === undefined) {
    const searched = searchedPlaybookDirs(repoDir, options.home).join(", ");
    throw argosError(
      "playbook_missing",
      {},
      `unknown playbook "${id}" in ${absolute(repoDir)} (looked in ${searched})`,
    );
  }
  return found;
}

function build(
  ctx: LoadContext,
  id: string,
  file: string,
  stack: readonly string[],
  depth: number,
): UnhashedPlaybookIR {
  const document = parseFile(file, ctx.repoDir);
  const raw = parseSchema(RawPlaybookSchema, document, file);
  const referencedRoles = new Map<string, RoleIR>();
  const context: ResolveContext = {
    file,
    playbookId: id,
    getRole: roleLoader(ctx),
    ...(ctx.defaults === undefined ? {} : { defaults: ctx.defaults }),
    referencedRoles,
  };
  const resolved = resolvePlaybook(raw, context);
  const expanded = expandPlaybook(resolved, {
    file,
    stack,
    depth,
    loadSub: (playbookId, location) => {
      const entry = discoverPlaybooks(ctx.repoDir, ctx.home).find(
        (candidate) => candidate.id === playbookId,
      );
      if (entry === undefined) {
        const searched = searchedPlaybookDirs(ctx.repoDir, ctx.home).join(", ");
        throw argosError(
          "playbook_missing",
          { file: location.file, stepId: location.stepId },
          `unknown sub-playbook "${playbookId}" (no ${playbookId}.yaml under ${searched})`,
        );
      }
      return build(ctx, playbookId, entry.file, [...stack, playbookId], depth + 1);
    },
  });
  validatePlaybook(expanded, file);
  return expanded;
}

/**
 * Load, normalize, expand, validate, and freeze one playbook (FR6–FR12).
 * Read-only: nothing below the repo (or the home) is ever written. `home` only widens discovery:
 * `<home>/playbooks`, `<home>/roles`, and `<home>/defaults/main.yaml` are searched after the
 * repository roots, so an existing test or caller that omits it stays repo-only.
 */
export function loadPlaybook(repoDir: string, id: string, options: LoadOptions = {}): PlaybookIR {
  const entry = resolveEntry(repoDir, id, options);
  const base = absolute(repoDir);
  const home = options.home === undefined ? undefined : resolve(options.home);
  const ctx: LoadContext = {
    repoDir: base,
    home,
    defaults: loadDefaults(repoDir, home),
    roleIndex: new Map(discoverRoles(repoDir, home).map((role) => [role.id, role] as const)),
    roles: new Map(),
  };
  const book = build(ctx, id, entry.file, [id], 0);
  const hash = playbookHash(book);
  const ir: PlaybookIR = { ...book, hash };
  return deepFreeze(toPlainJson(ir));
}
