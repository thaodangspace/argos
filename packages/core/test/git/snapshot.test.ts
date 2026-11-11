/**
 * D8 snapshots (FR23) — the evidence the read-only guard compares, without a host or an engine.
 *
 * The last two tests are the documented limitation: detection only, and only of what
 * `git status --porcelain=v1 -z` reports.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeSnapshotChange,
  parseStatusZ,
  snapshotChanged,
  takeSnapshot,
} from "../../src/git/snapshot.js";
import { makeTempRepo } from "../support/git.js";

describe("parseStatusZ", () => {
  it("parses modifications, untracked entries, and renames", () => {
    // ` M a.txt`, `?? b.txt`, `R  renamed.txt <- a.txt`
    const raw = [" M a.txt", "?? b.txt", "R  renamed.txt", "a.txt", ""].join("\0");
    expect(parseStatusZ(raw)).toEqual([
      { code: " M", path: "a.txt" },
      { code: "??", path: "b.txt" },
      { code: "R ", path: "renamed.txt", from: "a.txt" },
    ]);
  });

  it("keeps staged and unstaged codes distinct and ignores the trailing empty field", () => {
    expect(parseStatusZ("M  a.txt\0 M a.txt\0\0")).toEqual([
      { code: "M ", path: "a.txt" },
      { code: " M", path: "a.txt" },
    ]);
    expect(parseStatusZ("")).toEqual([]);
  });
});

describe("snapshotChanged", () => {
  const clean = { head: "a", files: [] } as const;

  it("reports no change for identical snapshots", () => {
    expect(snapshotChanged(clean, { ...clean, files: [] })).toEqual({
      changed: false,
      headChanged: false,
      files: [],
    });
  });

  it("reports HEAD movement, added, removed, and recoded files", () => {
    expect(snapshotChanged(clean, { head: "b", files: [] })).toMatchObject({
      changed: true,
      headChanged: true,
    });
    expect(
      snapshotChanged(clean, { head: "a", files: [{ code: "??", path: "new.txt" }] }),
    ).toEqual({ changed: true, headChanged: false, files: ["new.txt"] });
    expect(
      snapshotChanged({ head: "a", files: [{ code: "??", path: "gone.txt" }] }, clean),
    ).toEqual({ changed: true, headChanged: false, files: ["gone.txt"] });
    // Same path, different code: the working tree changed even though the path did not.
    expect(
      snapshotChanged(
        { head: "a", files: [{ code: " M", path: "a.txt" }] },
        { head: "a", files: [{ code: "M ", path: "a.txt" }] },
      ),
    ).toEqual({ changed: true, headChanged: false, files: ["a.txt"] });
  });

  it("sorts the changed paths so the evidence is deterministic", () => {
    const comparison = snapshotChanged(clean, {
      head: "a",
      files: [
        { code: "??", path: "z.txt" },
        { code: "??", path: "a.txt" },
      ],
    });
    expect(comparison.files).toEqual(["a.txt", "z.txt"]);
    expect(describeSnapshotChange(comparison)).toBe("a.txt, z.txt");
  });
});

describe("takeSnapshot", () => {
  it("records HEAD and the working-tree entries of a real repository", async () => {
    const repo = makeTempRepo();
    try {
      const snapshot = await takeSnapshot(repo.repo);
      expect(snapshot.head).toBe(repo.headSha);
      expect(snapshot.files).toEqual([]);

      writeFileSync(join(repo.repo, "notes.txt"), "draft\n");
      const dirty = await takeSnapshot(repo.repo);
      expect(dirty.head).toBe(repo.headSha);
      expect(dirty.files).toEqual([{ code: "??", path: "notes.txt" }]);
      expect(snapshotChanged(snapshot, dirty)).toEqual({
        changed: true,
        headChanged: false,
        files: ["notes.txt"],
      });
    } finally {
      repo.cleanup();
    }
  });

  it("is null-headed in a repository with no commit yet", async () => {
    const repo = makeTempRepo();
    try {
      const fresh = join(repo.root, "fresh");
      mkdirSync(fresh);
      repo.git(["init", "--quiet"], fresh);
      const snapshot = await takeSnapshot(fresh);
      expect(snapshot.head).toBeNull();
      expect(snapshot.files).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it("detects a deleted untracked file but not a create-then-delete inside a step (D8 limitation)", async () => {
    const repo = makeTempRepo();
    try {
      const before = await takeSnapshot(repo.repo);
      // What a step that creates and removes a file leaves behind: nothing.
      writeFileSync(join(repo.repo, "temporary.txt"), "x\n");
      rmSync(join(repo.repo, "temporary.txt"));
      expect(snapshotChanged(before, await takeSnapshot(repo.repo)).changed).toBe(false);

      // An untracked file that existed before the step and is deleted by it is detected.
      writeFileSync(join(repo.repo, "kept.txt"), "x\n");
      const withFile = await takeSnapshot(repo.repo);
      rmSync(join(repo.repo, "kept.txt"));
      expect(snapshotChanged(withFile, await takeSnapshot(repo.repo))).toEqual({
        changed: true,
        headChanged: false,
        files: ["kept.txt"],
      });
    } finally {
      repo.cleanup();
    }
  });

  it("fails loudly outside a git working tree", async () => {
    const repo = makeTempRepo();
    try {
      const plain = join(repo.root, "not-a-repo");
      mkdirSync(plain);
      await expect(takeSnapshot(plain)).rejects.toThrow(/git status/);
    } finally {
      repo.cleanup();
    }
  });
});
