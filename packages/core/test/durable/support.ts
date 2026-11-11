/** Shared helpers for the durable host tests (not a test file itself). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import type { ArgosHost } from "../../src/durable/host.js";
import type { RunDoc } from "../../src/durable/mirror.js";
import type { FakeClock } from "../fakes/clock.js";
import { flushMicrotasks } from "../fakes/clock.js";

export interface TempHome {
  readonly home: string;
  cleanup(): void;
}

/** A fresh `$ARGOS_HOME` under the OS temp directory. */
export function makeTempHome(): TempHome {
  const home = mkdtempSync(join(tmpdir(), "argos-host-"));
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** `a → (b, c) → d`, the parallel diamond from the plan. */
export function diamondPlaybook(): PlaybookIR {
  return playbook({
    id: "diamond",
    steps: [
      step({ id: "a" }),
      step({ id: "b", needs: ["a"] }),
      step({ id: "c", needs: ["a"] }),
      step({ id: "d", needs: ["b", "c"] }),
    ],
  });
}

/** One step named `a`, for timeout/retry tests. */
export function singleStepPlaybook(options: {
  readonly timeout?: number;
  readonly retries?: number;
  readonly pollMs?: number;
} = {}): PlaybookIR {
  return playbook({
    id: "single",
    steps: [
      step({
        id: "a",
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      }),
    ],
  });
}

/** `draft → review(gate)`: the gate step and its `revise` goto exercise a decision plus feedback. */
export function gatedPlaybook(): PlaybookIR {
  return playbook({
    id: "gated",
    steps: [
      step({ id: "draft", prompt: "Draft the change.\nFeedback so far: {{ feedback }}" }),
      step({
        id: "review",
        kind: "gate",
        needs: ["draft"],
        outcomes: ["approve", "revise"],
        gate: {
          question: "Ship it?",
          choices: {
            approve: { label: "Approve", comment: "optional" },
            revise: { label: "Revise", comment: "required" },
          },
        },
        on: {
          approve: { kind: "end", outcome: "approved" },
          revise: { kind: "goto", target: "draft" },
        },
      }),
    ],
  });
}

/** `fix → review`, where `changes` goes back to `fix` at most once (`max_loops: 1`). */
export function loopPlaybook(): PlaybookIR {
  return playbook({
    id: "loopy",
    steps: [
      step({ id: "fix", prompt: "Fix it.\nReviewer feedback: {{ feedback }}" }),
      step({
        id: "review",
        needs: ["fix"],
        outcomes: ["changes", "approve"],
        on: {
          changes: { kind: "goto", target: "fix", maxLoops: 1 },
          approve: { kind: "end", outcome: "approved" },
        },
      }),
    ],
  });
}

/** One main step plus one `auto` and one `manual` after-task (FR11). */
export function afterPlaybook(): PlaybookIR {
  return playbook({
    id: "with-after",
    steps: [step({ id: "main" })],
    after: [
      { id: "report", title: "Report", trigger: "auto", steps: [step({ id: "report-step" })] },
      { id: "cleanup", title: "Cleanup", trigger: "manual", steps: [step({ id: "cleanup-step" })] },
    ],
  });
}

/** Read the mirrored run. */
export async function readRun(host: ArgosHost, runId: string): Promise<RunDoc | undefined> {
  return host.getRun(runId);
}

/** Flush queued work without moving the clock. */
export async function flush(): Promise<void> {
  await flushMicrotasks();
}

/**
 * Advance the fake clock in `stepMs` slices until `predicate` holds. Each slice flushes
 * microtasks, so one slice is enough for a phase to commit and the next to be scheduled.
 */
export async function drive(
  clock: FakeClock,
  predicate: () => boolean | Promise<boolean>,
  options: { readonly stepMs?: number; readonly maxRounds?: number } = {},
): Promise<number> {
  const stepMs = options.stepMs ?? 1_000;
  const maxRounds = options.maxRounds ?? 40;
  await flush();
  for (let round = 0; round <= maxRounds; round += 1) {
    if (await predicate()) return round;
    if (round === maxRounds) break;
    await clock.advance(stepMs);
    await flush();
  }
  throw new Error(`drive: predicate still false after ${maxRounds} rounds`);
}
