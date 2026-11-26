/**
 * Style guard for the web app (spec FR17, FR18): hand-written CSS must not come back.
 *
 * Five rules; rule 4 is the stale-exemption check that keeps the allowlist honest:
 *   1. no `<style>` block, `style=` attribute, or `style:` directive in any `.svelte` under `src/`,
 *      and `src/app.css` is the only `.css` file there. A path in
 *      `STYLE_ALLOWLIST` would keep exactly **one** `<style>` block — the one it has today; a second
 *      one is a new stylesheet already. The list is empty, and its stale rule below keeps it honest;
 *   2. no class built by interpolation (`tone-{tone}`) — Tailwind's scanner cannot see it, so the
 *      class would be missing only in the production build (spec FR4). A file that still carries its
 *      own `<style>` keeps its interpolation until its phase migrates it, which is exactly the same
 *      set: `STYLE_ALLOWLIST`, monotonic, checked for staleness below;
 *   3. `src/app.css` is a brace-depth scan, not a per-line regex: the four `@import`s in spec FR3's
 *      order, exactly one `@custom-variant`, and anything named in `APP_CSS_ALLOWLIST` — nothing
 *      else, so no selector, no declaration, no `@theme`/`@utility`/`@layer`;
 *   4. `STYLE_ALLOWLIST` fails when it lists a file that no longer offends, so no exemption outlives
 *      its phase;
 *   5. no `{@html}` anywhere under `src/` (spec FR18).
 *
 * A tone becomes a class only through the literal records in `src/lib/ui/tone.ts` (spec FR10).
 *
 * This guard and `import-graph.test.ts` read the tree with Node's filesystem; neither is part of the
 * browser bundle, so the import graph exempts those two files by name and nothing else.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const guardFile = fileURLToPath(import.meta.url);
const srcDir = fileURLToPath(new URL("..", import.meta.url));
const webDir = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Blocks `src/app.css` may hold besides the four imports and the one `@custom-variant`, named by
 * their head (the text before the opening brace). Empty on purpose: a utility that genuinely cannot
 * express something goes here **with a comment naming the utility that failed** and an entry below —
 * the guard is never loosened to fit markup.
 */
const APP_CSS_ALLOWLIST: readonly string[] = [];

/**
 * The `.svelte` files that still carry a `<style>` block (Phase 6 census: 0, Phase 7: 0).
 * Monotonic: a phase removes exactly its own files and adds none, and this test fails when an entry
 * goes stale. Empty is the goal state and where the migration left it.
 */
const STYLE_ALLOWLIST: readonly string[] = [];

/** Spec FR3, in order and complete. */
const APP_CSS_IMPORTS: readonly string[] = [
  '@import "tailwindcss";',
  '@import "@skeletonlabs/skeleton";',
  '@import "@skeletonlabs/skeleton-svelte";',
  '@import "@skeletonlabs/skeleton/themes/vintage";',
];

/** Spec FR6: this variant is what makes Skeleton's `light-dark()` pairs follow the `.dark` class. */
const APP_CSS_CUSTOM_VARIANT = "@custom-variant dark (&:where(.dark, .dark *));";

interface SourceFile {
  /** Path relative to `packages/web/`, e.g. `src/lib/components/RunList.svelte`. */
  readonly path: string;
  readonly absolute: string;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return [path];
  });
}

const FILES: readonly SourceFile[] = sourceFiles(srcDir)
  .map((absolute) => ({
    path: relative(webDir, absolute).split(sep).join("/"),
    absolute,
    text: readFileSync(absolute, "utf8"),
  }))
  .sort((left, right) => left.path.localeCompare(right.path));

const SVELTE_FILES = FILES.filter((file) => file.path.endsWith(".svelte"));

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The spec's one message shape (verbatim), so a failure says what to do next. */
function message(file: string, line: number, what: string): string {
  return `hand-written CSS is not allowed in packages/web: ${file}:${line} → ${what}. Use a Tailwind utility, a literal class map in src/lib/ui/tone.ts, or an allowed app.css block.`;
}

function styleOffences(text: string): { index: number; what: string }[] {
  const offences: { index: number; what: string }[] = [];
  for (const match of text.matchAll(/<style/g)) {
    offences.push({ index: match.index, what: "<style> block" });
  }
  // `(?<![-\w])` keeps `data-style=` out of it; `style\s*=` also catches `style = {...}`.
  for (const match of text.matchAll(/(?<![-\w])style\s*=/g)) {
    offences.push({ index: match.index, what: "style= attribute" });
  }
  // Svelte's inline-style directive: `style:color={x}` is hand-written CSS in a wrapper.
  for (const match of text.matchAll(/(?<![-\w])style:[a-z-]+=/g)) {
    offences.push({ index: match.index, what: "style: directive" });
  }
  return offences;
}

function isInterpolatedClass(value: string): boolean {
  return /[a-z][\w-]*-\{[^}]+\}/.test(value);
}

/** Comment bodies become spaces, so every offset still points at the original line. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

interface CssChunk {
  readonly kind: "statement" | "block";
  /** Offset of the chunk's first character (its head, not the whitespace before it). */
  readonly index: number;
  /** A statement including its `;`, or a block's head (the text before its opening brace). */
  readonly head: string;
}

/** The first non-space offset in `[start, end)`, so a chunk reports its own line, not the last one's. */
function headOffset(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && /\s/.test(text[index] ?? "")) index += 1;
  return index;
}

/** One brace-depth scan: top-level statements end at `;`, blocks at their matching `}`. */
function cssChunks(css: string): CssChunk[] {
  const text = stripComments(css);
  const chunks: CssChunk[] = [];
  let depth = 0;
  let chunkStart = 0;
  let headEnd = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (depth === 0) headEnd = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        chunks.push({
          kind: "block",
          index: headOffset(text, chunkStart, headEnd),
          head: text.slice(chunkStart, headEnd).trim(),
        });
        chunkStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      const head = text.slice(chunkStart, index + 1).trim();
      if (head !== "") {
        chunks.push({ kind: "statement", index: headOffset(text, chunkStart, index), head });
      }
      chunkStart = index + 1;
    }
  }
  return chunks;
}

describe("web style guard", () => {
  it("has sources to check", () => {
    expect(SVELTE_FILES.length).toBeGreaterThanOrEqual(1);
  });

  it("has no <style> block and no style= attribute in a .svelte file", () => {
    const allowed = new Set(STYLE_ALLOWLIST);
    const offenders: string[] = [];
    for (const file of SVELTE_FILES) {
      // A listed file keeps the one `<style>` block it already has, and no more.
      let exempt = allowed.has(file.path);
      for (const offence of styleOffences(file.text)) {
        if (offence.what === "<style> block" && exempt) {
          exempt = false;
          continue;
        }
        offenders.push(message(file.path, lineOf(file.text, offence.index), offence.what));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no class built by interpolation", () => {
    const allowed = new Set(STYLE_ALLOWLIST);
    const offenders: string[] = [];
    for (const file of SVELTE_FILES) {
      // The same set: a file still allowed its own `<style>` is still allowed its interpolation.
      if (allowed.has(file.path)) continue;
      // Both quote styles: `class='…'` is as valid a Svelte attribute as `class="…"`.
      for (const match of file.text.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
        const value = match[1] ?? match[2] ?? "";
        if (!isInterpolatedClass(value)) continue;
        offenders.push(message(file.path, lineOf(file.text, match.index), "interpolated class name"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps src/app.css the only stylesheet under src", () => {
    // Spec FR3: one CSS entry. A second `.css` file is a second stylesheet, whichever route imports it.
    const offenders = FILES.filter(
      (file) => file.path.endsWith(".css") && file.path !== "src/app.css",
    ).map((file) => message(file.path, 1, "extra stylesheet"));
    expect(offenders).toEqual([]);
  });

  it("keeps src/app.css to the four imports and the one dark variant", () => {
    const path = "src/app.css";
    const appCss = FILES.find((file) => file.path === path);
    expect(appCss).toBeDefined();
    const css = appCss?.text ?? "";
    const offenders: string[] = [];
    const imports: { head: string; index: number }[] = [];
    let customVariants = 0;

    for (const chunk of cssChunks(css)) {
      if (chunk.kind === "block") {
        // No selector, no declaration, no `@theme`/`@utility`/`@layer`: there is no block at all.
        if (APP_CSS_ALLOWLIST.includes(chunk.head)) continue;
        offenders.push(message(path, lineOf(css, chunk.index), "app.css statement"));
        continue;
      }
      if (APP_CSS_IMPORTS.includes(chunk.head)) {
        imports.push({ head: chunk.head, index: chunk.index });
        continue;
      }
      if (chunk.head === APP_CSS_CUSTOM_VARIANT) {
        customVariants += 1;
        if (customVariants > 1) {
          offenders.push(message(path, lineOf(css, chunk.index), "app.css statement"));
        }
        continue;
      }
      offenders.push(message(path, lineOf(css, chunk.index), "app.css statement"));
    }

    // Exactly the four imports, in spec FR3's order.
    if (imports.map((entry) => entry.head).join("\n") !== APP_CSS_IMPORTS.join("\n")) {
      const firstWrong = imports.findIndex((entry, index) => entry.head !== APP_CSS_IMPORTS[index]);
      const index = firstWrong === -1 ? 0 : (imports[firstWrong]?.index ?? 0);
      offenders.push(message(path, lineOf(css, index), "app.css statement"));
    }
    if (customVariants !== 1) {
      offenders.push(message(path, 1, "app.css statement"));
    }

    expect(offenders).toEqual([]);
  });

  it("fails when STYLE_ALLOWLIST lists a file that no longer offends", () => {
    const withStyle = new Set(
      SVELTE_FILES.filter((file) => file.text.includes("<style")).map((file) => file.path),
    );
    const offenders: string[] = [];
    for (const path of STYLE_ALLOWLIST) {
      if (withStyle.has(path)) continue;
      offenders.push(
        `stale exemption: ${path} no longer has a <style> block; remove it from STYLE_ALLOWLIST.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("has no {@html} under src", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.absolute === guardFile) continue;
      for (const match of file.text.matchAll(/\{@html/g)) {
        offenders.push(message(file.path, lineOf(file.text, match.index), "{@html}"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
