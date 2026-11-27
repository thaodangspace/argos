/**
 * `GET /playbooks?issues=1` (editor FR8): the opt-in per-issue detail on each `errors[]` entry, and
 * the promise that makes it safe — without the flag the listing serializes byte for byte as before.
 *
 * The pin below is a raw string on purpose: a shape assertion would not catch a reordered or newly
 * added key, and the compatibility promise is about the bytes a client parses.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ArgosError } from "../../src/errors.js";
import {
  PLAYBOOK_ISSUE_LIMIT,
  PlaybookListResponseSchema,
  type PlaybookListResponse,
} from "../../src/rpc/contracts.js";
import { listPlaybooks, toPlaybookLoadError } from "../../src/rpc/playbooks.js";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Write one playbook file under `<root>/.argos/playbooks/` (or a `.paseo` root when asked). */
function writePlaybook(root: string, id: string, body: string, paseo = false): string {
  const dir = paseo
    ? join(root, ".paseo", "plugins", "playbooks")
    : join(root, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.yaml`);
  writeFileSync(file, body, "utf8");
  return file;
}

const GOOD_YAML = "title: Demo\nsteps:\n  - id: a\n    prompt: hi\n";

const BROKEN_YAML = `title: Broken
unknown_key_here: true
steps:
  - id: a
    prompt: hi
`;

/** 25 unknown keys: the loader caps its own list at 20, so this proves the projection never grows. */
const MANY_YAML = `title: Many
${Array.from({ length: 25 }, (_, index) => `typo${index}: ${index}`).join("\n")}
steps:
  - id: a
    prompt: hi
`;

/** Valid schema, broken graph: `playbook_invalid` with **no** loader issues to publish. */
const UNLINKED_YAML = `title: Unlinked
steps:
  - id: a
    prompt: hi
    needs: [nope]
`;

/** A repository with one good file and three that fail in three different ways. */
function fixtureRepo(): { repo: string; home: string } {
  const repo = tempRoot("argos-issues-");
  const home = tempRoot("argos-issues-home-");
  writePlaybook(repo, "good", GOOD_YAML);
  writePlaybook(repo, "broken", BROKEN_YAML);
  writePlaybook(repo, "many", MANY_YAML);
  writePlaybook(repo, "unlinked", UNLINKED_YAML);
  return { repo, home };
}

/** The exact bytes the route sends: `server.ts` parses before serializing, so pin the parsed body. */
function wire(cwd: string, home: string | undefined, issues?: boolean): string {
  const listing: PlaybookListResponse = listPlaybooks(
    cwd,
    home,
    issues === undefined ? {} : { issues },
  );
  return JSON.stringify(PlaybookListResponseSchema.parse(listing));
}

afterAll(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("GET /playbooks?issues=1", () => {
  it("omits the flag and serializes byte for byte as before", () => {
    const { repo, home } = fixtureRepo();
    // (a) the two spellings of "not asked" are one string, and no entry carries an `issues` key.
    expect(wire(repo, home, false)).toBe(wire(repo, home, undefined));
    const listing = PlaybookListResponseSchema.parse(listPlaybooks(repo, home));
    expect(listing.errors.length).toBeGreaterThan(0);
    for (const entry of listing.errors) expect(entry).not.toHaveProperty("issues");
  });

  it("carries the loader's issues per broken file, capped at PLAYBOOK_ISSUE_LIMIT", () => {
    const { repo, home } = fixtureRepo();
    const listing = PlaybookListResponseSchema.parse(
      listPlaybooks(repo, home, { issues: true }),
    );
    const byFile = new Map(listing.errors.map((entry) => [entry.file.split("/").pop(), entry]));

    const broken = byFile.get("broken.yaml");
    expect(broken?.code).toBe("playbook_invalid");
    expect(broken?.issues).toEqual([
      { path: "unknown_key_here", message: 'unrecognized key "unknown_key_here"' },
    ]);

    // The loader stops at 20; the projection keeps every one of them and never more.
    const many = byFile.get("many.yaml");
    expect(PLAYBOOK_ISSUE_LIMIT).toBe(20);
    expect(many?.issues).toHaveLength(PLAYBOOK_ISSUE_LIMIT);
    expect(many?.issues?.[0]).toEqual({ path: "typo0", message: 'unrecognized key "typo0"' });

    // A graph failure carries no loader issues, so the key stays out instead of becoming `[]`.
    const unlinked = byFile.get("unlinked.yaml");
    expect(unlinked?.code).toBe("playbook_invalid");
    expect(unlinked).not.toHaveProperty("issues");
  });

  it("leaves a file that loads out of errors[] entirely", () => {
    const { repo, home } = fixtureRepo();
    const listing = PlaybookListResponseSchema.parse(
      listPlaybooks(repo, home, { issues: true }),
    );
    expect(listing.playbooks.map((playbook) => playbook.id)).toEqual(["good"]);
    expect(listing.errors.map((entry) => entry.file.split("/").pop())).toEqual([
      "broken.yaml",
      "many.yaml",
      "unlinked.yaml",
    ]);
    // Nothing about a valid playbook is reported as an error, so it has no `issues` to carry.
    expect(listing.errors.some((entry) => entry.file.endsWith("good.yaml"))).toBe(false);
  });

  it("stays status-quo for a .paseo listing too", () => {
    const repo = tempRoot("argos-issues-paseo-");
    writePlaybook(repo, "upstream", "title: Upstream\nhidden: true\nsteps:\n  - id: a\n    prompt: hi\n", true);
    expect(wire(repo, undefined, false)).toBe(wire(repo, undefined));
  });
});

describe("toPlaybookLoadError", () => {
  it("caps a failure that carries more issues than the contract publishes", () => {
    const issues = Array.from({ length: PLAYBOOK_ISSUE_LIMIT + 5 }, (_, index) => ({
      path: `steps.${index}`,
      stepId: `s${index}`,
      message: "expected a string",
    }));
    const error = new ArgosError("playbook_invalid", "broken", { issues });
    const entry = toPlaybookLoadError("/repo/broken.yaml", error, true);
    expect(entry.issues).toHaveLength(PLAYBOOK_ISSUE_LIMIT);
    expect(entry.issues?.[0]).toEqual({ path: "steps.0", stepId: "s0", message: "expected a string" });
  });

  it("drops the key without the flag and for a non-Argos failure", () => {
    const error = new ArgosError("playbook_invalid", "broken", {
      issues: [{ path: "steps", message: "expected an array" }],
    });
    expect(toPlaybookLoadError("/repo/broken.yaml", error, false)).not.toHaveProperty("issues");
    expect(toPlaybookLoadError("/repo/broken.yaml", error, false).code).toBe("playbook_invalid");

    const foreign = toPlaybookLoadError("/repo/broken.yaml", new Error("boom"), true);
    expect(foreign.code).toBe("playbook_invalid");
    expect(foreign).not.toHaveProperty("issues");
  });
});

describe("default GET /playbooks body (byte-identical pin)", () => {
  it("serializes the literal pre-editor JSON", () => {
    const repo = tempRoot("argos-pin-");
    writePlaybook(repo, "demo", GOOD_YAML);
    writePlaybook(repo, "broken", BROKEN_YAML);

    const expected =
      `{"cwd":"${repo}","playbooks":[{"id":"demo",` +
      `"file":"${repo}/.argos/playbooks/demo.yaml",` +
      `"hash":"7d6a63ee28867e11686990ee2561a1cfa17b57dbc3d061785ff3a1ea4f45a8ca",` +
      `"inputs":[],"stepCount":1}],"errors":[{"file":"${repo}/.argos/playbooks/broken.yaml",` +
      `"code":"playbook_invalid","message":"${repo}/.argos/playbooks/broken.yaml: ` +
      `unknown_key_here: unrecognized key \\"unknown_key_here\\""}]}`;

    expect(wire(repo, undefined)).toBe(expected);
    expect(wire(repo, undefined, false)).toBe(expected);
  });
});
