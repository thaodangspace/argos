/**
 * FR2 script environment allowlist — pure unit tests for `engine/env.ts`.
 *
 * The filter is deny-by-default: baseline names plus the step's grants, minus a hard deny list.
 * The grant grammar (`NAME`, `PREFIX_*`, `"*"`) is parsed here and re-used by the loader, so the
 * parser's accept/reject rules are part of this contract.
 */

import { describe, expect, it } from "vitest";

import {
  filterScriptEnv,
  isBaselineEnvName,
  isDeniedEnvName,
  isSecretEnvName,
  parseEnvGrant,
  SCRIPT_ENV_BASELINE,
  SCRIPT_ENV_DENY,
  SECRET_ENV_NAME_PATTERN,
} from "./env.js";

const BASE = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/tester",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp",
} as const;

describe("filterScriptEnv (FR2.1)", () => {
  it("drops a name that is neither baseline nor granted", () => {
    // CARGO_HOME is not secret-looking, so the old denylist kept it; the allowlist must not.
    const filtered = filterScriptEnv({
      ...BASE,
      CARGO_HOME: "/home/tester/.cargo",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      NODE_OPTIONS: "--max-old-space-size=4096",
      MY_API_KEY: "sk-live-123",
    });
    expect(Object.keys(filtered)).toStrictEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    expect(filtered["CARGO_HOME"]).toBeUndefined();
    expect(filtered["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(filtered["NODE_OPTIONS"]).toBeUndefined();
    expect(filtered["MY_API_KEY"]).toBeUndefined();
  });

  it("keeps every baseline name and both baseline matching rules", () => {
    const env: Record<string, string> = { LC_ALL: "en_US.UTF-8", LC_CTYPE: "UTF-8" };
    for (const name of SCRIPT_ENV_BASELINE) env[name] = `value-of-${name}`;
    const filtered = filterScriptEnv(env);
    for (const name of SCRIPT_ENV_BASELINE) {
      expect(filtered[name], name).toBe(`value-of-${name}`);
    }
    expect(filtered["LC_ALL"]).toBe("en_US.UTF-8");
    expect(filtered["LC_CTYPE"]).toBe("UTF-8");
  });

  it("matches a baseline name case-insensitively", () => {
    const filtered = filterScriptEnv({
      Path: "C:\\Windows",
      systemroot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\tester",
    });
    expect(filtered["Path"]).toBe("C:\\Windows");
    expect(filtered["systemroot"]).toBe("C:\\Windows");
    expect(filtered["ComSpec"]).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(filtered["TEMP"]).toBe("C:\\Temp");
    expect(filtered["TMP"]).toBe("C:\\Temp");
    // Not a baseline name and not granted: an allowlist drops it even on win32.
    expect(filtered["USERPROFILE"]).toBeUndefined();
  });

  it("is deterministic (sorted keys) and drops undefined values", () => {
    const first = filterScriptEnv({ B: "2", A: "1", C: undefined, ...BASE }, ["A", "B"]);
    const second = filterScriptEnv({ C: undefined, A: "1", B: "2", ...BASE }, ["A", "B"]);
    expect(Object.keys(first)).toStrictEqual(["A", "B", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(Object.keys(first)).toStrictEqual([...Object.keys(first)].sort());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.values(first).every((value) => typeof value === "string")).toBe(true);
  });
});

describe("filterScriptEnv grants (FR2.2)", () => {
  it("passes a secret-looking name when it is granted exactly", () => {
    const filtered = filterScriptEnv(
      { ...BASE, MY_API_KEY: "sk-live-123", GITHUB_TOKEN: "ghp_secret" },
      ["MY_API_KEY", "NOT_SET_ANYWHERE"],
    );
    expect(filtered["MY_API_KEY"]).toBe("sk-live-123");
    expect(filtered["GITHUB_TOKEN"]).toBeUndefined();
    // A granted name the parent does not define is absent, not an error.
    expect(filtered["NOT_SET_ANYWHERE"]).toBeUndefined();
    expect(Object.keys(filtered)).toStrictEqual(["HOME", "LANG", "MY_API_KEY", "PATH", "TMPDIR"]);
  });

  it("passes a PREFIX_* grant but never a secret-looking name it covers", () => {
    const filtered = filterScriptEnv(
      {
        ...BASE,
        NPM_CONFIG_REGISTRY: "https://registry.example",
        NPM_TOKEN: "npm-secret",
        NPM_AUTH_TOKEN: "auth",
        NPMPATH: "/opt/npm",
      },
      ["NPM_*"],
    );
    expect(Object.keys(filtered)).toStrictEqual([
      "HOME",
      "LANG",
      "NPM_CONFIG_REGISTRY",
      "PATH",
      "TMPDIR",
    ]);
    expect(filtered["NPM_TOKEN"]).toBeUndefined();
    expect(filtered["NPM_AUTH_TOKEN"]).toBeUndefined();
    // The prefix is literal: it does not match a name without the trailing underscore.
    expect(filtered["NPMPATH"]).toBeUndefined();
  });

  it('gives the old behavior for "*": everything except secret-looking names', () => {
    const filtered = filterScriptEnv(
      {
        ...BASE,
        CARGO_HOME: "/home/tester/.cargo",
        NODE_OPTIONS: "--max-old-space-size=4096",
        MY_API_KEY: "sk-live-123",
        DB_PASSWORD: "hunter2",
      },
      ["*"],
    );
    expect(Object.keys(filtered)).toStrictEqual([
      "CARGO_HOME",
      "HOME",
      "LANG",
      "NODE_OPTIONS",
      "PATH",
      "TMPDIR",
    ]);
    expect(filtered["MY_API_KEY"]).toBeUndefined();
    expect(filtered["DB_PASSWORD"]).toBeUndefined();
  });

  it("never passes a deny-list name, even when granted exactly (FR2.4)", () => {
    const env: Record<string, string> = { ...BASE };
    for (const name of SCRIPT_ENV_DENY) env[name] = `secret-of-${name}`;
    const filtered = filterScriptEnv(env, [...SCRIPT_ENV_DENY]);
    for (const name of SCRIPT_ENV_DENY) {
      expect(filtered[name], name).toBeUndefined();
    }
    // The deny list also wins over "*", and over a secret-looking exact grant.
    const inheritAll = filterScriptEnv(env, ["*", "ARGOS_PASEO_PASSWORD"]);
    for (const name of SCRIPT_ENV_DENY) {
      expect(inheritAll[name], name).toBeUndefined();
    }
    // Only the baseline survives: every deny-list name was dropped.
    expect(Object.keys(filtered)).toStrictEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
  });

  it("grants nothing for a malformed entry (the loader rejects those first)", () => {
    const filtered = filterScriptEnv({ ...BASE, FOO_BAR: "1" }, ["FOO*", ""]);
    expect(Object.keys(filtered)).toStrictEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
  });
});

describe("parseEnvGrant (FR2.2/FR2.3)", () => {
  it("accepts an exact name, a PREFIX_* grant, and *", () => {
    expect(parseEnvGrant("MY_API_KEY")).toStrictEqual({ kind: "exact", name: "MY_API_KEY" });
    expect(parseEnvGrant("NPM_*")).toStrictEqual({ kind: "prefix", prefix: "NPM_" });
    expect(parseEnvGrant("A_*")).toStrictEqual({ kind: "prefix", prefix: "A_" });
    expect(parseEnvGrant("*")).toStrictEqual({ kind: "all" });
  });

  it.each(["FOO*", "*_X", "A B", "", "MY-KEY", "1FOO", "*FOO_*"])(
    "rejects the malformed entry %j",
    (entry) => {
      expect(parseEnvGrant(entry)).toBeUndefined();
    },
  );
});

describe("baseline and deny helpers (FR2.1/FR2.4)", () => {
  it("recognises the baseline case-insensitively, including the LC_ prefix", () => {
    for (const name of SCRIPT_ENV_BASELINE) {
      expect(isBaselineEnvName(name), name).toBe(true);
      expect(isBaselineEnvName(name.toLowerCase()), name).toBe(true);
    }
    expect(isBaselineEnvName("LC_ALL")).toBe(true);
    expect(isBaselineEnvName("LC_CTYPE")).toBe(true);
    expect(isBaselineEnvName("MY_VAR")).toBe(false);
    expect(isBaselineEnvName("LANGUAGE")).toBe(false);
  });

  it("keeps the deny list to Argos' own configuration", () => {
    expect([...SCRIPT_ENV_DENY].sort()).toStrictEqual([
      "ARGOS_FAKE_PASEO",
      "ARGOS_FAKE_PASEO_BLOCK_STEP",
      "ARGOS_FAKE_PASEO_DIR",
      "ARGOS_FAKE_PASEO_RELEASE_FILE",
      "ARGOS_HOME",
      "ARGOS_PASEO_PASSWORD",
      "ARGOS_PASEO_URL",
      "ARGOS_PORT",
    ]);
    for (const name of SCRIPT_ENV_DENY) expect(isDeniedEnvName(name), name).toBe(true);
    expect(isDeniedEnvName("argos_home")).toBe(true);
    expect(isDeniedEnvName("HOME")).toBe(false);
  });
});

describe("isSecretEnvName (FR2.6)", () => {
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

  it("never matches a baseline name, so the baseline can never leak a credential", () => {
    for (const name of SCRIPT_ENV_BASELINE) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
    for (const name of SCRIPT_ENV_DENY) {
      // ARGOS_PASEO_PASSWORD is both denied and secret-looking; the deny list is the outer guard.
      expect(isDeniedEnvName(name), name).toBe(true);
    }
  });
});
