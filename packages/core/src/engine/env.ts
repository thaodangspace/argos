/**
 * D10/FR2: the environment a script step is allowed to inherit (NFR "Security").
 *
 * A script step runs repository code, so it is deny-by-default: it sees only the baseline names a
 * program needs to start (an interpreter, a home, a locale, a temp directory, the Windows basics)
 * plus the names the step's `env:` list grants. Everything else — including every name that merely
 * *looks* like a credential — is absent. A hard deny list on top of that keeps Argos' own
 * configuration (the Paseo password, the home, the port) out of a child process even when a
 * playbook names it.
 *
 * The functions are pure: they read nothing (no environment of their own, no clock, no filesystem)
 * and return a fresh object with **sorted keys**, so a checkpoint, a log line, or a test compares
 * byte-for-byte across runs and machines.
 *
 * Baseline names match case-insensitively because Windows spells them `Path`/`SystemRoot`;
 * granted names match exactly, because that is the name the playbook and the child process agree
 * on. A grant is an exact name, `PREFIX_*` (a literal prefix ending in `_`), or `"*"` (the old
 * inherit-everything-that-is-not-secret behavior).
 */

/** A name that looks like a credential. Used by the env filter *and* by git error redaction. */
export const SECRET_ENV_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Names a script always inherits when present (FR2.1): the POSIX basics a process cannot start
 * without, the locale/timezone/session spellings, and the Windows basics. `LC_*` is handled as a
 * prefix (see {@link SCRIPT_ENV_BASELINE_PREFIXES}); everything else here is an exact name.
 */
export const SCRIPT_ENV_BASELINE = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "PATHEXT",
  "COMSPEC",
] as const;

/** Baseline prefixes (FR2.1): `LC_ALL`, `LC_CTYPE`, … follow the locale, not the playbook. */
export const SCRIPT_ENV_BASELINE_PREFIXES = ["LC_"] as const;

/**
 * FR2.4: never passed to a script, even when a playbook grants one exactly. Every name here is
 * configuration the `argos serve` process reads for itself, so a child must not see it (the Paseo
 * password is a credential; the rest describe Argos' own state under `$ARGOS_HOME`).
 */
export const SCRIPT_ENV_DENY = [
  "ARGOS_PASEO_PASSWORD",
  "ARGOS_HOME",
  "ARGOS_PORT",
  "ARGOS_PASEO_URL",
  "ARGOS_FAKE_PASEO",
  "ARGOS_FAKE_PASEO_DIR",
  "ARGOS_FAKE_PASEO_BLOCK_STEP",
  "ARGOS_FAKE_PASEO_RELEASE_FILE",
] as const;

const BASELINE_NAMES: ReadonlySet<string> = new Set(
  SCRIPT_ENV_BASELINE.map((name) => name.toUpperCase()),
);
const DENIED_NAMES: ReadonlySet<string> = new Set(
  SCRIPT_ENV_DENY.map((name) => name.toUpperCase()),
);

/** An exact variable name: a letter or `_`, then letters, digits, or `_`. */
const EXACT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A grant prefix: `[A-Za-z0-9_]` characters ending in `_` (so `ARGOS_*` grants `ARGOS_` + rest). */
const ENV_NAME_PREFIX = /^[A-Za-z0-9_]+_$/;

/**
 * One parsed `env:` grant (FR2.2).
 *
 * - `exact` — one name, including a secret-looking one (the playbook asked for it by name).
 * - `prefix` — names that start with `prefix` and do not match {@link SECRET_ENV_NAME_PATTERN}.
 * - `all` — `"*"`: every name except the secret-looking ones and the deny list (the old behavior).
 */
export type EnvGrant =
  | { readonly kind: "all" }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "exact"; readonly name: string };

/**
 * Parse one `env:` entry (FR2.2/FR2.3). The loader calls this to reject a malformed entry with
 * `playbook_invalid`; the filter calls it to decide what reaches the child. Returns `undefined`
 * for anything that is not an exact name, a `PREFIX_*` grant, or `"*"` (`"FOO*"`, `"*_X"`,
 * `"A B"`, `""`, …), so the caller owns the error message.
 */
export function parseEnvGrant(entry: string): EnvGrant | undefined {
  if (entry === "*") return { kind: "all" };
  if (entry.endsWith("*")) {
    const prefix = entry.slice(0, -1);
    return ENV_NAME_PREFIX.test(prefix) ? { kind: "prefix", prefix } : undefined;
  }
  return EXACT_ENV_NAME.test(entry) ? { kind: "exact", name: entry } : undefined;
}

/** True when `name` matches the credential pattern (`MY_API_KEY`, `GITHUB_TOKEN`, …). */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

/** FR2.4: true when `name` is on the hard deny list (matched case-insensitively). */
export function isDeniedEnvName(name: string): boolean {
  return DENIED_NAMES.has(name.toUpperCase());
}

/** FR2.1: true when `name` is a baseline name (exact, case-insensitive) or an `LC_*` name. */
export function isBaselineEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (BASELINE_NAMES.has(upper)) return true;
  return SCRIPT_ENV_BASELINE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** True when a parsed grant lets `name` through (deny list checked by the caller, first). */
function grantsName(grant: EnvGrant, name: string): boolean {
  switch (grant.kind) {
    case "all":
      // The old behavior: everything except the credential-looking names (FR2.2).
      return !isSecretEnvName(name);
    case "exact":
      return grant.name === name;
    case "prefix":
      // A prefix grant is a category, so it never covers a credential-looking name (FR2.2).
      return name.startsWith(grant.prefix) && !isSecretEnvName(name);
  }
}

/**
 * Filter `env` down to what a script may see (FR2.1/FR2.4): baseline + granted, minus the deny
 * list.
 *
 * - {@link SCRIPT_ENV_BASELINE} names and `LC_*` are always kept when present.
 * - `grants` are the step's `env:` entries; {@link parseEnvGrant} decides what each one means. A
 *   malformed entry grants nothing (the loader rejects it before a run; the filter stays total).
 * - A {@link SCRIPT_ENV_DENY} name is dropped even when a grant names it exactly.
 * - A granted name the parent process does not define is simply absent (no error): the playbook
 *   asked for an optional credential, not for a failure.
 * - Non-string (i.e. `undefined`) values are dropped, so the result can be handed to `spawn`.
 */
export function filterScriptEnv(
  env: Readonly<Record<string, string | undefined>>,
  grants: readonly string[] = [],
): Record<string, string> {
  const parsed: EnvGrant[] = [];
  for (const entry of grants) {
    const grant = parseEnvGrant(entry);
    if (grant !== undefined) parsed.push(grant);
  }
  const kept: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || name === "") continue;
    if (isDeniedEnvName(name)) continue;
    const keep = isBaselineEnvName(name) || parsed.some((grant) => grantsName(grant, name));
    if (keep) kept.push([name, value]);
  }
  kept.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return Object.fromEntries(kept);
}
