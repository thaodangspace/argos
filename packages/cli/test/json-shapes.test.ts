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

import type { DoctorReport, GateListResponse, RunDetail, RunListResponse } from "@thaodangspace/argos-core/rpc";

import { runCli } from "../src/main.js";
import { capture, makeTempHome, scrubVolatile, withEnv, type TempHome } from "./support/cli.js";
import {
  REFUSED_SCHEDULE_SUMMARY,
  SCHEDULE_ID,
  SCHEDULED_RUN_SUMMARY,
} from "./support/fixtures.js";
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
    // FR10.3: the schedules entry, from the same live server.
    const schedules = report.checks.find((check) => check.name === "schedules");
    expect(schedules?.ok).toBe(true);
    expect(schedules?.detail).toBe(
      "1 enabled, 0 paused, 0 refused; next 2026-11-13T07:00:00.000Z",
    );

    const scrubbed = scrubVolatile(report, {
      home: current().home.home,
      port: current().stub.port,
      pid: 4_242,
      node: nodeVersion,
    });
    expectGolden("doctor.json", scrubbed);
  });

  it("prints the schedules line in the human report", async () => {
    const captured = capture();
    const code = await runCli(["doctor"], captured.io);
    expect(code).toBe(0);
    expect(captured.stdout()).toContain(
      "schedules  1 enabled, 0 paused, 0 refused; next 2026-11-13T07:00:00.000Z",
    );
  });

  it("fails the schedules check when an enabled schedule last fire was refused", async () => {
    const alternate = await startStubServer(undefined, {
      schedules: [REFUSED_SCHEDULE_SUMMARY],
    });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const result = await invoke(["doctor", "--json"]);
      expect(result.code).toBe(0);
      const check = (result.json as DoctorReport).checks.find(
        (entry) => entry.name === "schedules",
      );
      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe("1 enabled, 0 paused, 1 refused; next 2026-11-13T07:00:00.000Z");
    } finally {
      restore();
      await alternate.close();
    }
  });

  it("reports a schedules failure without breaking the rest of the report", async () => {
    // `/info` answers but `/schedules` fails: the entry carries the error, the report still renders.
    const alternate = await startStubServer(undefined, { failSchedules: true });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const result = await invoke(["doctor", "--json"]);
      expect(result.code).toBe(0);
      const report = result.json as DoctorReport;
      expect(report.server.reachable).toBe(true);
      const check = report.checks.find((entry) => entry.name === "schedules");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("internal_error");
    } finally {
      restore();
      await alternate.close();
    }
  });

  it("omits the schedules check when the server is unreachable", async () => {
    const { stub } = current();
    await stub.close();
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(
      (result.json as DoctorReport).checks.find((entry) => entry.name === "schedules"),
    ).toBeUndefined();
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

describe("argos schedule (FR10.2)", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function lastRequest(method: string, path: string) {
    return current().stub.requests.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
  }

  it("argos schedule add --json sends the contract body", async () => {
    const result = await invoke([
      "schedule",
      "add",
      "gated",
      "--id",
      "weekly",
      "--cron",
      "0 7 * * *",
      "--input",
      "issue=42",
      "--input",
      "branch=main",
      "--catch-up",
      "90m",
      "--keep",
      "all",
      "--paused",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expectGolden("schedule-add.json", result.json);

    const request = lastRequest("POST", "/schedules");
    expect(request?.authorization).toBe(`Bearer ${current().stub.token}`);
    // cwd and tz default to the caller (FR2.5), every --input is sent, and --paused is `enabled: false`.
    expect(request?.body).toEqual({
      id: "weekly",
      playbook: "gated",
      cwd: process.cwd(),
      inputs: { issue: "42", branch: "main" },
      cron: "0 7 * * *",
      tz: zone,
      catchUp: "90m",
      keep: "all",
      enabled: false,
    });
  });

  it("sends --catch-up 0 and --keep 5 as numbers", async () => {
    const result = await invoke([
      "schedule",
      "add",
      "gated",
      "--cron",
      "*/5 * * * *",
      "--catch-up",
      "0",
      "--keep",
      "5",
      "--isolation",
      "worktree",
      "--overlap",
      "allow",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(lastRequest("POST", "/schedules")?.body).toEqual({
      playbook: "gated",
      cwd: process.cwd(),
      cron: "*/5 * * * *",
      tz: zone,
      isolation: "worktree",
      overlap: "allow",
      catchUp: 0,
      keep: 5,
    });
  });

  it("argos schedule ls --json", async () => {
    const result = await invoke(["schedule", "ls", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-ls.json", result.json);
  });

  it("argos schedule show --json", async () => {
    const result = await invoke(["schedule", "show", SCHEDULE_ID, "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-show.json", result.json);
  });

  it("argos schedule edit --json sends only the changed flags", async () => {
    const result = await invoke([
      "schedule",
      "edit",
      SCHEDULE_ID,
      "--cron",
      "30 6 * * *",
      "--overlap",
      "allow",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expectGolden("schedule-edit.json", result.json);
    expect(lastRequest("POST", `/schedules/${SCHEDULE_ID}`)?.body).toEqual({
      cron: "30 6 * * *",
      overlap: "allow",
    });
  });

  it("argos schedule pause --json", async () => {
    const result = await invoke(["schedule", "pause", SCHEDULE_ID, "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-pause.json", result.json);
  });

  it("argos schedule resume --json", async () => {
    const result = await invoke(["schedule", "resume", SCHEDULE_ID, "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-resume.json", result.json);
  });

  it("argos schedule run --json prints the start receipt", async () => {
    const result = await invoke(["schedule", "run", SCHEDULE_ID, "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-run.json", result.json);
    expect(result.json).toEqual({ runId: "run-1", taskId: "11" });
  });

  it("argos schedule rm --json", async () => {
    const result = await invoke(["schedule", "rm", SCHEDULE_ID, "--json"]);
    expect(result.code).toBe(0);
    expectGolden("schedule-rm.json", result.json);
  });

  it("exits 1 with schedule_exists for a duplicate id", async () => {
    const result = await invoke([
      "schedule",
      "add",
      "gated",
      "--id",
      SCHEDULE_ID,
      "--cron",
      "* * * * *",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect((result.json as { error: { code: string } }).error.code).toBe("schedule_exists");
  });

  it("exits 1 with schedule_unknown for an unknown schedule", async () => {
    const result = await invoke(["schedule", "show", "nope", "--json"]);
    expect(result.code).toBe(1);
    expect((result.json as { error: { code: string } }).error.code).toBe("schedule_unknown");

    const human = capture();
    expect(await runCli(["schedule", "pause", "nope"], human.io)).toBe(1);
    expect(human.stderr()).toContain("schedule_unknown");
  });

  it("exits 1 on every usage error without sending a request", async () => {
    const before = current().stub.requests.length;

    const missingCron = await invoke(["schedule", "add", "gated", "--json"]);
    expect(missingCron.code).toBe(1);
    expect(missingCron.stderr).toContain("--cron");

    const unknown = await invoke(["schedule", "add", "gated", "--cron", "* * * * *", "--nope", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown option --nope");

    const badOverlap = await invoke([
      "schedule", "add", "gated", "--cron", "* * * * *", "--overlap", "sometimes",
    ]);
    expect(badOverlap.code).toBe(1);
    expect(badOverlap.stderr).toContain("--overlap must be skip or allow");

    const badKeep = await invoke([
      "schedule", "add", "gated", "--cron", "* * * * *", "--keep", "1001",
    ]);
    expect(badKeep.code).toBe(1);
    expect(badKeep.stderr).toContain("--keep");

    const emptyEdit = await invoke(["schedule", "edit", SCHEDULE_ID]);
    expect(emptyEdit.code).toBe(1);
    expect(emptyEdit.stderr).toContain("schedule edit needs at least one");

    const noSub = await invoke(["schedule", "--json"]);
    expect(noSub.code).toBe(1);
    expect(noSub.stderr).toContain("schedule needs a sub-command");

    expect(current().stub.requests.length).toBe(before);
  });

  it("argos ls --schedule filters on the client and marks the human line", async () => {
    const alternate = await startStubServer(undefined, { runs: [SCHEDULED_RUN_SUMMARY] });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const result = await invoke(["ls", "--schedule", SCHEDULE_ID, "--json"]);
      expect(result.code).toBe(0);
      expectGolden("ls-schedule.json", result.json);
      expect((result.json as RunListResponse).runs).toHaveLength(1);

      const other = await invoke(["ls", "--schedule", "weekly", "--json"]);
      expect(other.code).toBe(0);
      expect((other.json as RunListResponse).runs).toEqual([]);

      const captured = capture();
      expect(await runCli(["ls", "--schedule", SCHEDULE_ID], captured.io)).toBe(0);
      expect(captured.stdout()).toContain(`[schedule ${SCHEDULE_ID}]`);
    } finally {
      restore();
      await alternate.close();
    }
  });

  it("argos ls (human) leaves a manual run's line alone", async () => {
    const captured = capture();
    expect(await runCli(["ls"], captured.io)).toBe(0);
    expect(captured.stdout()).not.toContain("[schedule");
    expect(await runCli(["ls", "--schedule", SCHEDULE_ID, "--json"], capture().io)).toBe(0);
  });

  it("renders concise human lines", async () => {
    const list = capture();
    expect(await runCli(["schedule", "ls"], list.io)).toBe(0);
    expect(list.stdout()).toContain("STATE");
    expect(list.stdout()).toContain(SCHEDULE_ID);
    expect(list.stdout()).toContain("0 7 * * *");
    expect(list.stdout()).toContain("Europe/Berlin");
    expect(list.stdout()).toContain("started run run-1");

    const add = capture();
    expect(await runCli(["schedule", "add", "gated", "--cron", "0 7 * * *"], add.io)).toBe(0);
    expect(add.stdout()).toContain("added schedule nightly");

    const paused = capture();
    expect(
      await runCli(["schedule", "add", "gated", "--cron", "0 7 * * *", "--paused"], paused.io),
    ).toBe(0);
    expect(paused.stdout()).toContain("(paused)");
  });

  it("never prints a schedule input value", async () => {
    const captured = capture();
    expect(await runCli(["schedule", "show", SCHEDULE_ID], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("inputs    issue");
    expect(captured.stdout()).not.toContain("42");
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
