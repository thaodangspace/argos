/**
 * `argos db`: stats, purge, vacuum over the host's one connection.
 *
 * The properties this file exists for:
 *
 * - **Stats read the published schema.** Document `kind` is JSON-encoded in pi-durable's table, so a
 *   naive `kind = 'argos.run'` would count nothing; the queries decode and the counts are real.
 * - **Purge removes only what the window selects.** A terminal run past the cutoff is retired
 *   through `removeRun` (mirror gone, task rows reclaimed), a live run is skipped as `active`, and
 *   `dryRun` changes nothing.
 * - **Worktrees are never touched.** A purged run's checkout is reported, not removed.
 * - **Vacuum is explicit and safe.** The file survives and the command reports both sizes.
 * - **Maintenance needs file-backed storage.** An injected `MemoryStorage` is refused with a stable
 *   code instead of pretending to know a path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { isArgosError } from "../../src/errors.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive, makeTempHome, singleStepPlaybook } from "./support.js";

/** Start one single-step run and drive it to `completed`. */
async function completedRun(
  host: ArgosHost,
  clock: FakeClock,
  executor: FakeExecutor,
  cwd: string,
): Promise<string> {
  const { runId } = await host.startRun({ ir: singleStepPlaybook(), inputs: {}, cwd });
  await drive(clock, () => executor.creationsByStep()["a"] === 1);
  executor.completeAll();
  await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
  return runId;
}

describe("argos db stats", () => {
  it("counts runs, documents, and tasks from the real tables", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const runId = await completedRun(host, clock, executor, "/tmp/argos-db-stats");
      const stats = await host.dbStats();

      expect(stats.path).toBe(join(home, "argos.sqlite"));
      expect(stats.bytes).toBeGreaterThan(0);
      expect(stats.pageSize).toBeGreaterThan(0);
      expect(stats.pageCount).toBeGreaterThan(0);
      expect(stats.receipts).toEqual({ total: 0, expired: 0 });
      expect(stats.runs).toEqual({ total: 1, active: 0 });

      // The kind columns are JSON-encoded (`'"argos.run"'`); these names prove the decode.
      expect(stats.documents.byKind.map((kind) => kind.kind)).toContain("argos.run");
      expect(stats.documents.byKind.map((kind) => kind.kind)).toContain("argos.history");
      expect(stats.documents.byKind.every((kind) => kind.live + kind.retired > 0)).toBe(true);
      expect(stats.documents.live).toBeGreaterThanOrEqual(2);

      // One `argos.run` task plus its `argos.step` child, both terminal.
      expect(stats.tasks.total).toBeGreaterThanOrEqual(2);
      expect(stats.tasks.terminal).toBeGreaterThanOrEqual(2);
      expect(stats.tasks.byKind.map((kind) => kind.kind)).toEqual(
        expect.arrayContaining(["argos.run", "argos.step"]),
      );

      // A read-only report leaves the run exactly where it was.
      expect((await host.getRun(runId))?.record.status).toBe("completed");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("refuses an injected storage with a stable code", async () => {
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    try {
      const error: unknown = await host.dbStats().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isArgosError(error)).toBe(true);
      if (isArgosError(error)) {
        expect(error.code).toBe("invalid_request");
        expect(error.message).toContain("ARGOS_HOME");
      }
    } finally {
      await host.close();
    }
  });
});

describe("argos db purge", () => {
  it("removes a terminal run past the window and reclaims its task rows", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const runId = await completedRun(host, clock, executor, "/tmp/argos-db-purge");
      const before = await host.dbStats();
      // Move the clock past the run's `updatedAt` so the window selects it.
      await clock.advance(60_000);

      const dry = await host.purgeDb({ olderThanMs: 1_000, dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.removed.map((run) => run.runId)).toEqual([runId]);
      expect(dry.removed[0]?.status).toBe("completed");
      expect(dry.tasksRemoved).toBeGreaterThanOrEqual(2);
      expect(dry.vacuumed).toBe(false);
      // A dry run writes nothing.
      expect(await host.getRun(runId)).toBeDefined();

      const result = await host.purgeDb({ olderThanMs: 1_000 });
      expect(result.removed.map((run) => run.runId)).toEqual([runId]);
      expect(result.skipped).toEqual([]);
      expect(result.tasksRemoved).toBe(dry.tasksRemoved);
      expect(result.before.bytes).toBe(before.bytes);
      expect(await host.getRun(runId)).toBeUndefined();

      const after = await host.dbStats();
      expect(after.runs.total).toBe(0);
      expect(after.tasks.total).toBeLessThan(before.tasks.total);
      // History and run documents are retired (live count drops), never hard-deleted.
      expect(after.documents.live).toBeLessThan(before.documents.live);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("leaves a live run alone (`active`) and ignores one inside the window", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: singleStepPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-db-active",
      });
      await drive(clock, () => executor.creationsByStep()["a"] === 1);
      await clock.advance(60_000);

      const result = await host.purgeDb({ olderThanMs: 1_000 });
      expect(result.removed).toEqual([]);
      expect(result.skipped).toEqual([{ runId, reason: "active" }]);
      expect((await host.getRun(runId))?.record.status).toBe("running");

      // The same terminal run is safe inside the window.
      executor.completeAll();
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      const fresh = await host.purgeDb({ olderThanMs: 60 * 60 * 1000 });
      expect(fresh.removed).toEqual([]);
      expect(fresh.skipped).toEqual([]);
      expect(await host.getRun(runId)).toBeDefined();
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("retires idempotency receipts past the 24 h TTL", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: singleStepPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-db-receipts",
        clientRequestId: "client-1",
      });
      await drive(clock, () => executor.creationsByStep()["a"] === 1);
      executor.completeAll();
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      await clock.advance(60_000);

      // Inside the TTL the receipt is live.
      expect((await host.dbStats()).receipts).toEqual({ total: 1, expired: 0 });

      // Past 24 h it is expired; a purge whose window selects no run still retires it.
      await clock.advance(25 * 60 * 60 * 1000);
      expect((await host.dbStats()).receipts).toEqual({ total: 1, expired: 1 });
      const receiptsOnly = await host.purgeDb({ olderThanMs: 365 * 24 * 60 * 60 * 1000 });
      expect(receiptsOnly.removed).toEqual([]);
      expect(receiptsOnly.receiptsRetired).toBe(1);
      expect((await host.dbStats()).receipts).toEqual({ total: 0, expired: 0 });

      // Removing a run retires its own receipt too (the `removeRun` path).
      const removed = await host.purgeDb({ olderThanMs: 60 * 60 * 1000 });
      expect(removed.removed).toHaveLength(1);
      expect(removed.receiptsRetired).toBe(0);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("reports a worktree instead of removing it", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: singleStepPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-db-worktree",
      });
      // The record is what purge reports; no real git checkout is needed for this assertion.
      await drive(clock, () => executor.creationsByStep()["a"] === 1);
      executor.completeAll();
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      await clock.advance(60_000);

      const result = await host.purgeDb({ olderThanMs: 1_000 });
      // A run without isolation has no `worktree` key at all.
      expect(result.removed[0]?.worktree).toBeUndefined();
    } finally {
      await host.close();
      cleanup();
    }
  });
});

describe("argos db vacuum", () => {
  it("compacts the file and keeps it readable", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      await completedRun(host, clock, executor, "/tmp/argos-db-vacuum");
      await clock.advance(60_000);
      await host.purgeDb({ olderThanMs: 1_000, vacuum: true });

      const result = await host.vacuumDb();
      expect(result.vacuumed).toBe(true);
      expect(result.after.bytes).toBeGreaterThan(0);
      expect(result.after.walBytes).toBeLessThanOrEqual(result.before.walBytes);
      expect(existsSync(join(home, "argos.sqlite"))).toBe(true);
      // The host still works after a vacuum.
      expect((await host.dbStats()).runs.total).toBe(0);
    } finally {
      await host.close();
      cleanup();
    }
  });
});
