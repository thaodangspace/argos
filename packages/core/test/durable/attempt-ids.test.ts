/**
 * Attempt ids across the engine/step boundary.
 *
 * The engine records one dispatch attempt per child task, while `argos.step` counts its own local
 * retries (timeout, invalid output, quota wait). When both rendered the same
 * `argos:<runId>:<stepId>:<n>` request id, a step that used a local retry and was then re-dispatched
 * (a loop, a retry, or a gate "rerun") reused that request id; `launch` adopted the finished agent
 * instead of creating a new one. This is the regression for that collision.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive } from "./support.js";

function quotaStepPlaybook(): PlaybookIR {
  // A step that reports `needs_human` opens an ask gate; `rerun` sends the step straight back to
  // itself, which is the engine's next dispatch of the same step.
  const ir = playbook({
    id: "attempt-ids",
    steps: [
      step({
        id: "build",
        agent: { provider: "claude", model: "opus", labels: {} },
        outputs: { summary: { type: "string", required: true } },
        outcomes: ["continue", "needs_human"],
        on: {
          continue: { kind: "complete" },
          needs_human: {
            kind: "ask",
            ask: "Rerun the merge loop?",
            target: "build",
            choices: {
              rerun: { label: "Rerun", comment: "optional", goto: "build" },
              stop: { label: "Stop", comment: "optional", outcome: "continue" },
            },
          },
        },
        pollMs: 1_000,
      }),
    ],
  });
  return { ...ir, providers: { onExhausted: "wait", exhaustedForMs: 60_000 } };
}

describe("step attempt ids", () => {
  it("never reuses a local quota-relaunch id when the engine redispatches the step", async () => {
    const clock = new FakeClock();
    let localAttempts = 0;
    const executor = new FakeExecutor({
      complete: (agent) => {
        // The dispatched agent runs out of quota; the step waits, then relaunches locally once.
        if (agent.requestId.endsWith(":build:1")) return { errorCode: "provider_exhausted" };
        localAttempts += 1;
        return localAttempts === 1
          ? { outcome: "needs_human", outputs: { summary: "needs a human" } }
          : { outcome: "continue", outputs: { summary: "merged" } };
      },
    });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: quotaStepPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-attempt-ids",
        id: "run-attempt-ids",
      });

      // The first attempt runs out of quota; the step waits out the window and relaunches locally.
      await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1, {
        stepMs: 10_000,
        maxRounds: 20,
      });
      expect(executor.creations).toEqual([
        `argos:${runId}:build:1`,
        `argos:${runId}:build:1.1`,
      ]);

      // "rerun" is the engine's dispatch attempt 2. It must create a fresh agent, not adopt the
      // frozen local-retry agent that already reported `needs_human`.
      await host.decideGate(runId, "build:1", "rerun");
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed", {
        stepMs: 2_000,
        maxRounds: 30,
      });

      expect(executor.creations).toEqual([
        `argos:${runId}:build:1`,
        `argos:${runId}:build:1.1`,
        `argos:${runId}:build:2`,
      ]);
      expect(new Set(executor.creations).size).toBe(executor.creations.length);

      const record = (await host.getRun(runId))?.record;
      expect(record?.steps["build"]?.attempts.map((attempt) => attempt.n)).toEqual([1, 2]);
      expect(record?.steps["build"]?.attempts.map((attempt) => attempt.requestId)).toEqual([
        `argos:${runId}:build:1`,
        `argos:${runId}:build:2`,
      ]);
    } finally {
      await host.close();
    }
  });
});
