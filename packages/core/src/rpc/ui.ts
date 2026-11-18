/**
 * Static serving for the embedded UI (spec FR1/FR2).
 *
 * The UI is a static SPA (`adapter-static`, `paths.base = "/ui"`) whose build is served by the same
 * loopback server as the API. Three rules keep it predictable:
 *
 * 1. **One reserved prefix.** Only `/ui` and `/ui/...` are UI paths, so the SPA route `/ui/runs/<id>`
 *    can never shadow the API route `GET /runs/:id`.
 * 2. **Deep links work, missing chunks fail.** An extension-less path resolves to `index.html`, but
 *    a missing file *with* an extension is a 404 — a stale browser cache must never receive HTML for
 *    a JavaScript import.
 * 3. **No traversal.** Path segments are decoded and rejected if they are `.`/`..`, contain a
 *    separator or NUL, and the resolved file's realpath must stay inside the UI directory.
 */

import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";

/** The one reserved prefix for the embedded UI. */
export const UI_BASE = "/ui";

/**
 * The frame/base policy the server sends as a header. The **content** policy (scripts, styles,
 * connects) comes from the `<meta http-equiv="content-security-policy">` SvelteKit writes into
 * `index.html`, because it carries the hash of the shell's inline bootstrap script — a header
 * without that hash would block the app. CSP policies combine, so a header that only names these
 * directives cannot weaken the meta policy.
 */
export const UI_CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export interface UiFile {
  /** Absolute, real path of the file to stream. */
  readonly file: string;
  /** POSIX path relative to the UI directory (drives the cache policy and content type). */
  readonly relative: string;
  readonly html: boolean;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function isUiPath(pathname: string): boolean {
  return pathname === UI_BASE || pathname.startsWith(`${UI_BASE}/`);
}

/**
 * Whether the **raw** request target claims the UI prefix, before WHATWG URL normalization.
 *
 * `/ui/../secret` normalizes to `/secret`, so {@link isUiPath} alone cannot tell a hostile UI-shaped
 * path from an ordinary API miss; this keeps the answer a 404 in both the enabled and disabled case.
 */
export function isUiAttempt(req: IncomingMessage): boolean {
  const target = req.url ?? "";
  const path = target.split("?")[0] ?? "";
  return (
    path === UI_BASE ||
    path.startsWith(`${UI_BASE}/`) ||
    path.startsWith(`${UI_BASE}%2F`) ||
    path.startsWith(`${UI_BASE}%2f`)
  );
}

export function contentTypeFor(relative: string): string {
  return CONTENT_TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream";
}

/** Fingerprinted build output is immutable; everything else must revalidate (spec FR2). */
export function cacheControlFor(relative: string): string {
  return relative.startsWith("_app/immutable/")
    ? "public, max-age=31536000, immutable"
    : "no-store";
}

function statFile(file: string): ReturnType<typeof statSync> | undefined {  try {
    const stats = statSync(file);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

function realpathInside(dir: string, file: string): string | undefined {
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(dir);
    realFile = realpathSync(file);
  } catch {
    return undefined;
  }
  const prefix = realDir.endsWith(sep) ? realDir : `${realDir}${sep}`;
  if (realFile !== realDir && !realFile.startsWith(prefix)) return undefined;
  return realFile;
}

function asUiFile(dir: string, relative: string): UiFile | undefined {
  const file = realpathInside(dir, join(dir, ...relative.split("/")));
  if (file === undefined) return undefined;
  return { file, relative, html: extname(relative).toLowerCase() === ".html" };
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a `/ui/...` pathname to the file to serve, or `undefined` for a 404.
 *
 * `dir` must be the UI build directory (the one holding `index.html`).
 */
export function resolveUiFile(dir: string, pathname: string): UiFile | undefined {
  if (!isUiPath(pathname)) return undefined;
  const rest = pathname === UI_BASE ? "" : pathname.slice(UI_BASE.length);
  const trailingSlash = rest.endsWith("/");

  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    const decoded = decodeSegment(raw);
    if (decoded === undefined || decoded === "") return undefined;
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return undefined;
    }
    if (decoded.includes("\u0000")) return undefined;
    segments.push(decoded);
  }

  const relative = segments.join("/");
  if (!trailingSlash && relative !== "") {
    const direct = asUiFile(dir, relative);
    if (direct !== undefined) return direct;
    // A missing path *with* an extension is a missing asset, never the SPA shell.
    if (extname(relative) !== "") return undefined;
  }
  return asUiFile(dir, "index.html");
}

/**
 * Stream one resolved file. `setCookie` is added only to HTML responses: the shell is what gives
 * the browser its session, and an asset needs no cookie (spec FR3).
 */
export function serveUiFile(
  req: IncomingMessage,
  res: ServerResponse,
  input: { readonly file: UiFile; readonly setCookie?: string },
): void {
  const stats = statFile(input.file.file);
  if (stats === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("not found\n");
    return;
  }
  const headers: Record<string, string | number> = {
    "content-type": contentTypeFor(input.file.relative),
    "content-length": Number(stats.size),
    "cache-control": cacheControlFor(input.file.relative),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (input.file.html) {
    headers["content-security-policy"] = UI_CONTENT_SECURITY_POLICY;
    headers["x-frame-options"] = "DENY";
    if (input.setCookie !== undefined) headers["set-cookie"] = input.setCookie;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(input.file.file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
