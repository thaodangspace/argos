/**
 * Phase 10 durability E2E (plan D17): a real, built `argos serve` child is `SIGKILL`ed while a
 * step is running (Scenario A), a gate is pending (Scenario B), or a schedule's fire time passes
 * while nothing is running (Scenario C), restarted against the same `$ARGOS_HOME`, and the same
 * work finishes (or fires) exactly once.
 *
 * The fake Paseo executor is file-backed under `$ARGOS_HOME` (`fake-paseo.json` +
 * `fake-paseo-launches.jsonl`), so the restarted process adopts the agents its predecessor
 * created. The launch ledger is the evidence: exactly one creation per step across both
 * lifetimes, and step 3 is only created by the second process.
 *
 * Scenario C is the scheduler's durability claim (G3/G4): the schedule is a durable document and
 * the run id is derived from the fire time, so a process that dies before the fire time cannot
 * lose it, and a process that starts after it cannot start that fire twice.
 *
 * These tests spawn real processes and are deliberately **not** part of `npm test`; run them
 * with `npm run test:e2e` (which builds first).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  GateListResponse,
  GateSummary,
  RunDetail,
  RunSummary,
  ScheduleDetail,
} from "argos-core/rpc";

const cliRoot = fileURLToPath(new URL("../../../cli", import.meta.url));
const distIndex = join(cliRoot, "dist", "index.js");

const LEDGER = "fake-paseo-launches.jsonl";

interface LedgerLine {
  readonly requestId: string;
  readonly agentId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly at: number;
  readonly pid: number;
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ServeChild {
  readonly child: ChildProcess;
  readonly port: number;
  /** Everything the child wrote to stderr so far (the schedule fire lines included). */
  readonly stderr: () => string;
}

const children = new Set<ChildProcess>();
const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function spawnChild(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [distIndex, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => {
    children.delete(child);
  });
  return child;
}

/** One complete CLI invocation (`argos ...`) with captured output. */
async function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<ChildResult> {
  return waitForExit(spawnChild(args, env), timeoutMs);
}

/** Run a CLI command and parse its pretty-printed JSON stdout. */
async function cliJson<T>(args: readonly string[], env: NodeJS.ProcessEnv): Promise<T> {
  const result = await cli([...args, "--json"], env);
  if (result.code !== 0) {
    throw new Error(`argos ${args.join(" ")} exited ${String(result.code)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * Start one `argos serve` for `home` and resolve as soon as it printed its port.
 *
 * `port` defaults to `0` (a fresh ephemeral port, the pattern Scenarios A and B use); Scenario C
 * passes the port of the lifetime it replaces, so a restart comes back on the same address.
 */
function startServe(
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
  port = 0,
): Promise<ServeChild> {
  const child = spawnChild(["serve", "--port", String(port), "--json"], {
    ...process.env,
    ARGOS_HOME: home,
    ARGOS_FAKE_PASEO: "1",
    ...extraEnv,
  });
  // Captured here (not inside the promise) so the returned accessor keeps reading the same
  // buffer for the whole lifetime, after the port resolved.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`argos serve did not print its port within 30 s; stderr: ${stderr}`));
    }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { port?: unknown };
          if (typeof parsed.port === "number") {
            clearTimeout(timer);
            resolve({ child, port: parsed.port, stderr: () => stderr });
          }
        } catch {
          // Not the JSON line yet.
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`argos serve exited early (${String(code)}); stderr: ${stderr}`));
    });
  });
}

/** SIGKILL and wait for the process to be gone, so no orphan survives the test. */
async function killServe(serve: ServeChild): Promise<void> {
  if (serve.child.exitCode !== null || serve.child.signalCode !== null) return;
  const exited = waitForExit(serve.child, 10_000);
  serve.child.kill("SIGKILL");
  const result = await exited;
  expect(result.signal).toBe("SIGKILL");
}

/** Graceful stop used by cleanup (and tolerated after a SIGKILL). */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child, 5_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function clientEnv(home: string, port: number): NodeJS.ProcessEnv {
  return { ...process.env, ARGOS_HOME: home, ARGOS_PORT: String(port) };
}

function readLedger(home: string): LedgerLine[] {
  const file = join(home, LEDGER);
  if (!existsSync(file)) return [];
  const lines: LedgerLine[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as Partial<LedgerLine>;
      if (
        typeof parsed.requestId === "string" &&
        typeof parsed.agentId === "string" &&
        typeof parsed.stepId === "string" &&
        typeof parsed.attempt === "number" &&
        typeof parsed.at === "number" &&
        typeof parsed.pid === "number"
      ) {
        lines.push(parsed as LedgerLine);
      }
    } catch {
      // Ignore a torn tail line: the test only cares about complete creations.
    }
  }
  return lines;
}

function writePlaybook(repo: string, name: string, yaml: string): void {
  const directory = join(repo, ".argos", "playbooks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.yaml`), yaml, "utf8");
}

const THREE_STEPS = [
  "title: Kill restart",
  "steps:",
  "  - id: step1",
  '    prompt: "First step"',
  "    poll_ms: 50",
  "  - id: step2",
  "    needs: [step1]",
  '    prompt: "Second step"',
  "    poll_ms: 50",
  "  - id: step3",
  "    needs: [step2]",
  '    prompt: "Third step"',
  "    poll_ms: 50",
  "",
].join("\n");

const GATED = [
  "title: Gate restart",
  "steps:",
  "  - id: work",
  '    prompt: "Do the work"',
  "    poll_ms: 50",
  "  - id: approve",
  "    kind: gate",
  "    needs: [work]",
  "    gate:",
  '      question: "Ship it?"',
  "      choices:",
  "        approve: { label: Approve }",
  "        reject: { label: Reject, color: danger }",
  "",
].join("\n");

const SCHEDULED = [
  "title: Scheduled restart",
  "steps:",
  "  - id: only",
  '    prompt: "Run the scheduled work"',
  "    poll_ms: 50",
  "",
].join("\n");

/** The Crockford base32 alphabet a ULID is written in. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Decode the 10-character time prefix of a ULID (48-bit epoch milliseconds).
 *
 * A schedule fire's run id is deterministic (FR4.3): the time part is the fire time, so this is
 * how the scenario proves the persisted run belongs to the fire time it claims — without
 * hard-coding the random part, which is `sha256(uid:fireAt)`.
 */
function decodeUlidTime(id: string): number {
  let value = 0n;
  for (const char of id.slice(0, 10).toUpperCase()) {
    const digit = CROCKFORD.indexOf(char);
    expect(digit, `ULID ${id} has a character outside the Crockford alphabet`).toBeGreaterThanOrEqual(0);
    value = value * 32n + BigInt(digit);
  }
  return Number(value);
}

/**
 * Wait until `argos ls --schedule <id>` lists a run for `fireAt`, and return it.
 *
 * The helper asserts there is exactly **one** such run at the moment it matches: two runs for one
 * fire time is the failure this whole scenario exists to rule out (G3).
 */
async function waitForScheduledRun(
  home: string,
  port: number,
  scheduleId: string,
  fireAt: number,
): Promise<RunSummary> {
  let matched: RunSummary[] = [];
  await waitFor(
    async () => {
      try {
        const listed = await cliJson<{ runs: RunSummary[] }>(
          ["ls", "--schedule", scheduleId],
          clientEnv(home, port),
        );
        matched = listed.runs.filter((run) => run.trigger?.fireAt === fireAt);
        return matched.length >= 1;
      } catch {
        // The server may still be coming up; the poll retries.
        return false;
      }
    },
    60_000,
    `one run of schedule ${scheduleId} for ${new Date(fireAt).toISOString()}`,
  );
  expect(
    matched.map((run) => run.id),
    "one fire time must start exactly one run",
  ).toHaveLength(1);
  return matched[0] as RunSummary;
}

async function statusOf(
  home: string,
  port: number,
  runId: string,
): Promise<RunDetail | undefined> {
  try {
    return await cliJson<RunDetail>(["status", runId], clientEnv(home, port));
  } catch {
    return undefined;
  }
}

async function waitForStatus(
  home: string,
  port: number,
  runId: string,
  predicate: (detail: RunDetail) => boolean,
  what: string,
): Promise<RunDetail> {
  let last: RunDetail | undefined;
  await waitFor(
    async () => {
      last = await statusOf(home, port, runId);
      return last !== undefined && predicate(last);
    },
    60_000,
    what,
  );
  if (last === undefined) throw new Error(`run ${runId} never reported a status`);
  return last;
}

async function pendingGates(home: string, port: number): Promise<GateSummary[]> {
  const response = await cliJson<GateListResponse>(["gates"], clientEnv(home, port));
  return response.gates;
}

afterEach(async () => {
  for (const child of [...children]) await stop(child);
  children.clear();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("durability across a real SIGKILL (D17)", () => {
  it(
    "finishes a 3-step run after a kill mid-step with exactly one launch per step",
    async () => {
      expect(existsSync(distIndex), "run `npm run build` before the E2E suite").toBe(true);

      const home = tempDir("argos-e2e-kill-home-");
      const repo = tempDir("argos-e2e-kill-repo-");
      writePlaybook(repo, "three", THREE_STEPS);
      const releaseFile = join(home, "release-step2");
      const fakeEnv = {
        ARGOS_FAKE_PASEO_BLOCK_STEP: "step2",
        ARGOS_FAKE_PASEO_RELEASE_FILE: releaseFile,
      };

      const first = await startServe(home, fakeEnv);
      const firstPid = first.child.pid;
      expect(firstPid).toBeTypeOf("number");

      const started = await cliJson<{ runId: string; taskId: string }>(
        ["run", "three", "--cwd", repo],
        clientEnv(home, first.port),
      );

      // Step 1 completes; step 2 is dispatched, its agent is created, and the fake holds it
      // running until the release file appears. Waiting for the ledger line (not just the
      // run-record status) pins the kill to a point where the create certainly happened.
      await waitFor(
        () => readLedger(home).some((line) => line.stepId === "step2"),
        60_000,
        "the step2 fake agent to be created",
      );
      const before = await waitForStatus(
        home,
        first.port,
        started.runId,
        (detail) =>
          detail.status === "running" &&
          detail.steps.find((step) => step.id === "step2")?.status === "running",
        "step2 to be running",
      );
      expect(before.status).toBe("running");
      expect(before.steps.find((step) => step.id === "step1")?.status).toBe("completed");
      expect(before.steps.find((step) => step.id === "step2")?.attemptCount).toBe(1);
      expect(before.steps.find((step) => step.id === "step3")?.status).toBe("pending");
      expect(readLedger(home).map((line) => line.stepId).sort()).toEqual(["step1", "step2"]);
      console.info(
        `[e2e] A before kill: pid=${String(firstPid)} status=${before.status} steps=${before.steps
          .map((step) => `${step.id}:${step.status}`)
          .join(",")} ledger=${readLedger(home).length}`,
      );

      // Kill the only writer. The pid file is now stale; no process owns the SQLite file.
      await killServe(first);
      expect(existsSync(join(home, "argos.sqlite"))).toBe(true);
      console.info(`[e2e] A killed pid ${String(firstPid)} with SIGKILL; pid file is stale`);
      // Release the blocked step *before* the restart, so the new process can finish it.
      writeFileSync(releaseFile, "released\n", "utf8");

      const second = await startServe(home, fakeEnv);
      const secondPid = second.child.pid;
      expect(secondPid).toBeTypeOf("number");
      expect(secondPid).not.toBe(firstPid);

      const done = await waitForStatus(
        home,
        second.port,
        started.runId,
        (detail) => detail.status === "completed" || detail.status === "failed",
        "the restarted run to finish",
      );
      expect(done.status, JSON.stringify(done.steps)).toBe("completed");
      expect(done.id).toBe(started.runId);
      expect(done.steps.map((step) => `${step.id}:${step.status}:${step.attemptCount}`)).toEqual([
        "step1:completed:1",
        "step2:completed:1",
        "step3:completed:1",
      ]);

      const ledger = readLedger(home);
      // This is the durability claim: one creation per step, across both process lifetimes.
      expect(ledger).toHaveLength(3);
      expect(ledger.map((line) => line.stepId).sort()).toEqual(["step1", "step2", "step3"]);
      expect(new Set(ledger.map((line) => line.requestId)).size).toBe(3);
      expect(new Set(ledger.map((line) => line.agentId)).size).toBe(3);
      expect(ledger.filter((line) => line.pid === firstPid).map((line) => line.stepId).sort()).toEqual([
        "step1",
        "step2",
      ]);
      expect(ledger.filter((line) => line.pid === secondPid).map((line) => line.stepId)).toEqual([
        "step3",
      ]);
      // Each step's request id is stable: `argos:<runId>:<stepId>:1` (D14).
      for (const line of ledger) {
        expect(line.requestId).toBe(`argos:${started.runId}:${line.stepId}:${line.attempt}`);
      }

      // The server is still the live owner after the restart.
      expect(second.child.exitCode).toBeNull();

      console.info(
        `[e2e] A after restart: pid=${String(secondPid)} status=${done.status} steps=${done.steps
          .map((step) => `${step.id}:${step.status}:${step.attemptCount}`)
          .join(",")} ledger=${ledger.length} (${ledger
          .map((line) => `${line.stepId}@pid${line.pid}`)
          .join(",")})`,
      );
    },
    120_000,
  );

  it(
    "keeps a gate pending across a kill, then accepts one decision and completes",
    async () => {
      expect(existsSync(distIndex), "run `npm run build` before the E2E suite").toBe(true);

      const home = tempDir("argos-e2e-gate-home-");
      const repo = tempDir("argos-e2e-gate-repo-");
      writePlaybook(repo, "gated", GATED);

      const first = await startServe(home);
      const started = await cliJson<{ runId: string; taskId: string }>(
        ["run", "gated", "--cwd", repo],
        clientEnv(home, first.port),
      );

      let gate: GateSummary | undefined;
      await waitFor(
        async () => {
          gate = (await pendingGates(home, first.port))[0];
          return gate !== undefined;
        },
        60_000,
        "the gate to be pending",
      );
      if (gate === undefined) throw new Error("the gate never opened");
      const gateId = gate.gateId;
      const before = await waitForStatus(
        home,
        first.port,
        started.runId,
        (detail) => detail.status === "waiting" && detail.gates[0]?.status === "pending",
        "the run to wait on the gate",
      );
      expect(before.steps.find((step) => step.id === "work")?.status).toBe("completed");
      expect(before.gates[0]?.gateId).toBe(gateId);
      expect(before.gates[0]?.question).toBe("Ship it?");
      console.info(
        `[e2e] B before kill: run=${started.runId} status=${before.status} gate=${gateId} pending`,
      );

      await killServe(first);

      const second = await startServe(home);
      // Same gate, same id, still pending: the gate document and run checkpoint survived.
      const afterRestart = await waitForStatus(
        home,
        second.port,
        started.runId,
        (detail) => detail.status === "waiting" && detail.gates[0]?.status === "pending",
        "the pending gate to survive the restart",
      );
      expect(afterRestart.gates[0]?.gateId).toBe(gateId);
      expect((await pendingGates(home, second.port)).map((entry) => entry.gateId)).toEqual([gateId]);
      console.info(
        `[e2e] B after restart: status=${afterRestart.status} gate=${gateId} still pending (same id)`,
      );

      const receipt = await cliJson<{ runId: string; gateId: string; decision: string; comment?: string }>(
        ["decide", started.runId, gateId, "approve", "--comment", "approved after restart"],
        clientEnv(home, second.port),
      );
      expect(receipt.runId).toBe(started.runId);
      expect(receipt.gateId).toBe(gateId);
      expect(receipt.decision).toBe("approve");
      expect(receipt.comment).toBe("approved after restart");

      const done = await waitForStatus(
        home,
        second.port,
        started.runId,
        (detail) => detail.status === "completed" || detail.status === "failed",
        "the gated run to finish",
      );
      expect(done.status, JSON.stringify(done.steps)).toBe("completed");
      expect(done.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
        "work:completed",
        "approve:completed",
      ]);
      expect(done.gates[0]).toMatchObject({
        gateId,
        status: "decided",
        decision: "approve",
        comment: "approved after restart",
      });
      expect(await pendingGates(home, second.port)).toEqual([]);
      console.info(
        `[e2e] B decided ${receipt.decision} (${String(receipt.comment ?? "")}); status=${done.status} steps=${done.steps
          .map((step) => `${step.id}:${step.status}`)
          .join(",")} gate=${String(done.gates[0]?.status)}`,
      );

      // The decision is final: a later write on the finished run is refused (the active-gate
      // duplicate case, `gate_already_decided`, is covered by the durable gate unit tests).
      const duplicate = await cli(["decide", started.runId, gateId, "approve"], clientEnv(home, second.port));
      expect(duplicate.code).not.toBe(0);
      expect(`${duplicate.stdout}${duplicate.stderr}`).toContain("run_terminal");
    },
    120_000,
  );

  it(
    "fires a due schedule exactly once when the kill covers the fire time",
    async () => {
      expect(existsSync(distIndex), "run `npm run build` before the E2E suite").toBe(true);

      const home = tempDir("argos-e2e-schedule-home-");
      const repo = tempDir("argos-e2e-schedule-repo-");
      writePlaybook(repo, "scheduled", SCHEDULED);

      const first = await startServe(home);
      const added = await cliJson<ScheduleDetail>(
        ["schedule", "add", "scheduled", "--cron", "* * * * *", "--tz", "UTC", "--cwd", repo],
        clientEnv(home, first.port),
      );
      expect(added.id).toBe("scheduled");
      expect(added.nextFireAt).not.toBeNull();

      // Read the fire time back from the stored document (not from the add receipt): this is the
      // instant the restarted process has to honour.
      const shown = await cliJson<ScheduleDetail>(
        ["schedule", "show", added.id],
        clientEnv(home, first.port),
      );
      const nextFireAt = shown.nextFireAt;
      if (nextFireAt === null) throw new Error("an enabled schedule must have a next fire time");
      // `* * * * *` in UTC fires on a whole minute, which is what makes the ULID prefix check exact.
      expect(nextFireAt % 60_000).toBe(0);
      expect(nextFireAt).toBeGreaterThan(Date.now());
      console.info(
        `[e2e] C schedule ${added.id} stored; next fire ${new Date(nextFireAt).toISOString()}`,
      );

      // Die before the fire time: a durable document (plus the fire commit) must be enough, so no
      // timer, task, or in-memory state of this process can be load-bearing.
      await killServe(first);
      console.info(`[e2e] C killed before the fire time; waiting for ${new Date(nextFireAt).toISOString()}`);

      // Let the wall clock pass the fire time by one second, so the restart must treat it as due.
      await waitFor(
        () => Date.now() > nextFireAt + 1_000,
        90_000,
        "the wall clock to pass the schedule's fire time",
      );

      const second = await startServe(home, {}, first.port);
      const fired = await waitForScheduledRun(home, second.port, added.id, nextFireAt);
      expect(fired.trigger).toMatchObject({
        kind: "schedule",
        scheduleId: added.id,
        fireAt: nextFireAt,
      });
      // Deterministic run id: the ULID time prefix is the fire time, so this run can only belong
      // to this fire (and a crash before its commit could only ever re-create the same id).
      expect(decodeUlidTime(fired.id)).toBe(nextFireAt);
      const runId = fired.id;
      console.info(
        `[e2e] C fired after restart: run=${runId} fireAt=${new Date(nextFireAt).toISOString()} (ULID prefix decoded)`,
      );

      const done = await waitForStatus(
        home,
        second.port,
        runId,
        (detail) => detail.status === "completed" || detail.status === "failed",
        "the scheduled run to finish",
      );
      expect(done.status, JSON.stringify(done.steps)).toBe("completed");
      expect(done.steps.map((step) => `${step.id}:${step.status}:${step.attemptCount}`)).toEqual([
        "only:completed:1",
      ]);

      // FR10.4: the operator sees the fire, and only that fire, on the server's stderr.
      const fireLine = `[argos] schedule ${added.id} ${new Date(nextFireAt).toISOString()} started run ${runId}`;
      await waitFor(
        () => second.stderr().includes(fireLine),
        30_000,
        `the fire line on argos serve stderr ("${fireLine}")`,
      );
      expect(second.stderr().split(fireLine)).toHaveLength(2);

      // One creation per step of that run: the step ran once, in the second lifetime.
      const firedLedger = readLedger(home).filter((line) => line.requestId.startsWith(`argos:${runId}:`));
      expect(firedLedger.map((line) => `${line.stepId}:${line.attempt}`)).toEqual(["only:1"]);

      // Kill and restart again, now *after* the fire: the persisted `lastFire` plus the run index
      // must make that fire time unfireable a second time.
      await killServe(second);
      const third = await startServe(home, {}, first.port);
      // The open tick runs on the first microtask after `open()`; give it a moment to settle
      // before the "no second run" claim (a tick that has nothing due writes nothing).
      const settleUntil = Date.now() + 1_500;
      await waitFor(
        () => Date.now() > settleUntil,
        10_000,
        "the restarted scheduler to settle after its first tick",
      );

      const listed = await cliJson<{ runs: RunSummary[] }>(
        ["ls", "--schedule", added.id],
        clientEnv(home, third.port),
      );
      const sameFire = listed.runs.filter((run) => run.trigger?.fireAt === nextFireAt);
      expect(sameFire.map((run) => run.id)).toEqual([runId]);

      const ledger = readLedger(home).filter((line) => line.requestId.startsWith(`argos:${runId}:`));
      expect(ledger.map((line) => `${line.stepId}:${line.attempt}`)).toEqual(["only:1"]);

      const after = await cliJson<ScheduleDetail>(
        ["schedule", "show", added.id],
        clientEnv(home, third.port),
      );
      expect(after.lastFire).toMatchObject({
        fireAt: nextFireAt,
        status: "started",
        runId,
      });
      expect(after.nextFireAt).not.toBeNull();
      expect(after.nextFireAt as number).toBeGreaterThan(nextFireAt);
      expect(after.consecutiveFailures).toBe(0);
      expect(third.child.exitCode).toBeNull();
      console.info(
        `[e2e] C after the second restart: one run for the fire time, ledger=${ledger.length},` +
          ` lastFire=${String(after.lastFire?.status)} next=${new Date(after.nextFireAt ?? 0).toISOString()}`,
      );
    },
    180_000,
  );
});
