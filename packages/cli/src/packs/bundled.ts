/**
 * The packs that ship inside the CLI tarball (plan D8, NFR Packaging).
 *
 * `../../templates` is resolved from the compiled module's own URL, so the same code finds the
 * assets from a development checkout (`src/packs/bundled.ts` → `packages/cli/templates`), from
 * `dist/packs/bundled.js` after `npm run build`, and from a global install
 * (`…/lib/node_modules/@thaodangspace/argos/dist/packs/bundled.js`). Nothing here spawns a process
 * or reads the network.
 *
 * A tarball built before `templates` was added to `files` would install nothing; that is a broken
 * installation, not an operator error, so it fails loudly instead of reporting "0 packs".
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `<cli package root>/templates` — beside `dist/` and `src/`, in both layouts. */
export const BUNDLED_TEMPLATES_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

/** The bundled assets are not where the tarball says they should be. */
export class PackAssetsError extends Error {
  override readonly name = "PackAssetsError";
}

export interface BundledPacks {
  /** The directory that holds one subdirectory per pack. */
  readonly dir: string;
  /** Pack directory names, sorted, so an install without arguments is deterministic. */
  readonly names: readonly string[];
}

/** The bundled pack directory and its pack names; `dir` is injectable for tests. */
export function bundledPacks(dir: string = join(BUNDLED_TEMPLATES_DIR, "packs")): BundledPacks {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new PackAssetsError(
      `bundled hc template packs are missing at ${dir}; this installation is incomplete (reinstall @thaodangspace/argos)`,
    );
  }
  const names = entries
    .filter((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() && existsSync(join(path, "pack.json"));
    })
    .sort();
  if (names.length === 0) {
    throw new PackAssetsError(
      `bundled hc template packs are missing at ${dir}; this installation is incomplete (reinstall @thaodangspace/argos)`,
    );
  }
  return { dir, names };
}
