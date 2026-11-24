/**
 * The hc template pack model (spec FR1–FR4; plan Phase 2).
 *
 * A pack is **data on disk**: `pack.json` (strict, so an operator's typo is never ignored), the
 * program named by `program.file`, and the `*.md` templates we generate from it. Nothing here
 * touches `node:fs` — the caller hands in file contents, which is what keeps `planInstall` pure and
 * `--dry-run` incapable of disagreeing with the real run.
 *
 * Every template we write carries one ownership signal in its frontmatter `description`:
 * `· argos-pack <name> <version>`. hc echoes name/description/command from `templates.list`, so the
 * marker is the only thing `list`, `uninstall`, and `doctor` can recognize after a machine was
 * rebuilt with a different Argos version.
 */

import { z } from "zod";

/** Template and pack name rule (FR3): lower-case, digits, `-`; 1–32 characters. */
export const PACK_NAME_RULE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The ownership marker's stable prefix. The whole line is `· argos-pack <name> <version>`. */
export const PACK_MARKER_PREFIX = "· argos-pack";

const NAME_MESSAGE = "must match ^[a-z0-9][a-z0-9-]{0,31}$";

/** A bare file name: the program sits beside `pack.json`, never above or below it (FR2). */
const BARE_FILE_NAME = z
  .string()
  .min(1)
  .refine(
    (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
    "must be a bare file name beside pack.json",
  );

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lower-case hex sha256");

/** One template a pack ships: its args, and the step budget authors should write. */
export const PackTemplateSchema = z.strictObject({
  name: z.string().regex(PACK_NAME_RULE, NAME_MESSAGE),
  args: z.string(),
  minStepTimeoutMs: z.number().int().min(1),
  description: z.string().optional(),
});
export type PackTemplate = z.infer<typeof PackTemplateSchema>;

/** `pack.json`: strict, because an operator writes packs and a typo must not be a silent no-op. */
export const PackSchema = z
  .strictObject({
    name: z.string().regex(PACK_NAME_RULE, NAME_MESSAGE),
    version: z.number().int().min(1),
    description: z.string().optional(),
    requires: z.strictObject({
      node: z.string().min(1),
      hcProtocol: z.number().int(),
      hc: z.string().optional(),
      claude: z.string().optional(),
    }),
    program: z.strictObject({ file: BARE_FILE_NAME, args: z.string().optional() }),
    templates: z.array(PackTemplateSchema).min(1),
  })
  .superRefine((pack, context) => {
    const seen = new Set<string>();
    pack.templates.forEach((template, index) => {
      if (seen.has(template.name)) {
        context.addIssue({
          code: "custom",
          path: ["templates", index, "name"],
          message: `duplicate template name "${template.name}"`,
        });
      }
      seen.add(template.name);
    });
  });
export type Pack = z.infer<typeof PackSchema>;

/** One installed template: where its `.md` lives and the step budget the pack declared. */
export const PackManifestTemplateSchema = z.strictObject({
  file: z.string().min(1),
  minStepTimeoutMs: z.number().int().min(1),
});
export type PackManifestTemplate = z.infer<typeof PackManifestTemplateSchema>;

/**
 * One installed pack. `program` is always the absolute destination path (the copy, or the symlink);
 * a copied pack carries `programSha256`, a `--link`ed one carries `link` instead (FR11).
 */
export const PackManifestPackSchema = z.strictObject({
  version: z.number().int().min(1),
  source: z.string().min(1),
  program: z.string().min(1),
  programSha256: SHA256.optional(),
  link: z.string().min(1).optional(),
  templates: z.record(z.string().regex(PACK_NAME_RULE, NAME_MESSAGE), PackManifestTemplateSchema),
});
export type PackManifestPack = z.infer<typeof PackManifestPackSchema>;

/** `$ARGOS_HOME/hc/packs.json` (D1). Argos-owned; hc never reads it, and it has no timestamps (D12). */
export const PackManifestSchema = z.strictObject({
  version: z.literal(1),
  packs: z.record(z.string().regex(PACK_NAME_RULE, NAME_MESSAGE), PackManifestPackSchema),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

export function emptyManifest(): PackManifest {
  return { version: 1, packs: {} };
}

/** Canonical bytes: two-space indent, insertion order, trailing LF. No timestamp, ever (D12). */
export function serializeManifest(manifest: PackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ------------------------------------------------------------------ failures

export interface PackIssue {
  /** `<file>` or `<file>:<field path>`, so an operator knows exactly which line to edit. */
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly PackIssue[] };

function toIssues(file: string, error: z.ZodError): PackIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? file : `${file}:${issue.path.map(String).join(".")}`,
    message: issue.message,
  }));
}

/** Validate `pack.json` text; an unknown key or a bad floor names the file and the field. */
export function parsePack(text: string, file: string): ParseResult<Pack> {
  return parseJsonWith(PackSchema, text, file, "pack.json");
}

/** Validate a manifest document; a hand-edited row is refused, never merged. */
export function parseManifest(text: string, file: string): ParseResult<PackManifest> {
  return parseJsonWith(PackManifestSchema, text, file, "packs.json");
}

function parseJsonWith<T>(
  schema: z.ZodType<T>,
  text: string,
  file: string,
  label: string,
): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: file, message: `${label} is not valid JSON: ${(error as Error).message}` }],
    };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: toIssues(file, parsed.error) };
}

// ------------------------------------------------------------------ the marker

export interface PackIdentity {
  readonly name: string;
  readonly version: number;
}

/** `· argos-pack claude 1` — the one ownership signal a template file carries. */
export function packMarker(pack: PackIdentity): string {
  return `${PACK_MARKER_PREFIX} ${pack.name} ${pack.version}`;
}

const MARKER_PATTERN = new RegExp(`${PACK_MARKER_PREFIX}\\s+([a-z0-9][a-z0-9-]{0,31})\\s+(\\d+)`);

/** The marker a description carries, or `undefined` when the file is not ours. */
export function markerOf(description: string | undefined): PackIdentity | undefined {
  if (description === undefined) return undefined;
  const match = MARKER_PATTERN.exec(description);
  if (match === null) return undefined;
  return { name: match[1] as string, version: Number.parseInt(match[2] as string, 10) };
}

// ------------------------------------------------------------------ templates

export interface RenderTemplateInput {
  readonly name: string;
  /** The author's sentence; the marker is appended by `renderTemplate`, never by a caller. */
  readonly description: string;
  readonly command: string;
  /** When given, the description gains the ownership marker (FR2). */
  readonly pack?: PackIdentity;
}

/**
 * A generated template (FR2): frontmatter `name`/`description`/`command`, empty body — hc sends a
 * template's body *with* the prompt, and our prompt is the whole task.
 *
 * `description` and `command` are written as YAML double-quoted scalars (JSON escaping is a YAML
 * subset), so a path that contains a quote, a space, or a `#` cannot silently break the document.
 */
export function renderTemplate(input: RenderTemplateInput): string {
  const description =
    input.pack === undefined
      ? input.description
      : input.description === ""
        ? packMarker(input.pack)
        : `${input.description} ${packMarker(input.pack)}`;
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(description)}`,
    `command: ${JSON.stringify(input.command)}`,
    "---",
    "",
  ].join("\n");
}

export interface ParsedTemplate {
  readonly name?: string;
  readonly description?: string;
  readonly command?: string;
  /** Everything after the closing `---` (empty for a generated template). */
  readonly body: string;
  /** `· argos-pack <name> <version>` when the description carries our marker. */
  readonly pack?: PackIdentity;
}

/** Parse a template's frontmatter. Never throws: a foreign file is data, not an error. */
export function parseTemplate(text: string): ParsedTemplate {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (match === null) return { body: text };
  const fields = new Map<string, string>();
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    fields.set(key, unquote(line.slice(colon + 1).trim()));
  }
  const description = fields.get("description");
  const pack = markerOf(description);
  const result: {
    name?: string;
    description?: string;
    command?: string;
    body: string;
    pack?: PackIdentity;
  } = { body: text.slice(match[0].length) };
  const name = fields.get("name");
  const command = fields.get("command");
  if (name !== undefined) result.name = name;
  if (description !== undefined) result.description = description;
  if (command !== undefined) result.command = command;
  if (pack !== undefined) result.pack = pack;
  return result;
}

/** One frontmatter scalar: a JSON double-quoted string, a YAML single-quoted one, or plain text. */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // A hand-written template may quote in a way JSON rejects; fall through to the raw text.
    }
    return raw.slice(1, -1);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}
