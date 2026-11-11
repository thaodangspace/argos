import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted at every depth, arrays kept in order, `undefined`
 * properties dropped (JSON semantics). Two loads of the same files always produce the same
 * string; the playbook hash is sha256 over it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

/** sha256 hex of the canonical JSON. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `playbookHash` (FR12): content hash of the IR, excluding the `hash` field itself. */
export function playbookHash(ir: object): string {
  const { hash: _ignored, ...rest } = ir as Record<string, unknown>;
  return sha256Hex(canonicalJson(rest));
}
