/**
 * Stable `--json` shapes (Phase 8): every command prints a contract-shaped object, committed as a
 * golden file under `test/golden/`. The stub server is contract-shaped but not durable, so these
 * tests isolate rendering from the host (which `core/test/rpc` covers).
 *
 * Update the goldens deliberately with `UPDATE_GOLDEN=1 npx vitest run --project cli`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DoctorReport, GateListResponse, RunDetail, RunListResponse } from "argos-core/rpc";

import { runCli } from "../src/main.js";
import { capture, makeTempHome, scrubVolatile, withEnv, type TempHome } from "./support/cli.js";
import { startStubServer, type StubServer } from "./support/stub-server.js";

const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));
const nodeVersion = process.versions.node;

interface Running {
  readonly stub: StubServer;
  readonly home: TempHome;
  restore(): void;
  close(): Promise<void>;
}

let running: Running | undefined;

beforeEach(async () => {
  const stub = await startStubServer();
  const home = makeTempHome(stub.token);
  const restore = withEnv({ ARGOS_HOME: home.home, ARGOS_PORT: String(stub.port) });
  running = {
    stub,
    home,
    restore,
    close: async () => {
      restore();
      await stub.close();
      home.cleanup();
    },
  };
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function current(): Running {
  if (running === undefined) throw new Error("stub server is not running");
  return running;
}

async function invoke(argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}> {
  const captured = capture();
  const code = await runCli(argv, captured.io);
  const stdout = captured.stdout();
  return {
    code,
    stdout,
    stderr: captured.stderr(),
    json: stdout.trim() === "" ? undefined : (JSON.parse(stdout) as unknown),
  };
}

function expectGolden(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(goldenDir, name);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  if (!existsSync(file)) {
    throw new Error(`missing golden ${file}; run with UPDATE_GOLDEN=1`);
  }
  expect(text).toBe(readFileSync(file, "utf8"));
}

describe("argos run --json", () => {
  it("prints the started run and sends the contract body", async () => {
    const result = await invoke([
      "run",
      "gated",
      "--input",
      "issue=42",
      "--cwd",
      ".",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expectGolden("run.json", result.json);

    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/runs",
    );
    expect(request?.authorization).toBe(`Bearer ${current().stub.token}`);
    expect(request?.body).toMatchObject({
      playbookId: "gated",
      inputs: { issue: "42" },
      cwd: process.cwd(),
    });
  });

  it("exits 2 when the server rejects the playbook", async () => {
    const result = await invoke(["run", "missing", "--json"]);
    expect(result.code).toBe(2);
    expect((result.json as { error: { code: string } }).error.code).toBe("playbook_missing");
  });

  it("exits 1 for an unknown option", async () => {
    const result = await invoke(["run", "gated", "--nope", "x"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown option --nope");
  });
});

describe("read commands", () => {
  it("argos ls --json", async () => {
    const result = await invoke(["ls", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("ls.json", result.json);
    expect((result.json as RunListResponse).runs).toHaveLength(1);
  });

  it("argos status --json", async () => {
    const result = await invoke(["status", "run-1", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("status.json", result.json);
    expect((result.json as RunDetail).history).toHaveLength(5);
  });

  it("argos gates --json lists pending gates only", async () => {
    const result = await invoke(["gates", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("gates.json", result.json);
    expect((result.json as GateListResponse).gates[0]?.status).toBe("pending");
  });
});

describe("write commands", () => {
  it("argos decide --json", async () => {
    const result = await invoke([
      "decide",
      "run-1",
      "review:1",
      "approve",
      "--comment",
      "ship it",
      "--decided-by",
      "dt",
      "--decided-via",
      "cli",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expectGolden("decide.json", result.json);
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path.includes("/gates/"),
    );
    expect(request?.body).toEqual({
      decision: "approve",
      comment: "ship it",
      decidedBy: "dt",
      decidedVia: "cli",
    });
  });

  it("argos cancel --json", async () => {
    const result = await invoke(["cancel", "run-1", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("cancel.json", result.json);
  });

  it("argos rm --json", async () => {
    const result = await invoke(["rm", "run-1", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("rm.json", result.json);
  });

  it("argos rm (human) names the kept worktree", async () => {
    const captured = capture();
    const code = await runCli(["rm", "run-1"], captured.io);
    expect(code).toBe(0);
    expect(captured.stdout()).toContain("removed run run-1 (completed); worktree kept at /home/worktrees/run-1");
  });

  it("argos rm of an unknown run exits 1 with run_unknown", async () => {
    const result = await invoke(["rm", "nope", "--json"]);
    expect(result.code).toBe(1);
  });

  it("argos retry --json", async () => {
    const result = await invoke(["retry", "run-1", "draft", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("retry.json", result.json);
  });
});

describe("argos worktree (FR4.6)", () => {
  it("argos worktree rm --json keeps --force boolean and sends the contract body", async () => {
    // `--force` comes before the run id: it must not swallow the positional.
    const result = await invoke(["worktree", "rm", "--force", "run-1", "--delete-branch", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("worktree-rm.json", result.json);
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/runs/run-1/worktree/remove",
    );
    expect(request?.authorization).toBe(`Bearer ${current().stub.token}`);
    expect(request?.body).toEqual({ force: true, deleteBranch: true });
  });

  it("argos worktree gc --json sends olderThan and dryRun", async () => {
    const result = await invoke(["worktree", "gc", "--older-than", "24h", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("worktree-gc.json", result.json);
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/worktrees/gc",
    );
    expect(request?.body).toEqual({ olderThan: "24h", dryRun: true });
  });

  it("exits 1 for a usage error (no --older-than, unknown option, extra run id)", async () => {
    const missing = await invoke(["worktree", "gc", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--older-than");

    const unknown = await invoke(["worktree", "rm", "run-1", "--nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown option --nope");

    const extra = await invoke(["worktree", "rm", "run-1", "run-2", "--json"]);
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("exactly one run id");

    const noSub = await invoke(["worktree", "--json"]);
    expect(noSub.code).toBe(1);
    expect(noSub.stderr).toContain("worktree needs a sub-command");
  });
});

describe("argos doctor --json", () => {
  it("reports storage, schema, port, daemons, providers, and pending gates", async () => {
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json as DoctorReport;
    expect(report.storage.path).toBe(join(current().home.home, "argos.sqlite"));
    expect(report.schemaVersion).toBe(1);
    expect(report.port).toBe(current().stub.port);
    expect(report.server.reachable).toBe(true);
    expect(report.paseo.reachable).toBe(true);
    expect(report.providers.map((provider) => provider.provider)).toEqual(["claude", "codex"]);
    expect(report.pendingGates).toHaveLength(1);
    expect(report.checks.find((check) => check.name === "server")?.ok).toBe(true);

    const scrubbed = scrubVolatile(report, {
      home: current().home.home,
      port: current().stub.port,
      pid: 4_242,
      node: nodeVersion,
    });
    expectGolden("doctor.json", scrubbed);
  });

  it("still reports storage and Node without a server", async () => {
    const { stub, home } = current();
    await stub.close();
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json as DoctorReport;
    expect(report.storage.path).toBe(join(home.home, "argos.sqlite"));
    expect(report.schemaVersion).toBe(1);
    expect(report.server.reachable).toBe(false);
    expect(report.paseo.reachable).toBe(false);
    expect(report.providers).toEqual([]);
    expect(report.pendingGates).toEqual([]);
    expect(report.checks.find((check) => check.name === "server")?.ok).toBe(false);
  });
});

describe("transport failures", () => {
  it("tells the user to start argos serve when the server is unreachable", async () => {
    const { stub } = current();
    await stub.close();
    const result = await invoke(["run", "gated", "--json"]);
    expect(result.code).toBe(3);
    expect(JSON.stringify(result.json)).toContain("argos serve");
  });

  it("exits 3 with an unauthorized hint when the token is wrong", async () => {
    const restore = withEnv({ ARGOS_HOME: current().home.home });
    writeFileSync(join(current().home.home, "token"), "wrong-token\n", { mode: 0o600 });
    try {
      const result = await invoke(["ls", "--json"]);
      expect(result.code).toBe(3);
      expect(JSON.stringify(result.json)).toContain("unauthorized");
    } finally {
      restore();
    }
  });
});
