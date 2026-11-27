/**
 * The editor's write route (`PUT /playbooks/file`, spec FR9–FR13, FR17, FR18) over a real
 * file-backed host and a real repository checkout.
 *
 * This route is the whole security delta of the editor: the only place in Argos that writes a
 * repository file. Every refusal therefore gets its own assertion — a stale digest (`409 changed`),
 * a file that is gone (`409 deleted`), an absent precondition (`400`), a home playbook (`400`,
 * read-only), an oversized buffer (`400`), a cookie without this `Origin` (`401`), an invalid buffer
 * (`422` with the loader's issues). "Nothing was written" is measured against the directory listing
 * and the bytes on disk, and the temp name the atomic write uses is asserted absent in every case.
 *
 * The last test pins the contract that makes an edit during a live run safe: the run holds the IR
 * and hash it started with, so a save cannot retarget work that is already in flight.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { resolveRunRequest } from "../../src/durable/run-request.js";
import {
  PLAYBOOK_TEXT_LIMIT,
  PlaybookFileResponseSchema,
  PlaybookSaveResponseSchema,
  type PlaybookFileResponse,
  type PlaybookSaveResponse,
} from "../../src/rpc/contracts.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { UI_COOKIE_NAME } from "../../src/rpc/session.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, type TempHome } from "../durable/support.js";

const TOKEN = "playbook-write-token-0123456789";

const GOOD_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: hi\n";
const EDITED_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: edited\n";
const SECOND_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: edited twice\n";
/** A step-level typo, so the loader reports a `stepId` beside the issue path. */
const BROKEN_YAML =
  "title: Good\nsteps:\n  - id: a\n    prompt: hi\n    promt: MARKER-NOT-IN-ANY-LOG\n";

const UI_INDEX = "<!doctype html><title>argos</title>";

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly playbookDir: string;
  readonly good: string;
  readonly mode: string;
  readonly fallback: string;
  readonly global: string;
  readonly ui: string;
}

interface Harness extends Fixture {
  readonly host: ArgosHost;
  readonly server: RpcServer;
  readonly base: string;
  readonly home: TempHome;
  /** Everything the server logged; FR19 says no playbook content may ever appear here. */
  readonly logs: string[];
}

const openHarnesses: Harness[] = [];

function makeFixture(home: TempHome): Fixture {
  const root = mkdtempSync(join(tmpdir(), "argos-playbook-write-"));
  const repo = join(root, "repo");
  const playbookDir = join(repo, ".argos", "playbooks");
  const fallbackDir = join(repo, ".paseo", "plugins", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  mkdirSync(fallbackDir, { recursive: true });
  mkdirSync(join(home.home, "playbooks"), { recursive: true });
  const ui = join(root, "ui");
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, "index.html"), UI_INDEX, "utf8");

  const good = join(playbookDir, "good.yaml");
  writeFileSync(good, GOOD_YAML, "utf8");
  // FR12: a mode that is neither the umask default nor world-readable must survive a save.
  const mode = join(playbookDir, "mode.yaml");
  writeFileSync(mode, GOOD_YAML, "utf8");
  chmodSync(mode, 0o740);
  // FR18: the upstream fallback root is the second writable directory.
  const fallback = join(fallbackDir, "fallback.yaml");
  writeFileSync(fallback, GOOD_YAML, "utf8");
  const global = join(home.home, "playbooks", "global.yaml");
  writeFileSync(global, GOOD_YAML, "utf8");

  return { root, repo, playbookDir, good, mode, fallback, global, ui };
}

async function startHarness(): Promise<Harness> {
  const home = makeTempHome();
  const fixture = makeFixture(home);
  const logs: string[] = [];
  const host = await ArgosHost.open({ home: home.home, executor: new FakeExecutor() });
  const server = await createRpcServer({
    host,
    home: home.home,
    port: 0,
    token: TOKEN,
    log: (line) => logs.push(line),
    ui: { dir: fixture.ui },
  });
  const harness = { ...fixture, host, server, base: server.url, home, logs };
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

interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

const AUTH: Readonly<Record<string, string>> = { authorization: `Bearer ${TOKEN}` };

async function raw(
  base: string,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: unknown,
): Promise<HttpResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? { ...headers } : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
}

function save(base: string, body: unknown): Promise<HttpResponse> {
  return raw(base, "PUT", "/playbooks/file", AUTH, body);
}

function fileQuery(cwd: string, file: string): string {
  return `/playbooks/file?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`;
}

async function readFile(base: string, cwd: string, file: string): Promise<PlaybookFileResponse> {
  const response = await raw(base, "GET", fileQuery(cwd, file), AUTH);
  expect(response.status, response.text).toBe(200);
  return PlaybookFileResponseSchema.parse(response.body);
}

function errorOf(body: unknown): {
  code: string;
  message: string;
  details?: { file?: string; stepId?: string; reason?: string; issues?: unknown[] };
} {
  return (
    body as {
      error: {
        code: string;
        message: string;
        details?: { file?: string; stepId?: string; reason?: string; issues?: unknown[] };
      };
    }
  ).error;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** The directory's own entries, sorted: what "no temp file and nothing else changed" is measured on. */
function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

function tempFiles(dir: string): string[] {
  return listing(dir).filter((name) => name.includes(".argos-tmp-"));
}

function fileMode(file: string): number {
  return statSync(file).mode & 0o777;
}

function saveBody(
  harness: Harness,
  file: string,
  yaml: string,
  baseSha256: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { cwd: harness.repo, file, yaml, baseSha256, ...extra };
}

const GOOD_YAML_HASH = sha256(GOOD_YAML);

describe("PUT /playbooks/file (FR9–FR13)", () => {
  it("round trips a save through the read route and chains the returned sha256", async () => {
    const harness = await startHarness();
    const before = listing(harness.playbookDir);
    const first = await readFile(harness.base, harness.repo, harness.good);
    expect(first.sha256).toBe(GOOD_YAML_HASH);

    const saved = await save(harness.base, saveBody(harness, harness.good, EDITED_YAML, first.sha256));
    expect(saved.status, saved.text).toBe(200);
    const body: PlaybookSaveResponse = PlaybookSaveResponseSchema.parse(saved.body);
    expect(body.written).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.file).toBe(realpathSync(harness.good));
    expect(body.sha256).toBe(sha256(EDITED_YAML));
    expect(body.mode).toBe(fileMode(harness.good));
    expect(body.hash).toEqual(expect.any(String));
    expect(body.hash).not.toBe(first.hash);
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);

    // The read route is the same view of the same bytes: the save's `sha256` is what chains.
    const reread = await readFile(harness.base, harness.repo, harness.good);
    expect(reread.yaml).toBe(EDITED_YAML);
    expect(reread.sha256).toBe(body.sha256);
    expect(reread.hash).toBe(body.hash);

    const second = await save(
      harness.base,
      saveBody(harness, harness.good, SECOND_YAML, body.sha256, { graph: true }),
    );
    expect(second.status, second.text).toBe(200);
    const secondBody = PlaybookSaveResponseSchema.parse(second.body);
    expect(secondBody.sha256).toBe(sha256(SECOND_YAML));
    // FR13: the graph is opt-in, exactly as on the read and validate routes.
    expect(secondBody.graph?.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(readFileSync(harness.good, "utf8")).toBe(SECOND_YAML);
    expect(listing(harness.playbookDir)).toEqual(before);
  });

  it("keeps the file's mode (0740 stays 0740)", async () => {
    const harness = await startHarness();
    expect(fileMode(harness.mode)).toBe(0o740);

    const read = await readFile(harness.base, harness.repo, harness.mode);
    const saved = await save(harness.base, saveBody(harness, harness.mode, EDITED_YAML, read.sha256));
    expect(saved.status, saved.text).toBe(200);
    expect(PlaybookSaveResponseSchema.parse(saved.body).mode).toBe(0o740);
    expect(fileMode(harness.mode)).toBe(0o740);
    expect(readFileSync(harness.mode, "utf8")).toBe(EDITED_YAML);
  });

  it("saves a playbook under the .paseo fallback root, the second writable directory", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.fallback);

    const saved = await save(
      harness.base,
      saveBody(harness, harness.fallback, EDITED_YAML, read.sha256),
    );
    expect(saved.status, saved.text).toBe(200);
    expect(readFileSync(harness.fallback, "utf8")).toBe(EDITED_YAML);
  });

  it("leaves no temp file behind, on a save or on any refusal", async () => {
    const harness = await startHarness();
    const before = listing(harness.playbookDir);
    const read = await readFile(harness.base, harness.repo, harness.good);

    const saved = await save(harness.base, saveBody(harness, harness.good, EDITED_YAML, read.sha256));
    expect(saved.status, saved.text).toBe(200);
    expect(tempFiles(harness.playbookDir)).toEqual([]);
    expect(listing(harness.playbookDir)).toEqual(before);

    // A refusal of each kind: stale digest, invalid buffer, oversize, home file, no precondition.
    const stale = await save(harness.base, saveBody(harness, harness.good, SECOND_YAML, read.sha256));
    expect(stale.status, stale.text).toBe(409);
    const current = await readFile(harness.base, harness.repo, harness.good);
    const invalid = await save(
      harness.base,
      saveBody(harness, harness.good, BROKEN_YAML, current.sha256),
    );
    expect(invalid.status, invalid.text).toBe(422);
    const oversize = await save(
      harness.base,
      saveBody(harness, harness.good, "é".repeat(PLAYBOOK_TEXT_LIMIT / 2 + 1), current.sha256),
    );
    expect(oversize.status, oversize.text).toBe(400);
    const home = await readFile(harness.base, harness.repo, harness.global);
    const readOnly = await save(
      harness.base,
      saveBody(harness, harness.global, EDITED_YAML, home.sha256),
    );
    expect(readOnly.status, readOnly.text).toBe(400);
    const noBase = await save(harness.base, {
      cwd: harness.repo,
      file: harness.good,
      yaml: SECOND_YAML,
    });
    expect(noBase.status, noBase.text).toBe(400);

    expect(tempFiles(harness.playbookDir)).toEqual([]);
    expect(listing(harness.playbookDir)).toEqual(before);
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);
  });

  it("refuses an invalid buffer with 422 playbook_invalid, its issues, and no write", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);
    const bytesBefore = readFileSync(harness.good);

    const response = await save(
      harness.base,
      saveBody(harness, harness.good, BROKEN_YAML, read.sha256),
    );
    expect(response.status, response.text).toBe(422);
    const error = errorOf(response.body);
    expect(error.code).toBe("playbook_invalid");
    // The loader's own error is rethrown, so `file` is the spelling discovery produced
    // (`<repo>/.argos/playbooks/good.yaml`); it names the same file as the read route's realpath.
    expect(realpathSync(error.details?.file ?? "")).toBe(realpathSync(harness.good));
    expect(error.details?.stepId).toBe("a");
    expect(error.details?.issues).toEqual([
      { path: "steps.0.promt", stepId: "a", message: expect.stringContaining("promt") },
    ]);
    // FR11/FR19: the bytes are untouched, no debris, and the buffer never reaches a log line.
    expect(readFileSync(harness.good).equals(bytesBefore)).toBe(true);
    expect(tempFiles(harness.playbookDir)).toEqual([]);
    for (const line of harness.logs) expect(line).not.toContain("MARKER-NOT-IN-ANY-LOG");
  });

  it("refuses a stale digest with 409 changed and leaves the file alone", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);
    // Another tab (or an editor outside Argos) wrote the file after this read.
    writeFileSync(harness.good, EDITED_YAML, "utf8");

    const response = await save(
      harness.base,
      saveBody(harness, harness.good, SECOND_YAML, read.sha256),
    );
    expect(response.status, response.text).toBe(409);
    const error = errorOf(response.body);
    expect(error.code).toBe("playbook_conflict");
    expect(error.details?.reason).toBe("changed");
    expect(error.details?.file).toBe(realpathSync(harness.good));
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);
    expect(tempFiles(harness.playbookDir)).toEqual([]);
  });

  it("answers 409 deleted when the file is gone", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);
    rmSync(harness.good);

    const response = await save(
      harness.base,
      saveBody(harness, harness.good, EDITED_YAML, read.sha256),
    );
    expect(response.status, response.text).toBe(409);
    const error = errorOf(response.body);
    expect(error.code).toBe("playbook_conflict");
    expect(error.details?.reason).toBe("deleted");
    // A save never resurrects a file: the path stays gone and nothing was written beside it.
    expect(listing(harness.playbookDir)).toEqual(["mode.yaml"]);
    expect(tempFiles(harness.playbookDir)).toEqual([]);
  });

  it("requires a baseSha256 and the save's shape (400 invalid_request)", async () => {
    const harness = await startHarness();
    const before = listing(harness.playbookDir);

    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ cwd: harness.repo, file: harness.good, yaml: EDITED_YAML }, "absent baseSha256"],
      [
        { cwd: harness.repo, file: harness.good, yaml: EDITED_YAML, baseSha256: "not-a-digest" },
        "malformed baseSha256",
      ],
      [
        {
          cwd: harness.repo,
          file: harness.good,
          yaml: EDITED_YAML,
          baseSha256: GOOD_YAML_HASH,
          extra: 1,
        },
        "unknown body key",
      ],
      [
        { cwd: "relative/repo", file: harness.good, yaml: EDITED_YAML, baseSha256: GOOD_YAML_HASH },
        "relative cwd",
      ],
      [
        { cwd: harness.repo, file: "relative.yaml", yaml: EDITED_YAML, baseSha256: GOOD_YAML_HASH },
        "relative file",
      ],
    ];
    for (const [body, label] of cases) {
      const response = await save(harness.base, body);
      expect(response.status, `${label}: ${response.text}`).toBe(400);
      expect(errorOf(response.body).code, label).toBe("invalid_request");
    }

    expect(readFileSync(harness.good, "utf8")).toBe(GOOD_YAML);
    expect(listing(harness.playbookDir)).toEqual(before);
  });

  it("refuses a home playbook with 400 and says it is read-only", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.global);

    const response = await save(
      harness.base,
      saveBody(harness, harness.global, EDITED_YAML, read.sha256),
    );
    expect(response.status, response.text).toBe(400);
    const error = errorOf(response.body);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("read-only");
    expect(error.details?.file).toBe(realpathSync(harness.global));
    expect(readFileSync(harness.global, "utf8")).toBe(GOOD_YAML);
  });

  it("refuses a buffer over PLAYBOOK_TEXT_LIMIT with 400 and writes nothing", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);

    // Two refusals with the same answer: the schema's `max` (UTF-16 length) and the byte cap the
    // helper enforces. The second is the one a multi-byte buffer reaches.
    const ascii = await save(
      harness.base,
      saveBody(harness, harness.good, "x".repeat(PLAYBOOK_TEXT_LIMIT + 1), read.sha256),
    );
    expect(ascii.status, ascii.text).toBe(400);
    expect(errorOf(ascii.body).code).toBe("invalid_request");

    const multiByte = "é".repeat(PLAYBOOK_TEXT_LIMIT / 2 + 1);
    expect(multiByte.length).toBeLessThanOrEqual(PLAYBOOK_TEXT_LIMIT);
    expect(Buffer.byteLength(multiByte, "utf8")).toBeGreaterThan(PLAYBOOK_TEXT_LIMIT);
    const bytes = await save(harness.base, saveBody(harness, harness.good, multiByte, read.sha256));
    expect(bytes.status, bytes.text).toBe(400);
    const error = errorOf(bytes.body);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain(String(PLAYBOOK_TEXT_LIMIT));

    expect(readFileSync(harness.good, "utf8")).toBe(GOOD_YAML);
    expect(tempFiles(harness.playbookDir)).toEqual([]);
  });

  it("needs a token, and a cookie write needs this origin", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);

    const anonymous = await raw(
      harness.base,
      "PUT",
      "/playbooks/file",
      {},
      saveBody(harness, harness.good, EDITED_YAML, read.sha256),
    );
    expect(anonymous.status).toBe(401);
    expect(errorOf(anonymous.body).code).toBe("unauthorized");

    const wrongMethod = await raw(harness.base, "PATCH", "/playbooks/file", AUTH);
    expect(wrongMethod.status).toBe(405);
    expect(errorOf(wrongMethod.body).code).toBe("method_not_allowed");

    // The UI shell is what hands out the session cookie (FR17); the cookie alone is not enough.
    const shell = await fetch(`${harness.base}/ui/`);
    expect(shell.status).toBe(200);
    const setCookie = shell.headers.getSetCookie()[0] ?? "";
    expect(setCookie.startsWith(`${UI_COOKIE_NAME}=`)).toBe(true);
    const cookie = setCookie.split(";")[0] ?? "";
    const host = new URL(harness.base).host;

    const foreign = await raw(
      harness.base,
      "PUT",
      "/playbooks/file",
      { cookie, origin: "http://127.0.0.1:3000" },
      saveBody(harness, harness.good, EDITED_YAML, read.sha256),
    );
    expect(foreign.status).toBe(401);
    expect(errorOf(foreign.body).code).toBe("unauthorized");
    expect(readFileSync(harness.good, "utf8")).toBe(GOOD_YAML);

    // The same cookie, same origin: accepted (proves the 401 above is the Origin rule, not the
    // cookie), and the bearer-less write is a real save.
    const sameOrigin = await raw(
      harness.base,
      "PUT",
      "/playbooks/file",
      { cookie, origin: `http://${host}` },
      saveBody(harness, harness.good, EDITED_YAML, read.sha256),
    );
    expect(sameOrigin.status, sameOrigin.text).toBe(200);
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);
  });

  it.skipIf(process.getuid?.() === 0)(
    "answers 500 and leaves no temp file when the write itself fails",
    async () => {
      const harness = await startHarness();
      const before = listing(harness.playbookDir);
      const read = await readFile(harness.base, harness.repo, harness.good);
      // The file stays readable; only creating the sibling temp file is refused (a real I/O failure,
      // which is `500 internal_error` and not a refusal the client can act on).
      chmodSync(harness.playbookDir, 0o500);
      try {
        const response = await save(
          harness.base,
          saveBody(harness, harness.good, EDITED_YAML, read.sha256),
        );
        expect(response.status, response.text).toBe(500);
        expect(errorOf(response.body).code).toBe("internal_error");
      } finally {
        chmodSync(harness.playbookDir, 0o755);
      }

      expect(tempFiles(harness.playbookDir)).toEqual([]);
      expect(listing(harness.playbookDir)).toEqual(before);
      expect(readFileSync(harness.good, "utf8")).toBe(GOOD_YAML);
    },
  );

  it("answers 405 for a method the path does not have", async () => {
    const harness = await startHarness();
    const response = await raw(harness.base, "DELETE", "/playbooks/file", AUTH);
    expect(response.status).toBe(405);
    expect(errorOf(response.body).code).toBe("method_not_allowed");
  });

  it("two saves from the same baseSha256: the second is 409 changed", async () => {
    const harness = await startHarness();
    const read = await readFile(harness.base, harness.repo, harness.good);

    const first = await save(harness.base, saveBody(harness, harness.good, EDITED_YAML, read.sha256));
    expect(first.status, first.text).toBe(200);

    const second = await save(harness.base, saveBody(harness, harness.good, SECOND_YAML, read.sha256));
    expect(second.status, second.text).toBe(409);
    expect(errorOf(second.body).details?.reason).toBe("changed");
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);
  });

  it("saves during a live run and leaves that run's frozen IR and hash unchanged", async () => {
    const harness = await startHarness();
    // Started the way `POST /runs` and a fire do: the loader's frozen IR, handed to `startRun`.
    const resolved = resolveRunRequest({ playbookId: "good", cwd: harness.repo });
    const started = await harness.host.startRun({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
    });
    const before = await waitForLiveRun(harness.host, started.runId);
    expect(before.status).not.toBe("completed");
    expect(before.ir.hash).toBe(resolved.ir.hash);

    const read = await readFile(harness.base, harness.repo, harness.good);
    const saved = await save(harness.base, saveBody(harness, harness.good, EDITED_YAML, read.sha256));
    expect(saved.status, saved.text).toBe(200);
    expect(readFileSync(harness.good, "utf8")).toBe(EDITED_YAML);

    // Definition freeze: the file on disk changed, the run's record did not.
    const after = await harness.host.getRun(started.runId);
    expect(after).toBeDefined();
    expect(after?.record.status).toBe(before.status);
    expect(after?.record.ir.hash).toBe(before.ir.hash);
    expect(after?.record.playbookHash).toBe(before.playbookHash);
    expect(JSON.stringify(after?.record.ir)).toBe(JSON.stringify(before.ir));

    // And a *new* start reads the new bytes, so the freeze belongs to the run, not to a cache.
    const reloaded = resolveRunRequest({ playbookId: "good", cwd: harness.repo });
    expect(reloaded.ir.hash).not.toBe(before.ir.hash);
  });
});

/**
 * The run record as soon as the host has picked the run up. A fresh `startRun` commits the record
 * and resumes the task asynchronously, so the first read can still say `pending`; either state is
 * live, and waiting for one keeps the freeze assertion honest about a run that is genuinely running.
 */
async function waitForLiveRun(
  host: ArgosHost,
  runId: string,
): Promise<NonNullable<Awaited<ReturnType<ArgosHost["getRun"]>>>["record"]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const doc = await host.getRun(runId);
    if (doc !== undefined && doc.record.status !== "pending") return doc.record;
    if (Date.now() > deadline) {
      if (doc === undefined) throw new Error(`run ${runId} was not mirrored`);
      return doc.record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
