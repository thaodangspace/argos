/**
 * `ARGOS_UI_DIR` resolution and build inspection (impl Phase 2/10): pure path logic, no server.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_UI_DIR, inspectUi, resolveUiDir } from "../src/ui-dir.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argos-ui-dir-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveUiDir", () => {
  it("defaults to the UI directory next to the package", () => {
    expect(resolveUiDir({}, "/pkg/ui")).toBe("/pkg/ui");
    expect(DEFAULT_UI_DIR.endsWith(join("packages", "cli", "ui"))).toBe(true);
  });

  it("honours ARGOS_UI_DIR and resolves it", () => {
    expect(resolveUiDir({ ARGOS_UI_DIR: " packages/web/build " }, "/pkg/ui")).toBe(
      resolve("packages/web/build"),
    );
  });

  it("treats an empty ARGOS_UI_DIR as disabled", () => {
    expect(resolveUiDir({ ARGOS_UI_DIR: "" }, "/pkg/ui")).toBeUndefined();
    expect(resolveUiDir({ ARGOS_UI_DIR: "   " }, "/pkg/ui")).toBeUndefined();
  });
});

describe("inspectUi", () => {
  it("returns the directory and the build id when the release copied one", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
    writeFileSync(join(dir, "build.json"), JSON.stringify({ buildId: "abc123" }), "utf8");
    expect(inspectUi(dir)).toEqual({ dir, buildId: "abc123" });
  });

  it("returns the directory without an id for a plain build", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
    expect(inspectUi(dir)).toEqual({ dir });
  });

  it("is unusable without index.html, and undefined when disabled", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "_app"), { recursive: true });
    expect(inspectUi(dir)).toBeUndefined();
    expect(inspectUi(undefined)).toBeUndefined();
  });

  it("ignores a malformed build.json", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
    writeFileSync(join(dir, "build.json"), "{not json", "utf8");
    expect(inspectUi(dir)).toEqual({ dir });
  });
});
