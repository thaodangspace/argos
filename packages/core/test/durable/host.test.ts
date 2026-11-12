import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  type CommitPublication,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import { writeRunMirror } from "../../src/durable/mirror.js";
import type { RunRecord } from "../../src/engine/index.js";
import { isArgosError } from "../../src/errors.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { diamondPlaybook, drive, flush, makeTempHome } from "./support.js";

describe("ArgosHost (FR2/FR4/FR29)", () => {
  it("creates a private home, database, and pid file", async () => {
    const { home, cleanup } = makeTempHome();
    const host = await ArgosHost.open({
      home,
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    try {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "argos.sqlite")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(home, "serve.pid"), "utf8").trim()).toBe(String(process.pid));
      expect(host.home).toBe(home);
    } finally {
      await host.close();
    }
    expect(existsSync(join(home, "serve.pid"))).toBe(false);
    cleanup();
  });

  it("is a single writer: a live pid refuses a second host, stale pids are replaced", async () => {
    const { home, cleanup } = makeTempHome();
    const first = await ArgosHost.open({
      home,
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    try {
      const error: unknown = await ArgosHost.open({
        home,
        clock: new FakeClock(),
        executor: new FakeExecutor(),
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isArgosError(error)).toBe(true);
      if (isArgosError(error)) {
        expect(error.code).toBe("storage_locked");
        expect(error.message).toContain("serve.pid");
      }
    } finally {
      await first.close();
    }

    // After close the home is free again.
    const second = await ArgosHost.open({
      home,
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    await second.close();

    // A pid file naming a dead process is stale, not a lock.
    writeFileSync(join(home, "serve.pid"), "99999999\n");
    const third = await ArgosHost.open({
      home,
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    try {
      expect(readFileSync(join(home, "serve.pid"), "utf8").trim()).toBe(String(process.pid));
    } finally {
      await third.close();
    }
    cleanup();
  });

  it("mirrors the checkpoint in every commit, never schedules a generation task, and stubs models", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ home, clock, executor });
    try {
      const mismatches: string[] = [];
      let comparisons = 0;
      let lastMirror: string | undefined;
      const observation = host.harness.observeCommits({
        advance(publication: CommitPublication) {
          const taskChange = publication.changes.find(
            (change) => change.type === "task" && change.value.kind === "argos.run",
          );
          const docChange = publication.changes.find(
            (change) =>
              change.type === "document" &&
              change.kind === "change" &&
              change.record.kind === "argos.run",
          );
          const docRecord =
            docChange !== undefined && docChange.type === "document" && docChange.kind === "change"
              ? JSON.stringify(docChange.value["record"])
              : undefined;
          if (
            taskChange !== undefined &&
            taskChange.type === "task" &&
            taskChange.value.state.status !== "terminal" &&
            taskChange.value.state.status !== "completing"
          ) {
            const checkpoint = taskChange.value.state.checkpoint as { record: unknown };
            const record = JSON.stringify(checkpoint.record);
            if (docRecord !== undefined) {
              comparisons += 1;
              lastMirror = docRecord;
              if (record !== docRecord) {
                mismatches.push(`doc/checkpoint diverged at seq ${JSON.stringify(record).length}`);
              }
            } else if (lastMirror !== undefined && record !== lastMirror) {
              mismatches.push("checkpoint changed without a mirror write in the same commit");
            }
          }
          if (docRecord !== undefined) lastMirror = docRecord;
        },
        end() {
          // Publication ends at close; nothing to assert.
        },
      });

      const { runId, taskId } = await host.startRun({
        ir: diamondPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-diamond",
      });
      // The task exists; resume explicitly (open/startRun also do it) and let it run.
      host.resume();

      let sawGeneration = false;
      await drive(
        clock,
        async () => {
          executor.completeAll();
          for (const task of (await host.inspect()).tasks) {
            if (task.record.kind === "pi.generation") sawGeneration = true;
          }
          const doc = await host.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 30 },
      );
      // Let the last commit publications reach the observer before detaching.
      await clock.advance(0);
      await flush();
      observation.detach();

      expect(mismatches).toEqual([]);
      // Five commits actually change the record (start, dispatch a, dispatch b+c, dispatch d,
      // finish). Commits that only advance the phase re-write the identical mirror, which Chord
      // stores without a document change; those are checked against `lastMirror` above.
      expect(comparisons).toBeGreaterThanOrEqual(5);

      const doc = await host.getRun(runId);
      expect(doc?.record.status).toBe("completed");
      expect(doc?.taskId).toBe(taskId);
      expect(Object.keys(doc?.record.steps ?? {})).toEqual(["a", "b", "c", "d"]);
      for (const status of Object.values(doc?.record.steps ?? {})) {
        expect(status.status).toBe("completed");
      }

      const history = await host.getHistory(runId);
      expect(history?.events.length ?? 0).toBeGreaterThan(4);
      expect(history?.events.some((event) => event.type === "dispatch")).toBe(true);

      const task = (await host.getTaskRecord(taskId)) as TaskRecord<unknown, unknown, unknown>;
      const state = task.state as { status: string; outcome?: { status: string } };
      expect(state.status).toBe("terminal");
      expect(state.outcome?.status).toBe("completed");
      expect(task.owner).toBeUndefined();

      // D6: the stub models fail loudly on any use, so no generation task can ever appear.
      expect(sawGeneration).toBe(false);
      expect((await host.inspect()).tasks).toEqual([]);
      const models = host.models as unknown as { stream: () => unknown };
      expect(() => models.stream()).toThrow(/no model access/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("resumes work left by a previous process", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor();
    const clock = new FakeClock();
    const first = await ArgosHost.open({ home, clock, executor });
    const { runId, taskId } = await first.startRun({
      ir: diamondPlaybook(),
      inputs: {},
      cwd: "/tmp/argos-resume",
    });
    // Park the first step in its `await` sleep, then stop the process.
    await drive(clock, () => executor.creationsByStep()["a"] === 1);
    await clock.advance(1_000);
    await flush();
    expect((await first.getRun(runId))?.record.status).toBe("running");
    await first.close();

    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      // `open()` already called resume(): the run keeps going to completion.
      expect((await second.getRun(runId))?.record.status).not.toBe("completed");
      await drive(
        clock2,
        async () => {
          executor.completeAll();
          const doc = await second.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 20 },
      );
      const task = await second.getTaskRecord<unknown>(taskId);
      const state = task?.state as { status?: string } | undefined;
      expect(state?.status).toBe("terminal");
      expect((await second.getRun(runId))?.record.status).toBe("completed");
      expect(executor.creationsByStep()).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("keeps a scheduled run's trigger across a retry clone (FR8.3)", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId, taskId } = await host.startRun({
        ir: diamondPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-retry-trigger",
        id: "run-retry-trigger",
      });
      await drive(
        clock,
        async () => {
          executor.completeAll();
          const doc = await host.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 30 },
      );

      // FR8.1: only the scheduler sets `trigger`, and it does so on the mirrored record (the public
      // `startRun` input has none until the scheduler's start path lands).
      const doc = await host.getRun(runId);
      if (doc === undefined) throw new Error("run is missing");
      const trigger = {
        kind: "schedule",
        scheduleId: "nightly",
        fireAt: clock.now(),
        reason: "cron",
      } as const;
      const scheduled: RunRecord = {
        ...(JSON.parse(JSON.stringify(doc.record)) as RunRecord),
        trigger,
      };
      await host.harness.commit(async (tx) => {
        await writeRunMirror(tx, Number(taskId) as TaskId, scheduled);
      }, host.context);
      expect((await host.getRun(runId))?.record.trigger).toEqual(trigger);

      // A retry clones the mirrored record under the same run id, so the original fire survives.
      await host.retryStep(runId, "d");
      await drive(
        clock,
        async () => {
          executor.completeAll();
          return (await host.getRun(runId))?.record.status === "completed";
        },
        { stepMs: 3_000, maxRounds: 30 },
      );

      const retried = await host.getRun(runId);
      expect(retried?.record.id).toBe(runId);
      expect(retried?.record.status).toBe("completed");
      expect(retried?.record.trigger).toEqual(trigger);
    } finally {
      await host.close();
    }
  });
});
