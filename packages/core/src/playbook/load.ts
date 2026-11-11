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

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

export interface PlaybookEntry {
  readonly id: string;
  readonly file: string;
  /** Repo-relative directory the file was found in. */
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
}

function absolute(repoDir: string): string {
  return resolve(repoDir);
}

/** Discover every playbook under both roots; `.argos` wins on an id collision (FR6). */
export function discoverPlaybooks(repoDir: string): PlaybookEntry[] {
  const base = absolute(repoDir);
  const byId = new Map<string, PlaybookEntry>();
  for (const root of PLAYBOOK_DIRS) {
    const dir = join(base, root);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!YAML_EXTENSIONS.has(extname(entry.name))) continue;
      const id = basename(entry.name, extname(entry.name));
      if (byId.has(id)) continue;
      byId.set(id, { id, file: join(dir, entry.name), root });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Discover roles: `<root>/<id>/role.yaml` plus optional `instructions.md` (FR6). */
export function discoverRoles(repoDir: string): RoleEntry[] {
  const base = absolute(repoDir);
  const byId = new Map<string, RoleEntry>();
  for (const root of ROLE_DIRS) {
    const dir = join(base, root);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const roleDir = join(dir, entry.name);
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
export function discoverScripts(repoDir: string): ScriptEntry[] {
  const base = absolute(repoDir);
  const byName = new Map<string, ScriptEntry>();
  for (const root of SCRIPT_DIRS) {
    const dir = join(base, root);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (byName.has(entry.name)) continue;
      byName.set(entry.name, { name: entry.name, file: join(dir, entry.name), root });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Find the defaults file, if any. `.argos/defaults/main.yaml` wins. */
export function defaultsFile(repoDir: string): string | undefined {
  const base = absolute(repoDir);
  for (const relative of DEFAULTS_FILES) {
    const file = join(base, relative);
    if (existsSync(file)) return file;
  }
  return undefined;
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

function loadDefaults(repoDir: string): LoadedDefaults | undefined {
  const file = defaultsFile(repoDir);
  if (file === undefined) return undefined;
  const raw = parseSchema(RawDefaultsSchema, parseFile(file, repoDir), file);
  return { file, raw };
}

interface LoadContext {
  readonly repoDir: string;
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
  const found = discoverPlaybooks(repoDir).find((entry) => entry.id === id);
  if (found === undefined) {
    throw argosError(
      "playbook_missing",
      {},
      `unknown playbook "${id}" in ${absolute(repoDir)} (looked in ${PLAYBOOK_DIRS.join(", ")})`,
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
      const entry = discoverPlaybooks(ctx.repoDir).find((candidate) => candidate.id === playbookId);
      if (entry === undefined) {
        throw argosError(
          "playbook_missing",
          { file: location.file, stepId: location.stepId },
          `unknown sub-playbook "${playbookId}" (no ${playbookId}.yaml under ${PLAYBOOK_DIRS.join(", ")})`,
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
 * Read-only: nothing below the repo is ever written.
 */
export function loadPlaybook(repoDir: string, id: string, options: LoadOptions = {}): PlaybookIR {
  const entry = resolveEntry(repoDir, id, options);
  const base = absolute(repoDir);
  const ctx: LoadContext = {
    repoDir: base,
    defaults: loadDefaults(repoDir),
    roleIndex: new Map(discoverRoles(repoDir).map((role) => [role.id, role] as const)),
    roles: new Map(),
  };
  const book = build(ctx, id, entry.file, [id], 0);
  const hash = playbookHash(book);
  const ir: PlaybookIR = { ...book, hash };
  return deepFreeze(toPlainJson(ir));
}
