/**
 * Static UI hosting and the browser session (spec FR1–FR3): a real in-process server, a real temp
 * UI build directory, and real HTTP requests.
 *
 * The traversal cases go through `node:http` on purpose: `fetch` normalizes `..` and `%2e%2e` out of
 * a URL before sending, so it cannot prove what the server does with a hostile raw path.
 */

import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { UI_COOKIE_NAME } from "../../src/rpc/session.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, type TempHome } from "../durable/support.js";

const TOKEN = "ui-test-token-0123456789";
const INDEX = "<!doctype html><title>argos</title><script src=\"/ui/_app/immutable/app.js\"></script>";
const APP_JS = "console.log('argos');\n";

interface Harness {
  server: RpcServer;
  home: TempHome;
  ui: string;
  root: string;
}

const open: Harness[] = [];

function makeUiDir(): { ui: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "argos-ui-"));
  const ui = join(root, "ui");
  mkdirSync(join(ui, "_app", "immutable"), { recursive: true });
  writeFileSync(join(ui, "index.html"), INDEX, "utf8");
  writeFileSync(join(ui, "_app", "immutable", "app.js"), APP_JS, "utf8");
  // A file next to the UI directory that traversal must never reach.
  writeFileSync(join(root, "secret.txt"), "CANARY-DO-NOT-SERVE", "utf8");
  return { ui, root };
}

async function start(options: { readonly withUi?: boolean; readonly warnings?: string[] } = {}): Promise<Harness> {
  const home = makeTempHome();
  const { ui, root } = makeUiDir();
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor: new FakeExecutor({ completeAfterPolls: 1 }),
  });
  const server = await createRpcServer({
    host,
    home: home.home,
    port: 0,
    token: TOKEN,
    log: (line) => options.warnings?.push(line),
    ...(options.withUi === false ? {} : { ui: { dir: ui } }),
  });
  const harness = { server, home, ui, root };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.server.host.close();
    harness.home.cleanup();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

async function get(
  h: Harness,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`${h.server.url}${path}`, { headers, redirect: "manual" });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

/** A request whose path is sent byte-for-byte (no WHATWG URL normalization). */
function raw(
  h: Harness,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: h.server.port,
        path,
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function cookieFrom(setCookie: string): string {
  const value = setCookie.split(";")[0] ?? "";
  expect(value.startsWith(`${UI_COOKIE_NAME}=`)).toBe(true);
  return value;
}

describe("ui static hosting", () => {
  it("redirects / to /ui/ when the UI is enabled", async () => {
    const h = await start();
    const response = await get(h, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/ui/");
  });

  it("serves the shell with an HttpOnly SameSite=Strict cookie and a CSP", async () => {
    const h = await start();
    const response = await get(h, "/ui/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.text).toContain("/ui/_app/immutable/app.js");
    const setCookie = response.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain(`${UI_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // The content policy (scripts/styles) lives in the shell's meta tag, which carries the build
    // hash; the header must not carry a default-src that the inline bootstrap cannot satisfy.
    expect(response.headers.get("content-security-policy")).not.toContain("default-src");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves a deep link from index.html and a fingerprinted asset as immutable", async () => {
    const h = await start();
    const deep = await get(h, "/ui/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(deep.status).toBe(200);
    expect(deep.text).toContain("<title>argos</title>");

    const asset = await get(h, "/ui/_app/immutable/app.js");
    expect(asset.status).toBe(200);
    expect(asset.text).toBe(APP_JS);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.getSetCookie()).toEqual([]);
  });

  it("404s a missing asset instead of returning the shell", async () => {
    const h = await start();
    const response = await get(h, "/ui/_app/immutable/missing.js");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("<title>argos</title>");
  });

  it("supports HEAD without a body", async () => {
    const h = await start();
    const response = await raw(h, "/ui/index.html", "HEAD");
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
  });

  it("rejects traversal, encoded traversal, and separator tricks without reading the file", async () => {
    const h = await start();
    for (const path of [
      "/ui/../secret.txt",
      "/ui/%2e%2e/secret.txt",
      "/ui/..%2fsecret.txt",
      "/ui/%2e%2e%2fsecret.txt",
      "/ui/..\\secret.txt",
      "/ui/%00",
    ]) {
      const response = await raw(h, path);
      expect(response.status, path).toBe(404);
      expect(response.text, path).not.toContain("CANARY-DO-NOT-SERVE");
    }
  });

  it("keeps 404 and 405 semantics for the UI prefix", async () => {
    const h = await start();
    const post = await raw(h, "/ui/", "POST");
    expect(post.status).toBe(405);
    const unknown = await get(h, "/ui/%zz");
    expect(unknown.status).toBe(404);
  });
});

describe("ui session authentication", () => {
  async function sessionCookie(h: Harness): Promise<string> {
    const shell = await get(h, "/ui/");
    return cookieFrom(shell.headers.getSetCookie()[0] ?? "");
  }

  it("lets the shell's cookie read the API, and refuses a forged one", async () => {
    const h = await start();
    const cookie = await sessionCookie(h);
    const authorized = await get(h, "/runs", { cookie });
    expect(authorized.status).toBe(200);

    const forged = await get(h, "/runs", { cookie: `${UI_COOKIE_NAME}=${"0".repeat(64)}` });
    expect(forged.status).toBe(401);
    const anonymous = await get(h, "/runs");
    expect(anonymous.status).toBe(401);
  });

  it("accepts a same-origin write with the cookie and rejects another origin's", async () => {
    const h = await start();
    const cookie = await sessionCookie(h);
    const host = `127.0.0.1:${String(h.server.port)}`;

    const sameOrigin = await raw(
      h,
      "/runs",
      "POST",
      { cookie, origin: `http://${host}`, "content-type": "application/json" },
      "{}",
    );
    // Authenticated (the body is invalid, not the cookie): 400 `invalid_request`, never 401.
    expect(sameOrigin.status).toBe(400);

    const otherPort = await raw(
      h,
      "/runs",
      "POST",
      { cookie, origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      "{}",
    );
    expect(otherPort.status).toBe(401);

    const missingOrigin = await raw(h, "/runs", "POST", { cookie }, "{}");
    expect(missingOrigin.status).toBe(401);

    const crossSite = await raw(
      h,
      "/runs",
      "POST",
      {
        cookie,
        origin: `http://${host}`,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      "{}",
    );
    expect(crossSite.status).toBe(401);
  });

  it("keeps the bearer token working unchanged", async () => {
    const h = await start();
    const response = await get(h, "/runs", { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    const bad = await get(h, "/runs", { authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
  });

  it("refuses an API request from another origin even with a valid bearer token? no: bearer is not origin-bound", async () => {
    // Documented: bearer is the operator's capability and is not origin-checked (CLI/curl compatibility).
    const h = await start();
    const response = await raw(h, "/runs", "GET", {
      authorization: `Bearer ${TOKEN}`,
      origin: "http://127.0.0.1:3000",
    });
    expect(response.status).toBe(200);
  });
});

describe("ui disabled", () => {
  it("serves API-only when no ui directory is configured", async () => {
    const h = await start({ withUi: false });
    expect((await get(h, "/ui/")).status).toBe(404);
    expect((await get(h, "/", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await get(h, "/runs", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("warns and stays API-only when index.html is missing", async () => {
    const warnings: string[] = [];
    const home = makeTempHome();
    const root = mkdtempSync(join(tmpdir(), "argos-ui-empty-"));
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home: home.home,
      executor: new FakeExecutor(),
    });
    const server = await createRpcServer({
      host,
      home: home.home,
      port: 0,
      token: TOKEN,
      ui: { dir: root },
      log: (line) => warnings.push(line),
    });
    try {
      expect(warnings.some((line) => line.includes("ui disabled"))).toBe(true);
      const response = await fetch(`${server.url}/ui/`);
      expect(response.status).toBe(404);
    } finally {
      await server.close();
      await host.close();
      home.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
