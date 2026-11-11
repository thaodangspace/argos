/**
 * D10: the environment a script step is allowed to inherit (FR22, NFR "Security").
 *
 * A script step runs repository code, so it must not see the operator's whole environment.
 * Everything that *looks* like a credential is dropped unless the playbook names it explicitly in
 * the step's `env: [...]` allowlist. The four platform basics are always kept so an executable
 * can find its interpreter, its home, and a temp directory — dropping those would break every
 * script and is not what the filter is for.
 *
 * The function is pure: it reads nothing (no environment of its own, no clock, no filesystem) and
 * returns a fresh object with **sorted keys**, so a checkpoint, a log line, or a test compares
 * byte-for-byte across runs and machines.
 *
 * `TMP`, `TEMP`, and `SystemRoot` are the win32 basics; they are kept whenever they are present
 * (harmless on POSIX, where they are usually unset). Baseline names match case-insensitively
 * because Windows spells them `Path`/`SystemRoot`; declared names match exactly, because that is
 * the name the playbook and the child process agree on.
 */

/** A name that looks like a credential. Used by the env filter *and* by git error redaction. */
export const SECRET_ENV_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Names a script always inherits when present: `PATH`, `HOME`, `LANG`, `TMPDIR` (D10) plus the
 * win32 basics `TMP`, `TEMP`, `SystemRoot`.
 */
export const SCRIPT_ENV_BASELINE = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
] as const;

/** True when `name` matches the credential pattern (`MY_API_KEY`, `GITHUB_TOKEN`, …). */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

/**
 * Filter `env` down to what a script may see.
 *
 * - Keys matching {@link SECRET_ENV_NAME_PATTERN} are dropped unless `declared` lists them.
 * - {@link SCRIPT_ENV_BASELINE} keys are always kept when present.
 * - A declared key that the parent process does not define is simply absent (no error): the
 *   playbook asked for an optional credential, not for a failure.
 * - Non-string (i.e. `undefined`) values are dropped, so the result can be handed to `spawn`.
 */
export function filterScriptEnv(
  env: Readonly<Record<string, string | undefined>>,
  declared: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set(declared);
  const baseline = new Set<string>(SCRIPT_ENV_BASELINE.map((name) => name.toLowerCase()));
  const kept: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || name === "") continue;
    const keep =
      baseline.has(name.toLowerCase()) || allowed.has(name) || !isSecretEnvName(name);
    if (keep) kept.push([name, value]);
  }
  kept.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return Object.fromEntries(kept);
}
