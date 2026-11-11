/**
 * D10 env filter (FR22, NFR "Security") — pure unit tests, plus the case-insensitivity and
 * allowlist rules the durable script test relies on.
 */

import { describe, expect, it } from "vitest";

import {
  filterScriptEnv,
  isSecretEnvName,
  SCRIPT_ENV_BASELINE,
  SECRET_ENV_NAME_PATTERN,
} from "./env.js";

const BASE = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/tester",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp",
} as const;

describe("filterScriptEnv (D10)", () => {
  it("drops the secret-looking names and keeps everything else", () => {
    const filtered = filterScriptEnv({
      ...BASE,
      MY_API_KEY: "sk-live-123",
      GITHUB_TOKEN: "ghp_secret",
      DB_PASSWORD: "hunter2",
      AWS_SECRET_ACCESS_KEY: "aws",
      CLIENT_CREDENTIAL: "cred",
      CARGO_HOME: "/home/tester/.cargo",
    });
    expect(Object.keys(filtered).sort()).toEqual(
      ["CARGO_HOME", "HOME", "LANG", "PATH", "TMPDIR"].sort(),
    );
  });

  it("matches the credential pattern case-insensitively", () => {
    for (const name of ["my_api_key", "Github_Token", "db_PassWord", "a_secret", "x_credential"]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "SHELL", "PWD"]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
    // The pattern is first defined in one place, so the filter and the git redactor cannot drift.
    expect(SECRET_ENV_NAME_PATTERN.source).toBe("KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL");
  });

  it("always keeps PATH, HOME, LANG, and TMPDIR", () => {
    const filtered = filterScriptEnv({ ...BASE, MY_API_KEY: "x" });
    for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
      expect(filtered[name], name).toBeDefined();
    }
    expect(Object.keys(filtered)).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    for (const name of SCRIPT_ENV_BASELINE) {
      // Every baseline name is a name the filter recognises, never a secret.
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it("passes an allowlisted secret through and ignores an allowlisted name that is absent", () => {
    const filtered = filterScriptEnv(
      { ...BASE, MY_API_KEY: "sk-live-123", GITHUB_TOKEN: "ghp_secret" },
      ["GITHUB_TOKEN", "NOT_SET_ANYWHERE"],
    );
    expect(filtered["GITHUB_TOKEN"]).toBe("ghp_secret");
    expect(filtered["MY_API_KEY"]).toBeUndefined();
    expect(filtered["NOT_SET_ANYWHERE"]).toBeUndefined();
    expect(Object.keys(filtered)).toEqual(["GITHUB_TOKEN", "HOME", "LANG", "PATH", "TMPDIR"]);
  });

  it("is deterministic (sorted keys) and drops undefined values", () => {
    const first = filterScriptEnv({ B: "2", A: "1", C: undefined, ...BASE });
    const second = filterScriptEnv({ C: undefined, A: "1", B: "2", ...BASE });
    expect(Object.keys(first)).toEqual(Object.keys(second));
    expect(Object.keys(first)).toEqual([...Object.keys(first)].sort());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.values(first).every((value) => typeof value === "string")).toBe(true);
  });

  it("keeps the win32 basics when they are present", () => {
    const filtered = filterScriptEnv({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\tester",
    });
    expect(filtered["Path"]).toBe("C:\\Windows");
    expect(filtered["SystemRoot"]).toBe("C:\\Windows");
    expect(filtered["TEMP"]).toBe("C:\\Temp");
    expect(filtered["TMP"]).toBe("C:\\Temp");
    expect(filtered["USERPROFILE"]).toBe("C:\\Users\\tester");
  });
});
