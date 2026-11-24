/**
 * `argos hc templates list|install|uninstall|verify` (spec FR10–FR14, FR15; plan Phases 2–3).
 *
 * Every test runs the real CLI in a temp `HOME`, `XDG_CONFIG_HOME`, and `ARGOS_HOME`, and asserts a
 * recursive snapshot of the workspace: `--dry-run` and a refusal must leave the filesystem byte
 * identical, and nothing outside the three roots may move. `verify` additionally talks to a local
 * stand-in for `argos serve` (`/health` + `GET /info`), because its second question is about the
 * roster the *running* server published.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasFlag, parseArgs } from "../src/args.js";
import { runCli } from "../src/main.js";
import { capture, withEnv } from "./support/cli.js";

interface Workspace {
  readonly root: string;
  readonly home: string;
  readonly xdg: string;
  readonly argos: string;
  readonly outside: string;
  readonly templates: string;
  readonly restore: () => void;
}

let workspace: Workspace;
let outsideBefore: string[];

function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "argos-hc-command-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const argos = join(root, "argos");
  const outside = join(root, "outside");
  for (const dir of [home, xdg, argos, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "untouched\n");
  // `verify` reads the bearer token from `$ARGOS_HOME` before it asks `/health`.
  writeFileSync(join(argos, "token"), "stub-token\n", { mode: 0o600 });
  const restore = withEnv({ HOME: home, XDG_CONFIG_HOME: xdg, ARGOS_HOME: argos });
  return {
    root,
    home,
    xdg,
    argos,
    outside,
    templates: join(xdg, "herdr-core", "templates"),
    restore,
  };
}

/** Every path under `dir`, with its mode and content (or symlink target). */
function snapshot(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      const rel = relative(dir, path);
      if (stat.isSymbolicLink()) found.push(`link ${rel} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        found.push(`dir ${rel} ${(stat.mode & 0o777).toString(8)}`);
        walk(path);
      } else found.push(`file ${rel} ${(stat.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

async function invoke(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): T;
}> {
  const captured = capture();
  const code = await runCli(argv, captured.io);
  const stdout = captured.stdout();
  return {
    code,
    stdout,
    stderr: captured.stderr(),
    json<T>(): T {
      return JSON.parse(stdout) as T;
    },
  };
}

interface TemplateJson {
  readonly name: string;
  readonly file: string;
  readonly command: string | null;
  readonly minStepTimeoutMs: number;
  readonly present: boolean;
}

interface PackJson {
  readonly name: string;
  readonly version: number;
  readonly program: string;
  readonly programSha256?: string;
  readonly link?: string;
  readonly templates: readonly TemplateJson[];
}

interface PacksJson {
  readonly dir: string;
  readonly packs: readonly PackJson[];
}

/** A minimal, valid pack in a directory of its own (for `--from` / `--link`). */
function writePack(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pack.json"),
    `${JSON.stringify(
      {
        name,
        version: 1,
        description: "test pack",
        requires: { node: ">=22.13", hcProtocol: 1 },
        program: { file: `${name}-step.mjs` },
        templates: [
          { name: `${name}-one`, args: "--model test", minStepTimeoutMs: 60_000, description: "one" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, `${name}-step.mjs`), "#!/usr/bin/env node\nprocess.exit(0);\n", {
    mode: 0o755,
  });
  return dir;
}

interface InfoStub {
  readonly port: number;
  readonly requests: string[];
  close(): Promise<void>;
}

/** The `/info` an older server sends: an `hc` entry whose roster predates the field (FR16). */
type StubHc = { readonly templates?: readonly string[] } | "unregistered";

/**
 * A one-route stand-in for `argos serve`: `/health`, `GET /info`, and a token check. `verify` asks
 * the live server whether it has seen the installed templates, so the three answers (seen, unseen,
 * unknown) are three payloads here — no durable host, no socket of the CLI's own.
 */
async function startInfoStub(token: string, hc: StubHc): Promise<InfoStub> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(path);
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: { code: "unauthorized", message: "a valid bearer token is required" } });
      return;
    }
    if (path === "/health") {
      send(200, { status: "ok" });
      return;
    }
    if (path === "/info") {
      send(200, {
        executors: [
          {
            id: "paseo",
            default: true,
            reachable: true,
            capabilities: {
              structuredOutput: true,
              quota: true,
              interactiveBlocked: false,
              scheduleSafe: true,
            },
          },
          ...(hc === "unregistered"
            ? []
            : [
                {
                  id: "hc",
                  default: false,
                  reachable: true,
                  capabilities: {
                    structuredOutput: false,
                    quota: false,
                    interactiveBlocked: true,
                    scheduleSafe: true,
                  },
                  ...(hc.templates === undefined ? {} : { templates: hc.templates }),
                },
              ]),
        ],
      });
      return;
    }
    send(200, {});
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

/** Run `verify` against `hc`'s payload, restoring `ARGOS_PORT` afterwards. */
async function verifyWith(
  argv: readonly string[],
  hc: StubHc,
): Promise<{ code: number; stdout: string; stderr: string; json<T>(): T }> {
  const stub = await startInfoStub("stub-token", hc);
  const restore = withEnv({ ARGOS_PORT: String(stub.port) });
  try {
    const result = await invoke(["hc", "templates", "verify", ...argv]);
    expect(stub.requests.length, "verify must ask the live server").toBeGreaterThan(0);
    return result;
  } finally {
    restore();
    await stub.close();
  }
}

beforeEach(() => {
  workspace = makeWorkspace();
  outsideBefore = snapshot(workspace.outside);
});

afterEach(() => {
  expect(snapshot(workspace.outside), "nothing outside the three roots may move").toEqual(
    outsideBefore,
  );
  workspace.restore();
  rmSync(workspace.root, { recursive: true, force: true });
});

describe("argos hc templates install", () => {
  it("installs both bundled packs, then reports the second run unchanged", async () => {
    const first = await invoke(["hc", "templates", "install"]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("claude, smoke");
    expect(first.stdout).toContain("hc templates` to confirm");
    expect(first.stdout).toContain("restart `argos serve`");

    expect(readdirSync(workspace.templates).sort()).toEqual([
      "claude-fable-high.md",
      "claude-opus-high.md",
      "claude-opus-xhigh.md",
      "claude-sonnet-medium.md",
      "smoke.md",
    ]);
    expect(existsSync(join(workspace.argos, "hc", "packs", "claude@1", "claude-step.mjs"))).toBe(true);
    expect(existsSync(join(workspace.argos, "hc", "packs", "smoke@1", "smoke.mjs"))).toBe(true);
    expect(lstatSync(join(workspace.argos, "hc", "packs", "claude@1")).mode & 0o777).toBe(0o700);
    expect(
      lstatSync(join(workspace.argos, "hc", "packs", "claude@1", "claude-step.mjs")).mode & 0o777,
    ).toBe(0o700);
    expect(lstatSync(join(workspace.templates, "smoke.md")).mode & 0o777).toBe(0o644);

    const installed = snapshot(workspace.root);
    const second = await invoke(["hc", "templates", "install"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect(snapshot(workspace.root)).toEqual(installed);
  });

  it("prints the plan and writes nothing under --dry-run", async () => {
    const before = snapshot(workspace.root);
    const result = await invoke(["hc", "templates", "install", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(dry run)");
    expect(result.stdout).toContain(join(workspace.templates, "smoke.md"));
    expect(snapshot(workspace.root)).toEqual(before);
  });

  it("refuses a foreign .md and writes nothing at all", async () => {
    mkdirSync(workspace.templates, { recursive: true });
    writeFileSync(
      join(workspace.templates, "smoke.md"),
      "---\nname: smoke\ndescription: hand written\ncommand: echo hi\n---\n",
    );
    const before = snapshot(workspace.root);
    const result = await invoke(["hc", "templates", "install", "smoke"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("template_conflict");
    expect(result.stderr).toContain("--force");
    expect(snapshot(workspace.root)).toEqual(before);

    const forced = await invoke(["hc", "templates", "install", "smoke", "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(workspace.templates, "smoke.md"), "utf8")).toContain(
      "· argos-pack smoke 1",
    );
  });

  it("installs only the named pack, and refuses an unknown one", async () => {
    const smoke = await invoke(["hc", "templates", "install", "smoke"]);
    expect(smoke.code).toBe(0);
    expect(readdirSync(workspace.templates)).toEqual(["smoke.md"]);
    const manifest = JSON.parse(
      readFileSync(join(workspace.argos, "hc", "packs.json"), "utf8"),
    ) as { packs: Record<string, unknown> };
    expect(Object.keys(manifest.packs)).toEqual(["smoke"]);

    const before = snapshot(workspace.root);
    const unknown = await invoke(["hc", "templates", "install", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("pack_unknown");
    expect(snapshot(workspace.root)).toEqual(before);
  });

  it("installs a pack from --from and links its program", async () => {
    const source = join(workspace.root, "house-packs");
    const packDir = writePack(source, "house");
    const result = await invoke(["hc", "templates", "install", "--from", source, "--link"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const program = join(workspace.argos, "hc", "packs", "house@1", "house-step.mjs");
    expect(lstatSync(program).isSymbolicLink()).toBe(true);
    expect(readlinkSync(program)).toBe(join(packDir, "house-step.mjs"));

    const manifest = JSON.parse(
      readFileSync(join(workspace.argos, "hc", "packs.json"), "utf8"),
    ) as {
      packs: Record<string, { link?: string; programSha256?: string; source: string }>;
    };
    expect(manifest.packs["house"]?.link).toBe(join(packDir, "house-step.mjs"));
    expect(manifest.packs["house"]?.programSha256).toBeUndefined();
    expect(manifest.packs["house"]?.source).toBe(source);

    const template = readFileSync(join(workspace.templates, "house-one.md"), "utf8");
    expect(template).toContain(join(packDir, "house-step.mjs"));
    expect(template).toContain("--model test");
    expect(template).toContain("· argos-pack house 1");

    // `--from` also accepts the pack directory itself, not only a directory of packs.
    const direct = await invoke(["hc", "templates", "install", "--from", packDir, "--link"]);
    expect(direct.code).toBe(0);
    const reread = JSON.parse(
      readFileSync(join(workspace.argos, "hc", "packs.json"), "utf8"),
    ) as { packs: Record<string, { source: string }> };
    expect(reread.packs["house"]?.source).toBe(packDir);
  });

  it("refuses a --from directory with no pack, and reports the plan as JSON", async () => {
    const empty = join(workspace.root, "empty");
    mkdirSync(empty, { recursive: true });
    const refused = await invoke(["hc", "templates", "install", "--from", empty]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("pack_missing");

    const result = await invoke(["hc", "templates", "install", "--json"]);
    expect(result.code).toBe(0);
    const json = result.json<
      PacksJson & {
        manifest: string;
        dryRun: boolean;
        unchanged: boolean;
        writes: string[];
        links: unknown[];
        warnings: string[];
      }
    >();
    expect(Object.keys(json).sort()).toEqual([
      "dir",
      "dryRun",
      "links",
      "manifest",
      "packs",
      "unchanged",
      "warnings",
      "writes",
    ]);
    expect(json.dir).toBe(workspace.templates);
    expect(json.manifest).toBe(join(workspace.argos, "hc", "packs.json"));
    expect(json.dryRun).toBe(false);
    expect(json.unchanged).toBe(false);
    expect(json.writes).toContain(join(workspace.templates, "claude-opus-high.md"));
    expect(json.packs.map((pack) => pack.name)).toEqual(["claude", "smoke"]);
  });
});

describe("argos hc templates list", () => {
  it("reports each installed template with its command and presence", async () => {
    const empty = await invoke(["hc", "templates", "list", "--json"]);
    expect(empty.code).toBe(0);
    expect(empty.json<PacksJson>()).toEqual({ dir: workspace.templates, packs: [] });
    expect((await invoke(["hc", "templates", "list"])).stdout).toContain("no packs installed");

    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);
    const listed = await invoke(["hc", "templates", "list", "--json"]);
    const json = listed.json<PacksJson>();
    expect(json.dir).toBe(workspace.templates);
    expect(json.packs.map((pack) => pack.name)).toEqual(["claude", "smoke"]);

    const claude = json.packs[0];
    expect(claude?.version).toBe(1);
    expect(claude?.programSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(claude?.link).toBeUndefined();
    expect(claude?.templates.map((template) => template.name)).toEqual([
      "claude-fable-high",
      "claude-opus-high",
      "claude-opus-xhigh",
      "claude-sonnet-medium",
    ]);
    const opusHigh = claude?.templates.find((template) => template.name === "claude-opus-high");
    expect(opusHigh?.minStepTimeoutMs).toBe(19_800_000);
    expect(opusHigh?.file).toBe(join(workspace.templates, "claude-opus-high.md"));
    expect(opusHigh?.present).toBe(true);
    expect(opusHigh?.command).toContain("--model claude-opus-5-5");
    expect(opusHigh?.command).toContain(join(workspace.argos, "hc", "packs", "claude@1", "claude-step.mjs"));

    // A deleted template is reported as missing, not hidden.
    rmSync(join(workspace.templates, "smoke.md"));
    const missing = (await invoke(["hc", "templates", "list", "--json"])).json<PacksJson>();
    expect(missing.packs[1]?.templates[0]?.present).toBe(false);
    expect(missing.packs[1]?.templates[0]?.command).toBeNull();

    const human = await invoke(["hc", "templates", "list"]);
    expect(human.stdout).toContain(workspace.templates);
    expect(human.stdout).toContain("claude-opus-high");
    expect(human.stdout).toContain("19800000 ms");
  });
});

describe("argos hc templates uninstall", () => {
  it("removes marker files, keeps a foreign file, and prunes on request", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);
    writeFileSync(
      join(workspace.templates, "hand-written.md"),
      "---\nname: hand-written\ncommand: echo hi\n---\n",
    );

    const result = await invoke(["hc", "templates", "uninstall", "claude"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("remove");
    expect(existsSync(join(workspace.templates, "claude-opus-high.md"))).toBe(false);
    expect(existsSync(join(workspace.templates, "smoke.md"))).toBe(true);
    expect(existsSync(join(workspace.templates, "hand-written.md"))).toBe(true);
    expect(existsSync(join(workspace.argos, "hc", "packs", "claude@1"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(workspace.argos, "hc", "packs.json"), "utf8"),
    ) as { packs: Record<string, unknown> };
    expect(Object.keys(manifest.packs)).toEqual(["smoke"]);

    const pruned = await invoke(["hc", "templates", "uninstall", "smoke", "--prune"]);
    expect(pruned.code).toBe(0);
    expect(existsSync(join(workspace.templates, "smoke.md"))).toBe(false);
    expect(existsSync(join(workspace.argos, "hc", "packs", "smoke@1"))).toBe(false);
    expect(existsSync(join(workspace.templates, "hand-written.md"))).toBe(true);
    expect(existsSync(join(workspace.argos, "hc", "packs", "claude@1"))).toBe(true);
  });

  it("writes nothing under --dry-run, and never deletes a file it did not write", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);
    // Replace one of our files with a hand-written one: it carries no marker, so it stays.
    writeFileSync(
      join(workspace.templates, "smoke.md"),
      "---\nname: smoke\ndescription: mine now\ncommand: echo hi\n---\n",
    );
    const before = snapshot(workspace.root);
    const dry = await invoke(["hc", "templates", "uninstall", "smoke", "--prune", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("(dry run)");
    expect(snapshot(workspace.root)).toEqual(before);

    const real = await invoke(["hc", "templates", "uninstall", "smoke", "--prune"]);
    expect(real.code).toBe(0);
    expect(existsSync(join(workspace.templates, "smoke.md"))).toBe(true);
    expect(real.stdout).toContain("not an argos pack template");
  });

  it("reports the removal as JSON and refuses an unknown pack", async () => {
    expect((await invoke(["hc", "templates", "install", "smoke"])).code).toBe(0);
    const removed = await invoke(["hc", "templates", "uninstall", "smoke", "--json"]);
    expect(removed.code).toBe(0);
    const json = removed.json<
      PacksJson & { manifest: string; dryRun: boolean; unchanged: boolean; removed: string[]; kept: unknown[] }
    >();
    expect(Object.keys(json).sort()).toEqual([
      "dir",
      "dryRun",
      "kept",
      "manifest",
      "packs",
      "removed",
      "unchanged",
    ]);
    expect(json.packs).toEqual([]);
    expect(json.removed).toEqual([join(workspace.templates, "smoke.md")]);

    const before = snapshot(workspace.root);
    const unknown = await invoke(["hc", "templates", "uninstall", "nope", "--json"]);
    expect(unknown.code).toBe(2);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("pack_unknown");
    expect(snapshot(workspace.root)).toEqual(before);
  });
});

interface VerifyTemplateJson {
  readonly name: string;
  readonly file: string;
  readonly present: boolean;
  readonly executable: boolean;
  readonly hashMatches: boolean;
  readonly inServer: boolean | null;
  readonly status: "ok" | "warn" | "error";
  readonly messages: readonly string[];
}

interface VerifyJson {
  readonly dir: string;
  readonly server: { readonly reachable: boolean; readonly templates: readonly string[] | null };
  readonly packs: readonly {
    readonly name: string;
    readonly version: number;
    readonly templates: readonly VerifyTemplateJson[];
  }[];
  readonly ok: boolean;
  readonly warnings: number;
  readonly errors: number;
}

/** Every installed template name, as the bundle installs it. */
const BUNDLED_TEMPLATES = [
  "claude-fable-high",
  "claude-opus-high",
  "claude-opus-xhigh",
  "claude-sonnet-medium",
  "smoke",
];

function roster(except: readonly string[] = []): string[] {
  return BUNDLED_TEMPLATES.filter((name) => !except.includes(name))
    .map((name) => `hc/${name}`)
    .sort();
}

describe("argos hc templates verify", () => {
  it("is ok when every installed template is in the running server's catalog", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);

    const result = await verifyWith(["--json"], { templates: roster() });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const json = result.json<VerifyJson>();
    expect(Object.keys(json).sort()).toEqual([
      "dir",
      "errors",
      "ok",
      "packs",
      "server",
      "warnings",
    ]);
    expect(json.dir).toBe(workspace.templates);
    expect(json.server).toEqual({ reachable: true, templates: roster() });
    expect(json.packs.map((pack) => pack.name)).toEqual(["claude", "smoke"]);
    expect(json.ok).toBe(true);
    expect(json.warnings).toBe(0);
    expect(json.errors).toBe(0);

    const smoke = json.packs[1]?.templates[0];
    expect(smoke?.name).toBe("smoke");
    expect(smoke?.file).toBe(join(workspace.templates, "smoke.md"));
    expect(smoke).toMatchObject({
      present: true,
      executable: true,
      hashMatches: true,
      inServer: true,
      status: "ok",
    });
    expect(smoke?.messages).toEqual([]);

    const human = await verifyWith([], { templates: roster() });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("argos hc templates verify");
    expect(human.stdout).toContain(`templates  ${workspace.templates}`);
    expect(human.stdout).toContain("5 hc templates");
    expect(human.stdout).toContain("smoke  ok");
    expect(human.stdout).toContain("0 errors, 0 warnings");
  });

  it("warns (exit 0) when a template is installed but the server has not seen it", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);

    // Without the flag: a stale server is a warning, never a failure (D13).
    const stale = await verifyWith(["--json"], { templates: roster(["smoke"]) });
    expect(stale.code).toBe(0);
    const json = stale.json<VerifyJson>();
    expect(json.server).toEqual({ reachable: true, templates: roster(["smoke"]) });
    expect(json.ok).toBe(true);
    expect(json.errors).toBe(0);
    expect(json.warnings).toBe(1);
    const smoke = json.packs[1]?.templates[0];
    expect(smoke?.inServer).toBe(false);
    expect(smoke?.status).toBe("warn");
    expect(smoke?.messages.join("\n")).toContain("restart `argos serve`");
    // The templates the server does report stay ok.
    expect(json.packs[0]?.templates.every((template) => template.status === "ok")).toBe(true);

    // `--require-server` is about reachability only, so a reachable server still exits 0.
    const required = await verifyWith(["--require-server", "--json"], { templates: roster(["smoke"]) });
    expect(required.code).toBe(0);
    expect(required.json<VerifyJson>().warnings).toBe(1);

    const human = await verifyWith([], { templates: roster(["smoke"]) });
    expect(human.stdout).toContain("smoke  warn");
    expect(human.stdout).toContain("0 errors, 1 warning");
  });

  it("cannot tell when the server answers without a roster (older server or no hc)", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);

    const older = await verifyWith(["--json"], {});
    expect(older.code).toBe(0);
    const json = older.json<VerifyJson>();
    expect(json.server).toEqual({ reachable: true, templates: null });
    expect(json.ok).toBe(true);
    expect(json.warnings).toBe(5);
    for (const pack of json.packs) {
      for (const template of pack.templates) {
        expect(template.inServer, template.name).toBeNull();
        expect(template.status, template.name).toBe("warn");
        expect(template.messages.join("\n")).toContain("does not publish its hc templates");
        expect(template.messages.join("\n")).toContain("cannot tell");
      }
    }

    const unregistered = await verifyWith(["--json"], "unregistered");
    expect(unregistered.code).toBe(0);
    const noHc = unregistered.json<VerifyJson>();
    expect(noHc.server).toEqual({ reachable: true, templates: null });
    expect(noHc.packs[0]?.templates[0]?.messages.join("\n")).toContain(
      "does not register the hc executor",
    );
  });

  it("warns without --require-server and exits 3 with it when argos serve is not reachable", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);
    // A port that was just released: nothing listens there, so the refusal is immediate.
    const closed = await startInfoStub("stub-token", {});
    await closed.close();
    const restore = withEnv({ ARGOS_PORT: String(closed.port) });
    try {
      const soft = await invoke(["hc", "templates", "verify", "--json"]);
      expect(soft.code).toBe(0);
      const json = soft.json<VerifyJson>();
      expect(json.server).toEqual({ reachable: false, templates: null });
      expect(json.ok).toBe(true);
      expect(json.errors).toBe(0);
      expect(json.warnings).toBe(5);
      expect(json.packs[0]?.templates[0]?.inServer).toBeNull();
      expect(json.packs[0]?.templates[0]?.messages.join("\n")).toContain("not reachable");

      const human = await invoke(["hc", "templates", "verify"]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("start it with `argos serve`");

      const hard = await invoke(["hc", "templates", "verify", "--require-server", "--json"]);
      expect(hard.code).toBe(3);
      expect(hard.json<VerifyJson>().ok).toBe(false);
      expect(hard.json<VerifyJson>().server.reachable).toBe(false);

      expect((await invoke(["hc", "templates", "verify", "--require-server"])).code).toBe(3);
    } finally {
      restore();
    }
  });

  it("reports a broken install as errors (exit 1) and a hand-edited manifest as a refusal", async () => {
    expect((await invoke(["hc", "templates", "install"])).code).toBe(0);
    rmSync(join(workspace.templates, "smoke.md"));
    const program = join(workspace.argos, "hc", "packs", "claude@1", "claude-step.mjs");
    writeFileSync(program, "#!/usr/bin/env node\nprocess.exit(9);\n", { mode: 0o700 });

    const broken = await verifyWith(["--json"], { templates: roster() });
    expect(broken.code).toBe(1);
    const json = broken.json<VerifyJson>();
    expect(json.ok).toBe(false);
    // The program is shared by its whole pack, so every one of its rows is red; the missing
    // template file is the fifth.
    expect(json.errors).toBe(5);
    const claude = json.packs[0]?.templates[0];
    expect(claude?.hashMatches).toBe(false);
    expect(claude?.messages.join("\n")).toContain("sha256 differs from the manifest");
    const smoke = json.packs[1]?.templates[0];
    expect(smoke?.present).toBe(false);
    if (smoke === undefined) throw new Error("the smoke row is missing from the verify report");
    expect(smoke.messages.join("\n")).toContain(`template file missing: ${smoke.file}`);

    writeFileSync(join(workspace.argos, "hc", "packs.json"), "{ not json\n");
    const refused = await invoke(["hc", "templates", "verify", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("manifest_invalid");
  });
});

describe("argos hc templates usage", () => {
  it.each([
    [["hc"]],
    [["hc", "templates"]],
    [["hc", "templates", "bogus"]],
    [["hc", "templates", "list", "--bogus"]],
    [["hc", "templates", "uninstall"]],
    [["hc", "templates", "install", "--bogus"]],
    [["hc", "templates", "verify", "--bogus"]],
    [["hc", "templates", "verify", "extra"]],
  ])("exits 1 for %j", async (argv) => {
    const result = await invoke(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("argos:");
  });

  it("keeps --link, --prune, and --require-server boolean", () => {
    const install = parseArgs(["hc", "templates", "install", "--link", "claude"]);
    expect(install.positionals).toEqual(["templates", "install", "claude"]);
    expect(hasFlag(install, "link")).toBe(true);
    expect(install.flags.get("link")).toEqual(["true"]);

    const uninstall = parseArgs(["hc", "templates", "uninstall", "--prune", "claude"]);
    expect(uninstall.positionals).toEqual(["templates", "uninstall", "claude"]);
    expect(hasFlag(uninstall, "prune")).toBe(true);

    const verify = parseArgs(["hc", "templates", "verify", "--require-server"]);
    expect(verify.positionals).toEqual(["templates", "verify"]);
    expect(hasFlag(verify, "require-server")).toBe(true);
  });
});
