import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";
import type { ZodError, ZodType } from "zod";

import { argosError, type ArgosIssue } from "../errors.js";
import { expandPlaybook } from "./expand.js";
import { canonicalJson, playbookHash } from "./hash.js";
import type { PlaybookIR, RoleIR, UnhashedPlaybookIR } from "./ir.js";
import { deepFreeze, toPlainJson } from "./ir.js";
import {
  resolvePlaybook,
  type LoadWarning,
  type LoadedDefaults,
  type LoadedRole,
  type PlaybookOrigin,
  type ResolveContext,
  type WarningSink,
} from "./resolve.js";
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
  /** `$ARGOS_HOME`; adds `<home>/playbooks`, `<home>/roles`, `<home>/defaults/main.yaml`, `<home>/scripts`. Roles resolve root-local (FR8). */
  readonly home?: string;
  /**
   * Optional warnings sink (FR7.4). Warnings never change the IR or its hash; omitting the sink
   * keeps the loader silent and byte-identical.
   */
  readonly warnings?: LoadWarning[];
}

/** `argos validate` and other callers import the warning shape from here. */
export type { LoadWarning, PlaybookOrigin, WarningCode, WarningSink } from "./resolve.js";

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

/** Discover every playbook under one family's roots; the first root wins (FR6). */
function collectPlaybooks(roots: readonly Root[]): Map<string, PlaybookEntry> {
  const byId = new Map<string, PlaybookEntry>();
  for (const root of roots) {
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
  return byId;
}

function sortedPlaybooks(byId: ReadonlyMap<string, PlaybookEntry>): PlaybookEntry[] {
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Discover every playbook under both roots and the optional home; the first root wins (FR6). */
export function discoverPlaybooks(repoDir: string, home?: string): PlaybookEntry[] {
  return sortedPlaybooks(collectPlaybooks(rootsFor(repoDir, PLAYBOOK_DIRS, home, HOME_PLAYBOOK_DIR)));
}

/** The playbooks of one family only: repository roots, or `<home>/playbooks` (FR8.4). */
function familyPlaybooks(repoDir: string, home: string | undefined, family: RoleFamily): Map<string, PlaybookEntry> {
  return family === "home"
    ? collectPlaybooks(homeRoot(home, HOME_PLAYBOOK_DIR))
    : collectPlaybooks(repoRoots(absolute(repoDir), PLAYBOOK_DIRS));
}

/** Discover role directories under one family's roots; the first root wins (FR6). */
function collectRoles(roots: readonly Root[]): Map<string, RoleEntry> {
  const byId = new Map<string, RoleEntry>();
  for (const root of roots) {
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
  return byId;
}

/** Discover roles: `<root>/<id>/role.yaml` plus optional `instructions.md` (FR6). */
export function discoverRoles(repoDir: string, home?: string): RoleEntry[] {
  const byId = collectRoles(rootsFor(repoDir, ROLE_DIRS, home, HOME_ROLE_DIR));
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

/** Every schema issue is reported, up to this many (FR1.4). */
const MAX_SCHEMA_ISSUES = 20;

/**
 * Where a file came from (FR1.3). A file under `$ARGOS_HOME` is `home`, a file under
 * `.paseo/plugins/playbooks/` is upstream `paseo`, everything else is a repository `argos` file.
 */
function originOf(file: string, home: string | undefined): PlaybookOrigin {
  const absoluteFile = absolute(file).split(sep).join("/");
  if (home !== undefined) {
    const homeRoot = absolute(home).split(sep).join("/").replace(/\/+$/, "");
    if (absoluteFile === homeRoot || absoluteFile.startsWith(`${homeRoot}/`)) return "home";
  }
  return absoluteFile.includes("/.paseo/plugins/playbooks/") ? "paseo" : "argos";
}

/**
 * Flatten zod issues into one entry per problem (FR1.4): an `unrecognized_keys` issue becomes one
 * entry per key, so `argos validate` can name each typo. Capped at {@link MAX_SCHEMA_ISSUES}.
 */
function collectIssues(
  error: ZodError,
  document: unknown,
  fallbackStepId: string | undefined,
): ArgosIssue[] {
  const issues: ArgosIssue[] = [];
  const seen = new Set<string>();
  const push = (path: string, stepId: string | undefined, message: string): boolean => {
    const key = `${path}\u0000${stepId ?? ""}\u0000${message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    issues.push({
      path: path === "" ? "(root)" : path,
      ...(stepId === undefined ? {} : { stepId }),
      message,
    });
    return issues.length >= MAX_SCHEMA_ISSUES;
  };
  for (const issue of error.issues) {
    const base = issue.path.map((part) => String(part)).join(".");
    const located = fallbackStepId ?? stepIdAtPath(document, issue.path);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = base === "" ? key : `${base}.${key}`;
        if (push(path, located, `unrecognized key "${key}"`)) return issues;
      }
      continue;
    }
    if (push(base, located, issue.message)) return issues;
  }
  return issues;
}

/** A failure whose only findings are unknown keys (the `.paseo/` warning case, FR1.3). */
function onlyUnknownKeys(error: ZodError): boolean {
  return error.issues.every((issue) => issue.code === "unrecognized_keys");
}

/** Drop the keys the schema rejected so the document can be parsed again (FR1.3). */
function withoutUnknownKeys(value: unknown, error: ZodError): unknown {
  const clone = structuredClone(value) as unknown;
  for (const issue of error.issues) {
    if (issue.code !== "unrecognized_keys") continue;
    let target: unknown = clone;
    for (const part of issue.path) {
      target = (target as Record<PropertyKey, unknown> | null | undefined)?.[part];
    }
    if (target === null || typeof target !== "object") continue;
    for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
  }
  return clone;
}

function schemaError(file: string, issues: readonly ArgosIssue[]): Error {
  const first = issues[0];
  return argosError(
    "playbook_invalid",
    { file, ...(first?.stepId === undefined ? {} : { stepId: first.stepId }) },
    `${first?.path ?? "(root)"}: ${first?.message ?? "invalid playbook"}`,
    undefined,
    { issues },
  );
}

interface ParseOptions {
  readonly file: string;
  readonly origin: PlaybookOrigin;
  readonly warn: WarningSink | undefined;
  readonly stepId?: string;
}

/**
 * Parse one document, reporting every issue (FR1.4). A `.paseo/` file whose *only* problems are
 * unknown keys keeps loading: one `unknown_key` warning per key, and the keys are removed from a
 * clone before the second parse (FR1.3). Any other issue still fails, with every issue attached.
 */
function parseSchema<T>(schema: ZodType<T>, value: unknown, options: ParseOptions): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = collectIssues(result.error, value, options.stepId);
  if (options.origin === "paseo" && onlyUnknownKeys(result.error)) {
    const retry = schema.safeParse(withoutUnknownKeys(value, result.error));
    if (retry.success) {
      for (const issue of issues) {
        options.warn?.({
          file: options.file,
          stepId: issue.stepId ?? null,
          code: "unknown_key",
          message: issue.message,
        });
      }
      return retry.data;
    }
  }
  throw schemaError(options.file, issues);
}

function loadDefaults(
  repoDir: string,
  home: string | undefined,
  warn: WarningSink | undefined,
): LoadedDefaults | undefined {
  const file = defaultsFile(repoDir, home);
  if (file === undefined) return undefined;
  const raw = parseSchema(RawDefaultsSchema, parseFile(file, repoDir), {
    file,
    origin: originOf(file, home),
    warn,
  });
  return { file, raw };
}

/**
 * A playbook's root family (FR8.1): a file under `$ARGOS_HOME` is `home`, everything else
 * (`.argos/` and the paseo fallback) is the repository family.
 */
type RoleFamily = "repo" | "home";

interface LoadContext {
  readonly repoDir: string;
  /** `$ARGOS_HOME`, when the caller passed one; every home root is searched last. */
  readonly home: string | undefined;
  readonly defaults: LoadedDefaults | undefined;
  /** Roles per family: a playbook searches its own family first, then the other (FR8.1). */
  readonly roleIndexes: Readonly<Record<RoleFamily, ReadonlyMap<string, RoleEntry>>>;
  /** Loaded roles cached by `family:id`. */
  readonly roles: Map<string, LoadedRole>;
  /** `playbookId\0roleId` -> the role file that playbook resolved (FR8.3 messages). */
  readonly roleSources: Map<string, string>;
  /** Role ids already reported as `role_shadowed`, so one load warns once (FR8.4). */
  readonly shadowWarned: Set<string>;
  readonly warn: WarningSink | undefined;
}

/** The family of one playbook file (FR8.2). */
function familyOf(file: string, home: string | undefined): RoleFamily {
  return originOf(file, home) === "home" ? "home" : "repo";
}

function otherFamily(family: RoleFamily): RoleFamily {
  return family === "repo" ? "home" : "repo";
}

/** Read and cache one role file, keyed by family so both copies can be compared (FR8.3/FR8.4). */
function loadRole(
  ctx: LoadContext,
  family: RoleFamily,
  entry: RoleEntry,
  stepId: string,
): LoadedRole {
  const key = `${family}:${entry.id}`;
  const cached = ctx.roles.get(key);
  if (cached !== undefined) return cached;
  const raw = parseSchema(RawRoleFileSchema, parseFile(entry.roleFile, ctx.repoDir), {
    file: entry.roleFile,
    origin: originOf(entry.roleFile, ctx.home),
    warn: ctx.warn,
    stepId,
  });
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
  const role: LoadedRole = { id: entry.id, raw, instructions };
  ctx.roles.set(key, role);
  return role;
}

/**
 * FR8.1: a playbook resolves a role id from its own family first and falls back to the other.
 * FR8.4: when both families define the id and the content differs, warn once (`role_shadowed`);
 * identical content is silent (the two copies are interchangeable).
 */
function roleLoader(
  ctx: LoadContext,
  family: RoleFamily,
  playbookId: string,
): (id: string, stepId: string) => LoadedRole | undefined {
  return (id, stepId) => {
    const own = ctx.roleIndexes[family].get(id);
    const foreign = ctx.roleIndexes[otherFamily(family)].get(id);
    if (own === undefined && foreign === undefined) return undefined;
    const winner = own ?? foreign;
    if (winner === undefined) return undefined;
    ctx.roleSources.set(`${playbookId}\u0000${id}`, winner.roleFile);
    if (own !== undefined && foreign !== undefined && ctx.warn !== undefined && !ctx.shadowWarned.has(id)) {
      const ownRole = loadRole(ctx, family, own, stepId);
      const foreignRole = loadRole(ctx, otherFamily(family), foreign, stepId);
      ctx.shadowWarned.add(id);
      if (canonicalJson(ownRole) !== canonicalJson(foreignRole)) {
        const repoFile = family === "repo" ? own.roleFile : foreign.roleFile;
        const homeFile = family === "home" ? own.roleFile : foreign.roleFile;
        ctx.warn({
          file: winner.roleFile,
          stepId: null,
          code: "role_shadowed",
          message: `role "${id}" differs between the repository copy (${repoFile}) and the home copy (${homeFile}); a ${family} playbook uses ${winner.roleFile}`,
        });
      }
    }
    return loadRole(ctx, own !== undefined ? family : otherFamily(family), winner, stepId);
  };
}

/**
 * Find the playbook to load. FR8.4: when the id exists in both families, a repository file wins
 * and — only with a warnings sink — the shadowed home copy is reported.
 */
function resolveEntry(
  repoDir: string,
  id: string,
  options: LoadOptions,
  home: string | undefined,
  warn: WarningSink | undefined,
): PlaybookEntry {
  if (options.file !== undefined) {
    const file = isAbsolute(options.file) ? options.file : resolve(repoDir, options.file);
    return { id, file, root: "" };
  }
  const found = discoverPlaybooks(repoDir, home).find((entry) => entry.id === id);
  if (found === undefined) {
    const searched = searchedPlaybookDirs(repoDir, home).join(", ");
    throw argosError(
      "playbook_missing",
      {},
      `unknown playbook "${id}" in ${absolute(repoDir)} (looked in ${searched})`,
    );
  }
  if (warn !== undefined) {
    const shadowed = familyPlaybooks(repoDir, home, "home").get(id);
    if (shadowed !== undefined && shadowed.file !== found.file) {
      warn({
        file: found.file,
        stepId: null,
        code: "playbook_shadowed",
        message: `playbook "${id}" is defined in both ${shadowed.file} and ${found.file}; ${found.file} wins`,
      });
    }
  }
  return found;
}

function build(
  ctx: LoadContext,
  id: string,
  file: string,
  stack: readonly string[],
  depth: number,
  family: RoleFamily,
): UnhashedPlaybookIR {
  const document = parseFile(file, ctx.repoDir);
  const origin = originOf(file, ctx.home);
  const raw = parseSchema(RawPlaybookSchema, document, { file, origin, warn: ctx.warn });
  const referencedRoles = new Map<string, RoleIR>();
  const context: ResolveContext = {
    file,
    playbookId: id,
    getRole: roleLoader(ctx, family, id),
    ...(ctx.defaults === undefined ? {} : { defaults: ctx.defaults }),
    referencedRoles,
    origin,
    ...(ctx.warn === undefined ? {} : { warn: ctx.warn }),
  };
  const resolved = resolvePlaybook(raw, context);
  const expanded = expandPlaybook(resolved, {
    file,
    stack,
    depth,
    roleSource: (playbookId, roleId) => ctx.roleSources.get(`${playbookId}\u0000${roleId}`),
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
      // Each sub-playbook keeps the family of its own file (FR8.2).
      return build(
        ctx,
        playbookId,
        entry.file,
        [...stack, playbookId],
        depth + 1,
        familyOf(entry.file, ctx.home),
      );
    },
  });
  validatePlaybook(expanded, file);
  return expanded;
}

/**
 * Load, normalize, expand, validate, and freeze one playbook (FR6–FR12).
 * Read-only: nothing below the repo (or the home) is ever written. `home` only widens discovery:
 * `<home>/playbooks`, `<home>/roles`, and `<home>/defaults/main.yaml` are also discovered, so an
 * existing test or caller that omits it stays repo-only. Roles are root-local (FR8): a home
 * playbook resolves `<home>/roles` first and a repository playbook the repository roots first, so
 * a global playbook keeps its global roles.
 * `warnings` is an optional sink (FR7): a `.paseo/` file with unknown keys loads and warns, and
 * alias conflicts are reported — the IR and its hash never depend on whether it is passed.
 */
export function loadPlaybook(repoDir: string, id: string, options: LoadOptions = {}): PlaybookIR {
  const base = absolute(repoDir);
  const home = options.home === undefined ? undefined : resolve(options.home);
  const sink = options.warnings;
  const warn: WarningSink | undefined =
    sink === undefined ? undefined : (warning) => sink.push(warning);
  const entry = resolveEntry(base, id, options, home, warn);
  const ctx: LoadContext = {
    repoDir: base,
    home,
    defaults: loadDefaults(repoDir, home, warn),
    roleIndexes: {
      repo: collectRoles(repoRoots(base, ROLE_DIRS)),
      home: collectRoles(homeRoot(home, HOME_ROLE_DIR)),
    },
    roles: new Map(),
    roleSources: new Map(),
    shadowWarned: new Set(),
    warn,
  };
  const book = build(ctx, id, entry.file, [id], 0, familyOf(entry.file, home));
  const hash = playbookHash(book);
  const ir: PlaybookIR = { ...book, hash };
  return deepFreeze(toPlainJson(ir));
}
