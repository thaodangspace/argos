import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARGOS_HOME_MODE,
  ARGOS_TOKEN_MODE,
  argosHome,
  dbPath,
  ensureHome,
  pidPath,
  tokenPath,
} from "./paths.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argos-paths-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["ARGOS_HOME"];
});

describe("paths", () => {
  it("derives every file below the home directory", () => {
    const home = "/tmp/argos-test-home";
    expect(dbPath(home)).toBe(join(home, "argos.sqlite"));
    expect(tokenPath(home)).toBe(join(home, "token"));
    expect(pidPath(home)).toBe(join(home, "serve.pid"));
  });

  it("honours ARGOS_HOME", () => {
    process.env["ARGOS_HOME"] = "/tmp/argos-from-env";
    expect(argosHome()).toBe("/tmp/argos-from-env");
  });

  it("falls back to ~/.argos when ARGOS_HOME is unset or blank", () => {
    delete process.env["ARGOS_HOME"];
    expect(argosHome()).toBe(join(homedir(), ".argos"));

    process.env["ARGOS_HOME"] = "   ";
    expect(argosHome()).toBe(join(homedir(), ".argos"));
  });

  it("creates a missing home directory with mode 0700", () => {
    const home = join(tempDir(), "nested", "argos-home");
    expect(ensureHome(home)).toBe(home);
    expect(statSync(home).mode & 0o777).toBe(ARGOS_HOME_MODE);
    expect(ARGOS_HOME_MODE).toBe(0o700);
  });

  it("repairs an existing home directory to mode 0700", () => {
    const home = tempDir();
    chmodSync(home, 0o755);
    expect(statSync(home).mode & 0o777).toBe(0o755);

    ensureHome(home);
    expect(statSync(home).mode & 0o777).toBe(ARGOS_HOME_MODE);
  });

  it("keeps the token mode constant at 0600", () => {
    expect(ARGOS_TOKEN_MODE).toBe(0o600);
  });
});
