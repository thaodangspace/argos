/**
 * The editor's containment (spec FR4, FR5, FR15, FR18) — the one place a `file` from the wire is
 * turned into a discovered playbook path, plus the digest a save is preconditioned on.
 *
 * Containment is a security control, so every refusal below has its own case: delete the check it
 * exercises and at least one of these tests fails. No `ArgosHost` and no HTTP here — the point of
 * `playbook-write.ts` is that the matrix is testable on its own; `server.ts` owns the cwd rules.
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
import { join, relative, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isArgosError, type ArgosError } from "../../src/errors.js";
import { loadPlaybook } from "../../src/playbook/load.js";
import { PLAYBOOK_TEXT_LIMIT } from "../../src/rpc/contracts.js";
import { readPlaybookFile, validatePlaybookBuffer } from "../../src/rpc/playbooks.js";
import { readPlaybookSource, resolvePlaybookTarget } from "../../src/rpc/playbook-write.js";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const GOOD_YAML = "title: Good\nsteps:\n  - id: a\n    prompt: hi\n";
const FALLBACK_YAML = "title: Fallback\nsteps:\n  - id: a\n    prompt: hi\n";
const GLOBAL_YAML = "title: Global\nsteps:\n  - id: a\n    prompt: hi\n";
const BROKEN_YAML = "title: Broken\nunknown_key_here: true\nsteps:\n  - id: a\n    prompt: hi\n";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

interface Fixture {
  readonly repo: string;
  readonly sibling: string;
  readonly home: string;
  readonly good: string;
  readonly fallback: string;
  readonly global: string;
  readonly broken: string;
  readonly oversized: string;
  readonly symlinkOutside: string;
  readonly symlinkInside: string;
  readonly playbookDir: string;
}

function writeFixture(): Fixture {
  const repo = tempRoot("argos-editor-repo-");
  const sibling = tempRoot("argos-editor-sibling-");
  const home = tempRoot("argos-editor-home-");
  const playbookDir = join(repo, ".argos", "playbooks");
  const fallbackDir = join(repo, ".paseo", "plugins", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  mkdirSync(fallbackDir, { recursive: true });
  mkdirSync(join(home, "playbooks"), { recursive: true });
  mkdirSync(join(sibling, ".argos", "playbooks"), { recursive: true });

  const good = join(playbookDir, "good.yaml");
  writeFileSync(good, GOOD_YAML, "utf8");
  const broken = join(playbookDir, "broken.yaml");
  writeFileSync(broken, BROKEN_YAML, "utf8");
  const oversized = join(playbookDir, "oversized.yaml");
  writeFileSync(oversized, `# ${"x".repeat(PLAYBOOK_TEXT_LIMIT)}\n`, "utf8");
  const fallback = join(fallbackDir, "fallback.yaml");
  writeFileSync(fallback, FALLBACK_YAML, "utf8");
  const global = join(home, "playbooks", "global.yaml");
  writeFileSync(global, GLOBAL_YAML, "utf8");
  writeFileSync(join(sibling, ".argos", "playbooks", "good.yaml"), GOOD_YAML, "utf8");

  // A link at the repository root, and one *inside* a writable root: the second is the interesting
  // bypass, because its realpath is a discovered entry and only the `lstat` re-check refuses it.
  const symlinkOutside = join(repo, "link.yaml");
  symlinkSync(good, symlinkOutside);
  const symlinkInside = join(playbookDir, "alias.yaml");
  symlinkSync(good, symlinkInside);

  return {
    repo,
    sibling,
    home,
    good,
    fallback,
    global,
    broken,
    oversized,
    symlinkOutside,
    symlinkInside,
    playbookDir,
  };
}

/** The `ArgosError` a refusal throws; fails loudly if the call answers instead. */
function refusal(action: () => unknown): ArgosError {
  try {
    action();
  } catch (error) {
    if (isArgosError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

/** Names, contents, and symlink targets of a tree: what "wrote nothing" is measured against. */
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

describe("resolvePlaybookTarget containment (FR4, FR18)", () => {
  it("accepts a repository playbook from both writable roots with the realpath and its digest", () => {
    const fixture = writeFixture();

    const argos = resolvePlaybookTarget({ cwd: fixture.repo, file: fixture.good });
    expect(argos).toEqual({
      file: realpathSync(fixture.good),
      repoDir: resolve(fixture.repo),
      id: "good",
      root: ".argos/playbooks",
      mode: "repo",
      writable: true,
      sha256: sha256(GOOD_YAML),
    });

    const paseo = resolvePlaybookTarget({ cwd: fixture.repo, file: fixture.fallback });
    expect(paseo.root).toBe(".paseo/plugins/playbooks");
    expect(paseo.id).toBe("fallback");
    expect(paseo.mode).toBe("repo");
    expect(paseo.writable).toBe(true);
    expect(paseo.sha256).toBe(sha256(FALLBACK_YAML));
  });

  it("resolves a home playbook read-only, so a save can never reach it (FR5)", () => {
    const fixture = writeFixture();

    const target = resolvePlaybookTarget({
      cwd: fixture.repo,
      file: fixture.global,
      home: fixture.home,
    });
    expect(target.id).toBe("global");
    expect(target.mode).toBe("home");
    expect(target.writable).toBe(false);
    expect(target.root).toBe(resolve(fixture.home, "playbooks"));
    expect(target.file).toBe(realpathSync(fixture.global));
    // Readable despite the home being outside `cwd`: the listing produced it.
    expect(readPlaybookSource(target)).toEqual({ yaml: GLOBAL_YAML, sha256: sha256(GLOBAL_YAML) });
  });

  it("refuses an absolute path discovery did not produce", () => {
    const fixture = writeFixture();
    const stray = join(fixture.repo, "notes.yaml");
    writeFileSync(stray, GOOD_YAML, "utf8");

    const error = refusal(() => resolvePlaybookTarget({ cwd: fixture.repo, file: stray }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).not.toContain(fixture.repo);
  });

  it("refuses a relative path", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: ".argos/playbooks/good.yaml" }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("refuses a path carrying a NUL byte", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: `${fixture.good}\u0000suffix` }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it('refuses a ".." segment even when it collapses onto a discovered file', () => {
    const fixture = writeFixture();
    // Built by concatenation on purpose: `join` would normalize the `..` away before the helper
    // ever sees it, and the helper must refuse the spelling, not a collapsed path.
    const traversal = `${fixture.playbookDir}/../playbooks/good.yaml`;

    const error = refusal(() => resolvePlaybookTarget({ cwd: fixture.repo, file: traversal }));
    expect(error.code).toBe("invalid_request");
  });

  it("refuses a symlink to a real playbook, from the root and from inside a writable root", () => {
    const fixture = writeFixture();

    for (const link of [fixture.symlinkOutside, fixture.symlinkInside]) {
      const error = refusal(() => resolvePlaybookTarget({ cwd: fixture.repo, file: link }));
      expect(error.code, link).toBe("invalid_request");
      expect(error.message, link).not.toContain("good.yaml");
    }
  });

  it("refuses a directory", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: fixture.playbookDir }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("refuses a missing file", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: join(fixture.playbookDir, "gone.yaml") }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("refuses a file over PLAYBOOK_TEXT_LIMIT and names the limit", () => {
    const fixture = writeFixture();
    expect(readFileSync(fixture.oversized).byteLength).toBeGreaterThan(PLAYBOOK_TEXT_LIMIT);

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: fixture.oversized }),
    );
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain(String(PLAYBOOK_TEXT_LIMIT));
  });

  it("refuses a playbook of a sibling repository", () => {
    const fixture = writeFixture();
    const siblingFile = join(fixture.sibling, ".argos", "playbooks", "good.yaml");

    const error = refusal(() =>
      resolvePlaybookTarget({ cwd: fixture.repo, file: siblingFile }),
    );
    expect(error.code).toBe("invalid_request");
  });
});

describe("readPlaybookFile (FR1, FR2)", () => {
  it("publishes the text and the digest of the same bytes, with the loader's verdict", () => {
    const fixture = writeFixture();

    const read = readPlaybookFile({ cwd: fixture.repo, file: fixture.good });
    expect(read).toMatchObject({
      cwd: fixture.repo,
      file: realpathSync(fixture.good),
      playbookId: "good",
      valid: true,
      errors: [],
      yaml: GOOD_YAML,
      sha256: sha256(GOOD_YAML),
      hash: loadPlaybook(fixture.repo, "good").hash,
    });
    expect(read).not.toHaveProperty("graph");
  });

  it("answers a broken file with valid: false and the loader's issues, so it stays editable", () => {
    const fixture = writeFixture();

    const read = readPlaybookFile({ cwd: fixture.repo, file: fixture.broken });
    expect(read.valid).toBe(false);
    expect(read.yaml).toBe(BROKEN_YAML);
    expect(read).not.toHaveProperty("hash");
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]?.code).toBe("playbook_invalid");
    expect(read.errors[0]?.issues?.map((issue) => issue.path)).toContain("unknown_key_here");
  });
});

describe("validatePlaybookBuffer (FR6, FR7)", () => {
  it("gives the on-disk load's verdict for the on-disk text, hash included", () => {
    const fixture = writeFixture();
    const disk = loadPlaybook(fixture.repo, "good");

    const verdict = validatePlaybookBuffer({
      cwd: fixture.repo,
      file: fixture.good,
      yaml: GOOD_YAML,
    });
    expect(verdict).toEqual({
      playbookId: "good",
      valid: true,
      errors: [],
      warnings: [],
      hash: disk.hash,
    });
  });

  it("reports an invalid buffer as a verdict, not a thrown error", () => {
    const fixture = writeFixture();

    const verdict = validatePlaybookBuffer({
      cwd: fixture.repo,
      file: fixture.good,
      yaml: BROKEN_YAML,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors[0]?.code).toBe("playbook_invalid");
    expect(verdict.errors[0]?.issues?.[0]?.path).toBe("unknown_key_here");
  });

  it("validates a home playbook's buffer against its home identity", () => {
    const fixture = writeFixture();

    const verdict = validatePlaybookBuffer({
      cwd: fixture.repo,
      file: fixture.global,
      yaml: GLOBAL_YAML,
      home: fixture.home,
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.hash).toBe(loadPlaybook(fixture.repo, "global", { home: fixture.home }).hash);
  });

  it("adds the graph only when asked", () => {
    const fixture = writeFixture();
    const plain = validatePlaybookBuffer({ cwd: fixture.repo, file: fixture.good, yaml: GOOD_YAML });
    const graph = validatePlaybookBuffer({
      cwd: fixture.repo,
      file: fixture.good,
      yaml: GOOD_YAML,
      graph: true,
    });

    expect(plain).not.toHaveProperty("graph");
    expect(graph.graph?.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("refuses a buffer over PLAYBOOK_TEXT_LIMIT and names the limit", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      validatePlaybookBuffer({
        cwd: fixture.repo,
        file: fixture.good,
        yaml: `# ${"x".repeat(PLAYBOOK_TEXT_LIMIT)}\n`,
      }),
    );
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain(String(PLAYBOOK_TEXT_LIMIT));
  });

  it("applies the same containment as a read", () => {
    const fixture = writeFixture();

    const error = refusal(() =>
      validatePlaybookBuffer({
        cwd: fixture.repo,
        file: fixture.symlinkInside,
        yaml: GOOD_YAML,
      }),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("writes nothing: the repository is byte-identical before and after", () => {
    const fixture = writeFixture();
    const before = snapshot(fixture.repo);

    validatePlaybookBuffer({ cwd: fixture.repo, file: fixture.good, yaml: GOOD_YAML });
    validatePlaybookBuffer({ cwd: fixture.repo, file: fixture.good, yaml: BROKEN_YAML });
    validatePlaybookBuffer({ cwd: fixture.repo, file: fixture.broken, yaml: BROKEN_YAML });
    readPlaybookFile({ cwd: fixture.repo, file: fixture.broken });

    expect(snapshot(fixture.repo)).toEqual(before);
  });
});
