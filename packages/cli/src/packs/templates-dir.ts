/**
 * Where a pack installs to (spec FR10–FR12; plan D1/D2).
 *
 * Two directories, resolved in exactly one place so `install`, `list`, `uninstall`, and `doctor`
 * cannot disagree about them:
 *
 * | What | Path |
 * |---|---|
 * | templates hc reads | `--dir` → `$XDG_CONFIG_HOME/herdr-core/templates` → `~/.config/herdr-core/templates` |
 * | Argos' own state | `$ARGOS_HOME` → `~/.argos` (`hc/packs/<name>@<version>/`, `hc/packs.json`) |
 *
 * hc's own help names the literal `~/.config/herdr-core/templates`; honoring `XDG_CONFIG_HOME` is
 * the correct POSIX reading and `--dir` is the escape hatch, which is why the resolved path is
 * printed by every command that writes.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PackEnv = Readonly<Record<string, string | undefined>>;

/** A directory name Argos owns under `$ARGOS_HOME/hc/packs`: `<pack>@<version>`. */
export const PACK_DIR_RULE = /^[a-z0-9][a-z0-9-]{0,31}@\d+$/;

/** `$ARGOS_HOME`, defaulting to `~/.argos` (the same rule as core's `argosHome`, kept local). */
export function argosStateDir(env: PackEnv = process.env, home: string = homedir()): string {
  const override = env["ARGOS_HOME"];
  return override !== undefined && override.trim() !== ""
    ? resolve(override)
    : join(home, ".argos");
}

/** The herdr-core templates directory `hc` reads (D2). */
export function templatesDir(
  dir?: string,
  env: PackEnv = process.env,
  home: string = homedir(),
): string {
  if (dir !== undefined && dir.trim() !== "") return resolve(dir);
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(resolve(xdg), "herdr-core", "templates");
  }
  return join(home, ".config", "herdr-core", "templates");
}

/** `$ARGOS_HOME/hc/packs.json` — the manifest, in Argos' own state, never in hc's directory. */
export function manifestPath(home: string): string {
  return join(home, "hc", "packs.json");
}

/** `$ARGOS_HOME/hc/packs` — one `<name>@<version>/` directory per installed pack version. */
export function packsRoot(home: string): string {
  return join(home, "hc", "packs");
}

/** `<packsRoot>/<name>@<version>`: a version bump installs beside the old one, never over it. */
export function packInstallDir(home: string, name: string, version: number): string {
  return join(packsRoot(home), `${name}@${version}`);
}
