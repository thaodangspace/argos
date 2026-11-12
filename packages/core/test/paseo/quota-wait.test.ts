import { describe, expect, it } from "vitest";

import type { AgentStatusInput } from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR, ProvidersIR } from "../../src/playbook/ir.js";
import { createAgentStepExecutor } from "../../src/paseo/agent-step.js";
import { ModelCatalog } from "../../src/paseo/model-catalog.js";
import { isQuotaNotice } from "../../src/paseo/port.js";
import { FakeClock } from "../fakes/clock.js";
import { FakePaseoPort } from "../fakes/paseo.js";
import { drive, makeTempHome } from "../durable/support.js";

const NOTICE = "You've hit your 5-hour limit · resets 1:50am (Asia/Saigon)";

function quotaPlaybook(
  providers?: ProvidersIR,
  fallbacks?: readonly { readonly provider: string; readonly model: string }[],
): PlaybookIR {
  const ir = playbook({
    id: "quota",
    steps: [
      step({
        id: "build",
        agent: { provider: "claude", model: "opus", labels: {} },
        ...(fallbacks === undefined ? {} : { fallbacks }),
        prompt: "Build the change.",
        outputs: { summary: { type: "string", required: true } },
        outcomes: ["success"],
        on: { success: { kind: "complete" } },
        pollMs: 1_000,
      }),
    ],
  });
  return providers === undefined ? ir : { ...ir, providers };
}

/** First create answers with the usage-limit notice, every later one with a valid result. */
function noticeThenSuccess(port: FakePaseoPort): void {
  let creates = 0;
  port.completeOnCreate = () => {
    creates += 1;
    return creates === 1 ? { text: NOTICE } : { output: { summary: "done", outcome: "success" } };
  };
}

async function runToEnd(
  ir: PlaybookIR,
  port: FakePaseoPort,
  until: "completed" | "failed",
  options: { readonly stepMs: number; readonly maxRounds: number },
) {
  const { home, cleanup } = makeTempHome();
  const clock = new FakeClock();
  const executor = createAgentStepExecutor({ port, now: () => clock.now() });
  const catalog = await ModelCatalog.load(port);
  const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
  try {
    const { runId } = await host.startRun({ ir, inputs: {}, cwd: "/tmp/argos-quota-wait" });
    await drive(clock, async () => (await host.getRun(runId))?.record.status === until, options);
    return { runId, doc: await host.getRun(runId) };
  } finally {
    await host.close();
    cleanup();
  }
}

describe("usage-limit notices (FR24)", () => {
  it("recognizes plan-limit notices only as short text", () => {
    expect(isQuotaNotice(NOTICE)).toBe(true);
    expect(isQuotaNotice("You've hit your weekly limit")).toBe(true);
    expect(isQuotaNotice("Claude usage limit reached. Your limit will reset at 5pm.")).toBe(true);
    expect(isQuotaNotice("Merged #57 and synced #58.")).toBe(false);
    expect(isQuotaNotice(`${"report ".repeat(200)} rate limit`)).toBe(false);
    expect(isQuotaNotice(null)).toBe(false);
  });

  it("relaunches on the next target when a turn ends on a notice", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => 5_000 });
    const old = port.seedAgent({
      labels: { "argos/launch": "argos:run-1:build:1" },
      target: "claude/opus",
      status: "idle",
      lastMessage: NOTICE,
    });
    const input: AgentStatusInput = {
      requestId: "argos:run-1:build:1",
      label: "l",
      runId: "run-1",
      stepId: "build",
      attempt: 1,
      cwd: "/tmp/w",
      agentId: old.id,
      target: "claude/opus",
      targets: ["claude/opus", "codex/gpt"],
      outcomes: ["success"],
      outputs: ["summary"],
      outputDefs: { summary: { type: "string", required: true } },
    };
    const status = await executor.status(input);
    expect(status).toMatchObject({ state: "running", target: "codex/gpt" });
    expect(status.exhausted).toEqual([{ target: "claude/opus", at: 5_000 }]);
    expect(port.archiveCalls).toEqual([old.id]);

    const again = port.seedAgent({
      labels: { "argos/launch": "argos:run-1:build:1" },
      target: "claude/opus",
      status: "idle",
      lastMessage: NOTICE,
    });
    const blocked = await executor.status({ ...input, agentId: again.id, targets: ["claude/opus"] });
    expect(blocked).toMatchObject({ state: "done", errorCode: "provider_exhausted" });
  });
});

describe("providers.on_exhausted through the durable host", () => {
  it("fails provider_exhausted (not invalid_output) under the default policy", async () => {
    const port = new FakePaseoPort();
    noticeThenSuccess(port);
    const { doc } = await runToEnd(quotaPlaybook(), port, "failed", { stepMs: 1_000, maxRounds: 20 });
    expect(doc?.record.steps["build"]?.errorCode).toBe("provider_exhausted");
    expect(port.creates).toHaveLength(1);
  });

  it("waits out the window, relaunches with a fresh request id, and completes", async () => {
    const port = new FakePaseoPort();
    noticeThenSuccess(port);
    const { runId, doc } = await runToEnd(
      quotaPlaybook({ onExhausted: "wait", exhaustedForMs: 60_000 }),
      port,
      "completed",
      { stepMs: 5_000, maxRounds: 40 },
    );
    expect(doc?.record.steps["build"]?.outputs).toEqual({ summary: "done" });
    expect(doc?.record.steps["build"]?.attempts).toHaveLength(1);
    expect(port.creates.map((create) => create.requestId)).toEqual([
      `argos:${runId}:build:1`,
      `argos:${runId}:build:2`,
    ]);
    expect(port.creates.map((create) => create.config.provider)).toEqual(["claude/opus", "claude/opus"]);
    expect(port.archiveCalls).toHaveLength(1);
  });

  it("does not consume retries while waiting", async () => {
    const port = new FakePaseoPort();
    let creates = 0;
    port.completeOnCreate = () => {
      creates += 1;
      return creates <= 2 ? { text: NOTICE } : { output: { summary: "done", outcome: "success" } };
    };
    const { doc } = await runToEnd(
      quotaPlaybook({ onExhausted: "wait", exhaustedForMs: 60_000 }),
      port,
      "completed",
      { stepMs: 5_000, maxRounds: 80 },
    );
    expect(doc?.record.steps["build"]?.status).toBe("completed");
    expect(port.creates).toHaveLength(3);
  });

  it("fails once the wait would exceed max_wait", async () => {
    const port = new FakePaseoPort();
    noticeThenSuccess(port);
    const { doc } = await runToEnd(
      quotaPlaybook({ onExhausted: "wait", exhaustedForMs: 60 * 60_000, maxWaitMs: 10 * 60_000 }),
      port,
      "failed",
      { stepMs: 1_000, maxRounds: 20 },
    );
    expect(doc?.record.steps["build"]?.errorCode).toBe("provider_exhausted");
    expect(port.creates).toHaveLength(1);
  });
});
