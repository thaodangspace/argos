/**
 * The editor's read routes over a real in-process server: `GET /playbooks/file` (spec FR1–FR5) and
 * `POST /playbooks/validate` (FR6/FR7).
 *
 * Like the db suite, this one needs a **file-backed** host: the routes read real YAML from a real
 * repository, so the containment matrix is exercised against the filesystem rather than a stub. The
 * cwd rules come from `POST /runs` (`validateRunCwd`), so a bad cwd is refused before any file.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import {
  PlaybookFileResponseSchema,
  PlaybookVerdictSchema,
  PLAYBOOK_TEXT_LIMIT,
  type PlaybookFileResponse,
  type PlaybookVerdict,
} from "../../src/rpc/contracts.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, type TempHome } from "../durable/support.js";

const TOKEN = "playbook-read-token-0123456789";

const GOOD_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: hi\n";
const BROKEN_YAML = "title: Broken\nunknown_key_here: true\nsteps:\n  - id: a\n    prompt: hi\n";
const EDITED_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: edited\n";

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly sibling: string;
  readonly good: string;
  readonly broken: string;
  readonly global: string;
  readonly fallback: string;
  readonly oversized: string;
  readonly symlinkOutside: string;
  readonly symlinkInside: string;
  readonly playbookDir: string;
}

interface Harness extends Fixture {
  readonly host: ArgosHost;
  readonly server: RpcServer;
  readonly base: string;
  readonly home: TempHome;
}

const openHarnesses: Harness[] = [];

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "argos-playbook-read-"));
}

/** Two repositories, a home, and one file per containment case. */
function writeFixture(home: TempHome): Fixture {
  const root = tempRoot();
  const repo = join(root, "repo");
  const sibling = join(root, "sibling");
  const playbookDir = join(repo, ".argos", "playbooks");
  const fallbackDir = join(repo, ".paseo", "plugins", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  mkdirSync(fallbackDir, { recursive: true });
  mkdirSync(join(sibling, ".argos", "playbooks"), { recursive: true });
  mkdirSync(join(home.home, "playbooks"), { recursive: true });

  const good = join(playbookDir, "good.yaml");
  writeFileSync(good, GOOD_YAML, "utf8");
  const broken = join(playbookDir, "broken.yaml");
  writeFileSync(broken, BROKEN_YAML, "utf8");
  const oversized = join(playbookDir, "oversized.yaml");
  writeFileSync(oversized, `# ${"x".repeat(PLAYBOOK_TEXT_LIMIT)}\n`, "utf8");
  const fallback = join(fallbackDir, "fallback.yaml");
  writeFileSync(fallback, GOOD_YAML, "utf8");
  const global = join(home.home, "playbooks", "global.yaml");
  writeFileSync(global, GOOD_YAML, "utf8");
  writeFileSync(join(sibling, ".argos", "playbooks", "good.yaml"), GOOD_YAML, "utf8");

  const symlinkOutside = join(repo, "link.yaml");
  symlinkSync(good, symlinkOutside);
  const symlinkInside = join(playbookDir, "alias.yaml");
  symlinkSync(good, symlinkInside);

  return {
    root,
    repo,
    sibling,
    good,
    broken,
    global,
    fallback,
    oversized,
    symlinkOutside,
    symlinkInside,
    playbookDir,
  };
}

async function startHarness(): Promise<Harness> {
  const home = makeTempHome();
  const fixture = writeFixture(home);
  const host = await ArgosHost.open({ home: home.home, executor: new FakeExecutor() });
  const server = await createRpcServer({ host, home: home.home, port: 0, token: TOKEN });
  const harness = { ...fixture, host, server, base: server.url, home };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.host.close();
    rmSync(harness.root, { recursive: true, force: true });
    harness.home.cleanup();
  }
});

async function call(
  base: string,
  method: string,
  path: string,
  options: { readonly body?: unknown } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
}

function fileQuery(cwd: string, file: string, extra = ""): string {
  return `/playbooks/file?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}${extra}`;
}

async function readFile(base: string, cwd: string, file: string, extra = ""): Promise<PlaybookFileResponse> {
  const response = await call(base, "GET", fileQuery(cwd, file, extra));
  expect(response.status, response.text).toBe(200);
  return PlaybookFileResponseSchema.parse(response.body);
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Names, contents, and link targets of a tree: what "nothing was written" is measured against. */
function snapshot(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) {
        lines.push(`link ${name} -> ${readlinkSync(path)}`);
      } else if (entry.isDirectory()) {
        lines.push(`dir  ${name}`);
        walk(path);
      } else {
        lines.push(`file ${name} ${sha256(readFileSync(path, "utf8"))}`);
      }
    }
  };
  walk(root);
  return lines;
}

describe("GET /playbooks/file (FR1–FR3)", () => {
  it("returns the text, the digest, and the loader's verdict for a good file", async () => {
    const harness = await startHarness();

    const read = await readFile(harness.base, harness.repo, harness.good);
    expect(read.cwd).toBe(harness.repo);
    expect(read.file).toBe(realpathSync(harness.good));
    expect(read.playbookId).toBe("good");
    expect(read.valid).toBe(true);
    expect(read.yaml).toBe(GOOD_YAML);
    expect(read.sha256).toBe(sha256(GOOD_YAML));
    expect(read.hash).toEqual(expect.any(String));
    expect(read.errors).toEqual([]);
    expect(read).not.toHaveProperty("graph");
  });

  it("answers 200 with valid: false and the loader's issues for a broken file", async () => {
    const harness = await startHarness();

    const read = await readFile(harness.base, harness.repo, harness.broken);
    expect(read.valid).toBe(false);
    expect(read.yaml).toBe(BROKEN_YAML);
    expect(read).not.toHaveProperty("hash");
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]?.code).toBe("playbook_invalid");
    expect(read.errors[0]?.issues?.map((issue) => issue.path)).toContain("unknown_key_here");
  });

  it("adds the graph only when the query asks for it", async () => {
    const harness = await startHarness();

    const withGraph = await readFile(harness.base, harness.repo, harness.good, "&graph=1");
    expect(withGraph.graph?.nodes.map((node) => node.id)).toEqual(["a"]);

    const plain = await readFile(harness.base, harness.repo, harness.good);
    expect(plain).not.toHaveProperty("graph");
  });

  it("reads a home playbook, which is never writable", async () => {
    const harness = await startHarness();

    const read = await readFile(harness.base, harness.repo, harness.global);
    expect(read.playbookId).toBe("global");
    expect(read.valid).toBe(true);
  });

  it("refuses every path discovery did not produce with 400 invalid_request", async () => {
    const harness = await startHarness();
    const stray = join(harness.repo, "notes.yaml");
    writeFileSync(stray, GOOD_YAML, "utf8");

    const cases: ReadonlyArray<readonly [string, string]> = [
      [stray, "undiscovered absolute path"],
      [".argos/playbooks/good.yaml", "relative path"],
      [`${harness.good}\u0000suffix`, "NUL byte"],
      [`${harness.playbookDir}/../playbooks/good.yaml`, ".. traversal"],
      [harness.symlinkOutside, "symlink at the repository root"],
      [harness.symlinkInside, "symlink inside a writable root"],
      [harness.playbookDir, "directory"],
      [join(harness.playbookDir, "gone.yaml"), "missing file"],
      [harness.oversized, `over ${PLAYBOOK_TEXT_LIMIT} bytes`],
      [join(harness.sibling, ".argos", "playbooks", "good.yaml"), "sibling repository"],
    ];
    for (const [file, label] of cases) {
      const response = await call(harness.base, "GET", fileQuery(harness.repo, file));
      expect(response.status, `${label}: ${response.text}`).toBe(400);
      expect(errorCode(response.body), label).toBe("invalid_request");
    }

    // FR3: the cwd rules are `POST /runs`' rules, checked before any file is read.
    const badCwd = await call(harness.base, "GET", fileQuery("relative/repo", harness.good));
    expect(badCwd.status, badCwd.text).toBe(400);
    expect(errorCode(badCwd.body)).toBe("invalid_request");
  });

  it("answers 401 without a token and 405 for the wrong method", async () => {
    const harness = await startHarness();

    const anonymous = await fetch(`${harness.base}${fileQuery(harness.repo, harness.good)}`);
    expect(anonymous.status).toBe(401);
    expect(errorCode(await anonymous.json())).toBe("unauthorized");

    const wrongMethod = await call(harness.base, "POST", "/playbooks/file", {
      body: { cwd: harness.repo, file: harness.good },
    });
    expect(wrongMethod.status).toBe(405);
    expect(errorCode(wrongMethod.body)).toBe("method_not_allowed");
  });
});

describe("POST /playbooks/validate (FR6, FR7)", () => {
  it("gives the verdict the same text on disk gets, and writes nothing", async () => {
    const harness = await startHarness();
    const before = snapshot(harness.root);

    const first = await call(harness.base, "POST", "/playbooks/validate", {
      body: { cwd: harness.repo, file: harness.good, yaml: GOOD_YAML },
    });
    expect(first.status, first.text).toBe(200);
    const firstVerdict = PlaybookVerdictSchema.parse(first.body);
    const onDisk = await readFile(harness.base, harness.repo, harness.good);
    expect(firstVerdict).toEqual(verdictOf(onDisk));

    // The same buffer, now the file's actual bytes: the verdict must not move.
    writeFileSync(harness.good, EDITED_YAML, "utf8");
    const second = await call(harness.base, "POST", "/playbooks/validate", {
      body: { cwd: harness.repo, file: harness.good, yaml: EDITED_YAML },
    });
    expect(second.status, second.text).toBe(200);
    const secondVerdict = PlaybookVerdictSchema.parse(second.body);
    expect(secondVerdict).toEqual(verdictOf(await readFile(harness.base, harness.repo, harness.good)));
    expect(secondVerdict.hash).not.toBe(firstVerdict.hash);

    // Two POSTs wrote nothing: the only change is the one this test made itself.
    writeFileSync(harness.good, GOOD_YAML, "utf8");
    expect(snapshot(harness.root)).toEqual(before);
  });

  it("returns an invalid buffer as a verdict with the loader's issues", async () => {
    const harness = await startHarness();

    const response = await call(harness.base, "POST", "/playbooks/validate", {
      body: { cwd: harness.repo, file: harness.good, yaml: BROKEN_YAML },
    });
    expect(response.status, response.text).toBe(200);
    const verdict = PlaybookVerdictSchema.parse(response.body);
    expect(verdict.valid).toBe(false);
    expect(verdict).not.toHaveProperty("hash");
    expect(verdict.errors[0]?.issues?.[0]?.path).toBe("unknown_key_here");
  });

  it("adds the graph only when the body asks for it", async () => {
    const harness = await startHarness();

    const plain = await call(harness.base, "POST", "/playbooks/validate", {
      body: { cwd: harness.repo, file: harness.good, yaml: GOOD_YAML },
    });
    expect(PlaybookVerdictSchema.parse(plain.body)).not.toHaveProperty("graph");

    const graphed = await call(harness.base, "POST", "/playbooks/validate", {
      body: { cwd: harness.repo, file: harness.good, yaml: GOOD_YAML, graph: true },
    });
    expect(PlaybookVerdictSchema.parse(graphed.body).graph?.nodes.map((node) => node.id)).toEqual([
      "a",
    ]);
  });

  it("refuses a bad cwd, an undiscovered file, and an oversized buffer with 400", async () => {
    const harness = await startHarness();
    const before = snapshot(harness.root);

    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ cwd: "relative/repo", file: harness.good, yaml: GOOD_YAML }, "relative cwd"],
      [{ cwd: join(harness.repo, "missing"), file: harness.good, yaml: GOOD_YAML }, "missing cwd"],
      [
        { cwd: harness.repo, file: join(harness.playbookDir, "gone.yaml"), yaml: GOOD_YAML },
        "undiscovered file",
      ],
      [{ cwd: harness.repo, file: harness.symlinkInside, yaml: GOOD_YAML }, "symlink"],
      [
        { cwd: harness.repo, file: harness.good, yaml: "x".repeat(PLAYBOOK_TEXT_LIMIT + 1) },
        "buffer over the cap",
      ],
      [{ cwd: harness.repo, file: harness.good }, "absent yaml"],
    ];
    for (const [body, label] of cases) {
      const response = await call(harness.base, "POST", "/playbooks/validate", { body });
      expect(response.status, `${label}: ${response.text}`).toBe(400);
      expect(errorCode(response.body), label).toBe("invalid_request");
    }

    expect(snapshot(harness.root)).toEqual(before);

    const anonymous = await fetch(`${harness.base}/playbooks/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: harness.repo, file: harness.good, yaml: GOOD_YAML }),
    });
    expect(anonymous.status).toBe(401);
    expect(errorCode(await anonymous.json())).toBe("unauthorized");

    const wrongMethod = await call(harness.base, "GET", "/playbooks/validate");
    expect(wrongMethod.status).toBe(405);
    expect(errorCode(wrongMethod.body)).toBe("method_not_allowed");
  });
});

/** The verdict a `GET` body carries, minus the read-only extras (`cwd`, `file`, `yaml`, `sha256`). */
function verdictOf(read: PlaybookFileResponse): PlaybookVerdict {
  const { playbookId, valid, errors, warnings, hash, graph } = read;
  const verdict: PlaybookVerdict = { playbookId, valid, errors, warnings };
  if (hash !== undefined) Object.assign(verdict, { hash });
  if (graph !== undefined) Object.assign(verdict, { graph });
  return verdict;
}
