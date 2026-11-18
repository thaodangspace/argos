/**
 * The UI directory `argos serve` must resolve, and the warning it must print when it is unusable
 * (spec FR1/FR18).
 *
 * Resolution order is `ARGOS_UI_DIR` → `<cli package root>/ui` (the directory the release copies
 * the SvelteKit build into). An explicitly empty value disables the UI, which is what the E2E suite
 * and an API-only operator want.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<cli package root>/ui` in both a dev checkout (`src/../ui`) and a published tarball (`dist/../ui`). */
export const DEFAULT_UI_DIR = fileURLToPath(new URL("../ui", import.meta.url));

/** The directory to serve, or `undefined` when the UI is disabled by an empty `ARGOS_UI_DIR`. */
export function resolveUiDir(
  env: NodeJS.ProcessEnv = process.env,
  defaultDir: string = DEFAULT_UI_DIR,
): string | undefined {
  const raw = env["ARGOS_UI_DIR"];
  if (raw === undefined) return defaultDir;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return resolve(trimmed);
}

export interface UiBuild {
  readonly dir: string;
  /** `build.json`'s id when the release copied one; absent for a plain `npm run build:ui` checkout. */
  readonly buildId?: string;
}

/**
 * The usable UI for this process, or `undefined`. A directory without `index.html` is not usable:
 * serving a 404 shell is worse than telling the operator the build is missing.
 */
export function inspectUi(dir: string | undefined): UiBuild | undefined {
  if (dir === undefined) return undefined;
  if (!existsSync(join(dir, "index.html"))) return undefined;
  const buildId = readBuildId(dir);
  return buildId === undefined ? { dir } : { dir, buildId };
}

function readBuildId(dir: string): string | undefined {
  const file = join(dir, "build.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as { buildId?: unknown }).buildId;
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}
