/**
 * Stable `--json` shapes (Phase 8): every command prints a contract-shaped object, committed as a
 * golden file under `test/golden/`. The stub server is contract-shaped but not durable, so these
 * tests isolate rendering from the host (which `core/test/rpc` covers).
 *
 * Update the goldens deliberately with `UPDATE_GOLDEN=1 npx vitest run --project cli`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DoctorCheck, DoctorReport, GateListResponse, RunDetail, RunListResponse } from "@thaodangspace/argos-core/rpc";

import { hcTemplatesCheck } from "../src/commands/doctor.js";
import type { PackManifest } from "../src/packs/pack.js";
import { runCli } from "../src/main.js";
import { capture, makeTempHome, scrubVolatile, withEnv, type TempHome } from "./support/cli.js";
import {
  FORKED_RUN_DETAIL,
  FORKED_RUN_SUMMARY,
  HC_EXECUTOR,
  HC_RUN_SUMMARY,
  PASEO_EXECUTOR,
  REFUSED_SCHEDULE_SUMMARY,
  RUN_DETAIL,
  RUN_ID,
  SCHEDULE_ID,
  SCHEDULE_SUMMARY,
  SCHEDULED_RUN_SUMMARY,
  USAGE_RUN_DETAIL,
  USAGE_RUN_SUMMARY,
  serverInfo,
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

  it("sends --executor as the canonical id, and no key at all by default (FR3)", async () => {
    const before = current().stub.requests.length;
    // An alias is normalized by the CLI, so only `paseo`/`hc` ever reaches the server.
    expect(await invoke(["run", "gated", "--executor", "herdr-core", "--json"])).toMatchObject({
      code: 0,
    });
    const sent = current().stub.requests.slice(before).find((request) => request.path === "/runs");
    expect(sent?.body).toMatchObject({ playbookId: "gated", executor: "hc" });

    // The default path is byte-identical to before this field existed.
    const plain = await invoke(["run", "gated", "--json"]);
    expect(plain.code).toBe(0);
    expect(current().stub.requests.at(-1)?.body).not.toHaveProperty("executor");
  });

  it("refuses an unknown --executor locally, with no request sent", async () => {
    const before = current().stub.requests.length;
    const result = await invoke(["run", "gated", "--executor", "nope", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--executor");
    expect(result.stderr).toContain("paseo, hc");
    expect(result.stdout).toBe("");
    expect(current().stub.requests.length).toBe(before);
  });
});

describe("read commands", () => {
  it("argos ls --json", async () => {
    const result = await invoke(["ls", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("ls.json", result.json);
    expect((result.json as RunListResponse).runs).toHaveLength(1);
    // FR8: a paseo run's JSON carries no `executor` key at all (the golden is unchanged).
    expect(result.stdout).not.toContain('"executor"');
  });

  it("names a non-default executor in the human ls line (FR8)", async () => {
    // The primary stub serves a paseo run: its line carries no marker at all.
    const plain = capture();
    expect(await runCli(["ls"], plain.io)).toBe(0);
    expect(plain.stdout()).not.toContain("[executor");
    // A record without the key still renders a substrate: the default one.
    const plainStatus = capture();
    expect(await runCli(["status", RUN_ID], plainStatus.io)).toBe(0);
    expect(plainStatus.stdout()).toContain("executor  paseo");

    const alternate = await startStubServer(undefined, {
      runs: [HC_RUN_SUMMARY],
      detail: { ...RUN_DETAIL, executor: "hc" },
    });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const listed = capture();
      expect(await runCli(["ls"], listed.io)).toBe(0);
      expect(listed.stdout()).toContain("[executor hc]");

      // `argos status` spells the substrate out, defaulting to paseo when the record omits it.
      const status = capture();
      expect(await runCli(["status", RUN_ID], status.io)).toBe(0);
      expect(status.stdout()).toContain("executor  hc");
    } finally {
      restore();
      await alternate.close();
    }
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

  it("argos fork --json posts the step and returns a new run id (S-FR1)", async () => {
    const result = await invoke(["fork", "run-1", "review", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("fork.json", result.json);
    expect((result.json as { runId: string }).runId).toBe("run-2");
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/runs/run-1/fork",
    );
    expect(request?.body).toEqual({ stepId: "review" });

    const human = capture();
    expect(await runCli(["fork", "run-1", "review"], human.io)).toBe(0);
    expect(human.stdout()).toBe("forked run-1 at review → run run-2 (task 13)\n");
  });

  it("argos fork needs two positionals and no flags", async () => {
    expect(await runCli(["fork", "run-1"], capture().io)).toBe(1);
    expect(await runCli(["fork", "run-1", "review", "--nope"], capture().io)).toBe(1);
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

describe("argos db", () => {
  it("argos db stats --json is the read-only contract shape", async () => {
    const result = await invoke(["db", "stats", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("db-stats.json", result.json);
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "GET" && candidate.path === "/db/stats",
    );
    expect(request?.authorization).toBe(`Bearer ${current().stub.token}`);
  });

  it("argos db purge --json sends olderThan and keeps --dry-run/--vacuum boolean", async () => {
    const dry = await invoke(["db", "purge", "--older-than", "30d", "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expectGolden("db-purge-dry.json", dry.json);
    const dryRequest = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/db/purge",
    );
    expect(dryRequest?.body).toEqual({ olderThan: "30d", dryRun: true });

    const before = current().stub.requests.length;
    const purged = await invoke(["db", "purge", "--older-than", "30d", "--vacuum", "--json"]);
    expect(purged.code).toBe(0);
    expectGolden("db-purge.json", purged.json);
    const sent = current().stub.requests.slice(before).find((request) => request.path === "/db/purge");
    expect(sent?.body).toEqual({ olderThan: "30d", vacuum: true });
  });

  it("argos db vacuum --json reports both sizes", async () => {
    const result = await invoke(["db", "vacuum", "--json"]);
    expect(result.code).toBe(0);
    expectGolden("db-vacuum.json", result.json);
    const request = current().stub.requests.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/db/vacuum",
    );
    expect(request?.body).toEqual({});
  });

  it("exits 1 for a usage error (no --older-than, unknown option, unknown sub-command)", async () => {
    const missing = await invoke(["db", "purge", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--older-than");
    expect(current().stub.requests.some((request) => request.path === "/db/purge")).toBe(false);

    const unknown = await invoke(["db", "stats", "--nope", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown option --nope");

    const noSub = await invoke(["db", "--json"]);
    expect(noSub.code).toBe(1);
    expect(noSub.stderr).toContain("db needs a sub-command");
  });
});

/** Write a pack manifest into `home` (the shape `install` produces, without the files). */
function writeManifest(
  home: string,
  packs: Readonly<Record<string, { readonly version: number; readonly templates: readonly string[] }>>,
): void {
  mkdirSync(join(home, "hc"), { recursive: true });
  const manifest = {
    version: 1,
    packs: Object.fromEntries(
      Object.entries(packs).map(([name, pack]) => [
        name,
        {
          version: pack.version,
          source: "bundled",
          program: join(home, "hc", "packs", `${name}@${pack.version}`, `${name}-step.mjs`),
          programSha256: "0".repeat(64),
          templates: Object.fromEntries(
            pack.templates.map((template) => [
              template,
              { file: join(home, "templates", `${template}.md`), minStepTimeoutMs: 60_000 },
            ]),
          ),
        },
      ]),
    ),
  };
  writeFileSync(join(home, "hc", "packs.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * A stand-in server whose `hc` executor publishes a roster — the one thing the default stub
 * deliberately omits, so every other golden keeps its `executors` shape.
 */
async function startRosterServer(
  templates: readonly string[],
): Promise<{ readonly port: number; close(): Promise<void> }> {
  const token = current().stub.token;
  let port = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const send = (value: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "token" } }));
      return;
    }
    if (path === "/health") {
      send({ status: "ok" });
      return;
    }
    if (path === "/info") {
      send({
        ...serverInfo(port),
        executors: [PASEO_EXECUTOR, { ...HC_EXECUTOR, templates }],
      });
      return;
    }
    if (path === "/schedules") {
      send({ schedules: [SCHEDULE_SUMMARY] });
      return;
    }
    send({});
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

/** Run `doctor --json` against an alternate server, restoring `ARGOS_PORT` afterwards. */
async function doctorAgainst(port: number): Promise<DoctorReport> {
  const restore = withEnv({
    ARGOS_HOME: current().home.home,
    ARGOS_PORT: String(port),
  });
  try {
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    return result.json as DoctorReport;
  } finally {
    restore();
  }
}

function hcCheck(report: DoctorReport): DoctorCheck | undefined {
  return report.checks.find((check) => check.name === "hc templates");
}

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
    // FR9: the executor registry, with the default marked.
    expect(report.executors?.map((executor) => executor.id)).toEqual(["paseo", "hc"]);
    expect(report.executors?.find((executor) => executor.default)?.id).toBe("paseo");
    expect(report.executors?.find((executor) => executor.id === "hc")?.reachable).toBe(true);
    // FR10.3: the schedules entry, from the same live server.
    const schedules = report.checks.find((check) => check.name === "schedules");
    expect(schedules?.ok).toBe(true);
    expect(schedules?.detail).toBe(
      "1 enabled, 0 paused, 0 refused; next 2026-11-13T07:00:00.000Z",
    );
    // FR17: the hc pack check is absent-safe — this home has no manifest, so "not installed".
    const templates = hcCheck(report);
    expect(templates?.ok).toBe(true);
    expect(templates?.detail).toBe("not installed; run `argos hc templates install`");

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
    expect(captured.stdout()).toContain("templates  not installed; run `argos hc templates install`");
    // FR9: the executor line names the registry, the default, and each adapter's version.
    expect(captured.stdout()).toContain("executors  paseo (default, reachable), hc (reachable, v0.9.1)");
  });

  it("omits the executors line when no server answered", async () => {
    const { stub } = current();
    await stub.close();
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect((result.json as DoctorReport).executors).toBeUndefined();

    const human = capture();
    expect(await runCli(["doctor"], human.io)).toBe(0);
    expect(human.stdout()).not.toContain("executors");
  });

  it("marks hc templates ok when every installed template is in the live roster (FR17)", async () => {
    writeManifest(current().home.home, {
      claude: { version: 1, templates: ["claude-opus-high"] },
      smoke: { version: 1, templates: ["smoke"] },
    });
    const roster = await startRosterServer(["hc/claude-opus-high", "hc/smoke"]);
    try {
      const check = hcCheck(await doctorAgainst(roster.port));
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe("2 templates in the running server's catalog");
    } finally {
      await roster.close();
    }
  });

  it("warns when a template is installed but the running server has not seen it (FR17)", async () => {
    writeManifest(current().home.home, {
      claude: { version: 1, templates: ["claude-opus-high"] },
      smoke: { version: 1, templates: ["smoke"] },
    });
    const stale = await startRosterServer(["hc/smoke"]);
    try {
      const check = hcCheck(await doctorAgainst(stale.port));
      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe(
        "2 templates; not in the running server's catalog: claude-opus-high (restart `argos serve`)",
      );
    } finally {
      await stale.close();
    }

    // An older server (the default stub) publishes no roster at all: unknown, not empty.
    const older = hcCheck(await doctorAgainst(current().stub.port));
    expect(older?.ok).toBe(false);
    expect(older?.detail).toBe(
      "2 templates; the running server does not publish its hc templates, so this cannot be checked (restart `argos serve`)",
    );
  });

  it("warns when an installed pack is behind the bundled one (FR17)", () => {
    const manifest: PackManifest = {
      version: 1,
      packs: {
        claude: {
          version: 1,
          source: "bundled",
          program: "/tmp/hc/claude-step.mjs",
          programSha256: "0".repeat(64),
          templates: {
            "claude-opus-high": { file: "/tmp/t/claude-opus-high.md", minStepTimeoutMs: 60_000 },
          },
        },
      },
    };
    const executors = [
      {
        id: "hc" as const,
        default: false,
        reachable: true,
        capabilities: {
          structuredOutput: false,
          quota: false,
          interactiveBlocked: true,
          scheduleSafe: true,
        },
        templates: ["hc/claude-opus-high"],
      },
    ];
    const behind = hcTemplatesCheck({ manifest, executors, bundled: { claude: 2 } });
    expect(behind.ok).toBe(false);
    expect(behind.detail).toBe(
      "1 template; claude 1 installed, 2 bundled; run `argos hc templates install`",
    );

    // Equal to the bundle: nothing to say, and the roster answer is the whole detail.
    expect(hcTemplatesCheck({ manifest, executors, bundled: { claude: 1 } }).detail).toBe(
      "1 template in the running server's catalog",
    );
    // A pack the binary does not ship (installed with `--from`) is never "behind".
    expect(hcTemplatesCheck({ manifest, executors, bundled: {} }).ok).toBe(true);
  });

  it("omits the hc templates check when the server is unreachable (FR17)", async () => {
    writeManifest(current().home.home, { smoke: { version: 1, templates: ["smoke"] } });
    const { stub } = current();
    await stub.close();
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(hcCheck(result.json as DoctorReport)).toBeUndefined();

    const human = capture();
    expect(await runCli(["doctor"], human.io)).toBe(0);
    expect(human.stdout()).not.toContain("templates");
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

  it("sends --executor as the canonical id on add and edit, and refuses an unknown one (FR10)", async () => {
    // An alias is normalized by the CLI, so only `paseo`/`hc` ever reaches the server.
    const added = await invoke([
      "schedule",
      "add",
      "gated",
      "--cron",
      "* * * * *",
      "--executor",
      "herdr-core",
      "--json",
    ]);
    expect(added.code).toBe(0);
    expect(lastRequest("POST", "/schedules")?.body).toMatchObject({ executor: "hc" });

    const edited = await invoke([
      "schedule",
      "edit",
      SCHEDULE_ID,
      "--executor",
      "paseo",
      "--json",
    ]);
    expect(edited.code).toBe(0);
    expect(lastRequest("POST", `/schedules/${SCHEDULE_ID}`)?.body).toEqual({ executor: "paseo" });

    // The default path is byte-identical to before this field existed.
    const plain = await invoke(["schedule", "add", "gated", "--cron", "* * * * *", "--json"]);
    expect(plain.code).toBe(0);
    expect(current().stub.requests.at(-1)?.body).not.toHaveProperty("executor");

    const before = current().stub.requests.length;
    const unknown = await invoke([
      "schedule",
      "add",
      "gated",
      "--cron",
      "* * * * *",
      "--executor",
      "nope",
      "--json",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--executor");
    expect(unknown.stderr).toContain("paseo, hc");
    expect(unknown.stdout).toBe("");
    expect(current().stub.requests.length).toBe(before);
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

  it("renders the fork edge in the human ls line and the status block (S-FR12)", async () => {
    const alternate = await startStubServer(undefined, {
      runs: [FORKED_RUN_SUMMARY],
      detail: FORKED_RUN_DETAIL,
    });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const list = capture();
      expect(await runCli(["ls"], list.io)).toBe(0);
      expect(list.stdout()).toContain("[fork run-1@review]");
      // A scheduled fork keeps both markers.
      expect(list.stdout()).toContain(`[schedule ${SCHEDULE_ID}]`);

      const status = capture();
      expect(await runCli(["status", "run-1"], status.io)).toBe(0);
      expect(status.stdout()).toContain("forked    from run-1 at review");
      expect(status.stdout()).toContain("0123456789ab -> fedcba987654");
    } finally {
      restore();
      await alternate.close();
    }
  });

  it("renders aggregate usage in the human ls column and status block (FR26)", async () => {
    const alternate = await startStubServer(undefined, {
      runs: [USAGE_RUN_SUMMARY],
      detail: USAGE_RUN_DETAIL,
    });
    const restore = withEnv({
      ARGOS_HOME: current().home.home,
      ARGOS_PORT: String(alternate.port),
    });
    try {
      const list = capture();
      expect(await runCli(["ls"], list.io)).toBe(0);
      // The column appears only when accounting exists; this run reported $0.67 in total.
      expect(list.stdout()).toContain("COST");
      expect(list.stdout()).toContain("$0.67");

      const status = capture();
      expect(await runCli(["status", RUN_ID], status.io)).toBe(0);
      expect(status.stdout()).toContain("usage     $0.67 · 240 in · 6k out · ctx 4.1k/200k");
      // Per-step cost: one line for each agent step, none for the gate step.
      expect(status.stdout()).toContain("$0.25");
      expect(status.stdout()).toContain("$0.42");
      const review = status.stdout().split("\n").find((line) => line.includes("review"));
      expect(review).not.toContain("$");
    } finally {
      restore();
      await alternate.close();
    }
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
