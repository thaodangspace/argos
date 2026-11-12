import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import { HISTORY_LIMIT, pushHistoryEvent, type HistoryEvent } from "../../src/durable/mirror.js";
import {
  hydrateRunCheckpoint,
  InvalidRunCheckpointError,
} from "../../src/durable/tasks/run.js";
import { createRunRecord, hydrateRunRecord, InvalidRunRecordError } from "../../src/engine/index.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { diamondPlaybook, drive, singleStepPlaybook } from "./support.js";

describe("argos.run checkpoint (D4/D16)", () => {
  it("survives JSON -> schema -> JSON byte-for-byte", async () => {
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId, taskId } = await host.startRun({
        ir: diamondPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-hydrate",
      });

      const record = await host.getTaskRecord(taskId);
      if (
        record === undefined ||
        record.state.status === "terminal" ||
        record.state.status === "completing"
      ) {
        throw new Error("expected a live run checkpoint");
      }
      const json = JSON.stringify(record.state.checkpoint);
      // FR8.1: a manual run has no `trigger` key at all, so an old record is unchanged.
      const checkpointRecord = (JSON.parse(json) as { record: Record<string, unknown> })["record"];
      expect(checkpointRecord["trigger"]).toBeUndefined();
      const hydrated = hydrateRunCheckpoint(json);
      expect(JSON.stringify(hydrated)).toBe(json);
      expect(hydrated.record.id).toBe(runId);
      const mirror = await host.getRun(runId);
      expect(mirror).toBeDefined();
      expect(JSON.stringify(hydrated.record)).toBe(JSON.stringify(mirror?.record));

      // Unknown keys are rejected, not stripped: a checkpoint is a strict contract.
      const parsed = JSON.parse(json) as Record<string, unknown>;
      parsed["surprise"] = true;
      expect(() => hydrateRunCheckpoint(JSON.stringify(parsed))).toThrow(InvalidRunCheckpointError);
    } finally {
      await host.close();
    }
  });

  it("round-trips a schedule trigger and refuses a malformed one (FR8.1)", () => {
    const ir = singleStepPlaybook();
    const now = 1_767_225_600_000;
    const trigger = {
      kind: "schedule",
      scheduleId: "nightly",
      fireAt: now,
      reason: "cron",
    } as const;

    // A manual record writes today's exact key set and order: the `trigger` key is absent, so an
    // old record and a new one serialize identically.
    const manual = createRunRecord({
      id: "run-manual",
      ir,
      inputs: {},
      cwd: "/tmp/argos-manual",
      now,
    });
    expect(Object.keys(manual)).toEqual([
      "id",
      "playbookId",
      "playbookHash",
      "ir",
      "inputs",
      "status",
      "cwd",
      "steps",
      "loops",
      "loopAllowance",
      "gates",
      "after",
      "exhausted",
      "createdAt",
      "updatedAt",
      "seq",
    ]);
    const manualJson = JSON.stringify(manual);
    expect(manualJson).not.toContain('"trigger"');
    expect(JSON.stringify(hydrateRunRecord(manualJson))).toBe(manualJson);

    // A triggered record hydrates byte-for-byte, key order included.
    const triggered = createRunRecord({
      id: "run-triggered",
      ir,
      inputs: {},
      cwd: "/tmp/argos-scheduled",
      now,
      trigger,
    });
    expect(Object.keys(triggered)).toEqual([
      "id",
      "playbookId",
      "playbookHash",
      "ir",
      "inputs",
      "status",
      "cwd",
      "trigger",
      "steps",
      "loops",
      "loopAllowance",
      "gates",
      "after",
      "exhausted",
      "createdAt",
      "updatedAt",
      "seq",
    ]);
    expect(triggered.trigger).toEqual(trigger);
    const triggeredJson = JSON.stringify(triggered);
    expect(JSON.stringify(hydrateRunRecord(triggeredJson))).toBe(triggeredJson);

    // Strict, nested: an extra key inside `trigger` and an unknown reason are both refused.
    const withUnknownKey = JSON.parse(triggeredJson) as { trigger: Record<string, unknown> };
    withUnknownKey.trigger["surprise"] = true;
    expect(() => hydrateRunRecord(JSON.stringify(withUnknownKey))).toThrow(InvalidRunRecordError);

    const withBadReason = JSON.parse(triggeredJson) as { trigger: Record<string, unknown> };
    withBadReason.trigger["reason"] = "x";
    expect(() => hydrateRunRecord(JSON.stringify(withBadReason))).toThrow(InvalidRunRecordError);
  });

  it("keeps the newest 500 history events", () => {
    const events: HistoryEvent[] = [];
    for (let index = 0; index < HISTORY_LIMIT + 25; index += 1) {
      pushHistoryEvent(events, {
        at: index,
        seq: index,
        type: "select",
        stepId: null,
        attempt: null,
        detail: null,
      });
    }
    expect(events).toHaveLength(HISTORY_LIMIT);
    expect(events[0]?.seq).toBe(25);
    expect(events[events.length - 1]?.seq).toBe(HISTORY_LIMIT + 24);
  });

  it("records a step timeout, retries once, then fails the run with step_timeout", async () => {
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId } = await host.startRun({
        ir: singleStepPlaybook({ timeout: 1_000, retries: 1, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-timeout",
      });

      // Poll 1 at +1s sees the deadline and retries with a fresh request id.
      await clock.advance(1_000);
      let doc = await host.getRun(runId);
      expect(doc?.record.status).toBe("running");

      // Retry attempt 2 is launched and eventually times out too; the run fails.
      await drive(
        clock,
        async () => {
          const current = await host.getRun(runId);
          return current?.record.status === "failed" || current?.record.status === "completed";
        },
        { stepMs: 1_000, maxRounds: 10 },
      );

      doc = await host.getRun(runId);
      expect(doc?.record.status).toBe("failed");
      expect(doc?.record.errorCode).toBe("step_timeout");
      expect(doc?.record.steps["a"]?.status).toBe("failed");
      expect(doc?.record.steps["a"]?.errorCode).toBe("step_timeout");
    } finally {
      await host.close();
    }
  });
});
