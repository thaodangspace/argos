/**
 * The browser session for the embedded UI (spec FR3).
 *
 * Why this exists: the operator's bearer token lives in `$ARGOS_HOME/token` (`0600`) and must never
 * reach a browser, and `EventSource` cannot set an `Authorization` header. `argos serve` therefore
 * mints one random session id **per process**, keeps it only in memory, and hands it to the browser
 * in an `HttpOnly` cookie. Possessing it is equivalent to possessing the token (same-user loopback,
 * see `docs/architecture.md#security`) but it is never persisted, is unreadable from JavaScript, is
 * not sent cross-site (`SameSite=Strict`), and dies when the process exits.
 *
 * The cookie is not sufficient on its own for writes: {@link cookieAuthAllowed} rejects a request
 * whose `Origin` is not this server. `SameSite` compares sites, not ports, so a page on
 * `127.0.0.1:3000` would otherwise be "same-site" with `127.0.0.1:7676`; the Origin check is what
 * stops it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const UI_COOKIE_NAME = "argos_ui";

/** Random session cookie source; injectable so a test can pin the value. */
export type SessionRandom = (size: number) => Buffer;

export interface UiSession {
  readonly cookieName: typeof UI_COOKIE_NAME;
  /** Ready-made `Set-Cookie` value: HttpOnly, SameSite=Strict, Path=/. Not `Secure` (loopback http). */
  readonly setCookie: string;
  /** Constant-time check of a raw `Cookie` request header. */
  matches(cookieHeader: string | undefined): boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The value of our cookie in a raw `Cookie` header, or `undefined`. */
export function cookieValue(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) === UI_COOKIE_NAME) {
      return trimmed.slice(separator + 1);
    }
  }
  return undefined;
}

export function createUiSession(random: SessionRandom = randomBytes): UiSession {
  const value = random(32).toString("hex");
  const expected = digest(value);
  return {
    cookieName: UI_COOKIE_NAME,
    setCookie: `${UI_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict`,
    matches(cookieHeader: string | undefined): boolean {
      const presented = cookieValue(cookieHeader);
      if (presented === undefined || presented === "") return false;
      return timingSafeEqual(digest(presented), expected);
    },
  };
}

/**
 * Whether a cookie-authenticated request may be honored (spec FR3).
 *
 * - `cross-site` browser requests are refused outright (defense in depth over `SameSite`).
 * - Reads (`GET`/`HEAD`) are allowed: the cookie is HttpOnly and the response is not CORS-readable
 *   by another origin.
 * - Writes require an `Origin` that matches this request's `Host`, so a page on another loopback
 *   port cannot drive the API with the same-site cookie. A bearer-authenticated request (curl, the
 *   CLI) is not subject to this rule and keeps today's behavior.
 */
export function cookieAuthAllowed(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return true;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== "string" || host === "" || typeof origin !== "string") return false;
  return origin === `http://${host}`;
}
