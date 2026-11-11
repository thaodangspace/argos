import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { isArgosError } from "../../src/errors.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { createAgentStepExecutor } from "../../src/paseo/agent-step.js";
import { ModelCatalog } from "../../src/paseo/model-catalog.js";
import { FakeClock, FAKE_EPOCH } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { FakePaseoPort } from "../fakes/paseo.js";
import { drive, makeTempHome } from "../durable/support.js";

/** A one-step agent playbook that declares an output and one routable outcome. */
function structuredPlaybook(options: {
  readonly provider?: string;
  readonly model?: string;
  readonly fallbacks?: readonly { readonly provider: string; readonly model: string }[];
  readonly timeout?: number;
  readonly retries?: number;
  readonly pollMs?: number;
} = {}) {
  const provider = options.provider ?? "claude";
  const model = options.model ?? "opus";
  return playbook({
    id: "phase6",
    steps: [
      step({
        id: "build",
        agent: { provider, model, labels: {} },
        ...(options.fallbacks === undefined ? {} : { fallbacks: options.fallbacks }),
        prompt: "Build the change.",
        outputs: { summary: { type: "string", required: true } },
        outcomes: ["success"],
        on: { success: { kind: "complete" } },
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      }),
    ],
  });
}

async function statusOf(host: ArgosHost, runId: string): Promise<string | undefined> {
  const doc = await host.getRun(runId);
  return doc?.record.status;
}

describe("Paseo adapter through the durable host (Phase 6)", () => {
  it("refuses an off-catalog run with model_unavailable before any task exists", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort();
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({
      home,
      clock: new FakeClock(),
      executor: new FakeExecutor(),
      modelCatalog: catalog,
    });
    try {
      const ir = structuredPlaybook({ model: "haiku" });
      const error: unknown = await host
        .startRun({ ir, inputs: {}, cwd: "/tmp/argos-catalog" })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(isArgosError(error)).toBe(true);
      if (isArgosError(error)) {
        expect(error.code).toBe("model_unavailable");
        expect(error.message).toContain("claude/haiku");
      }
      expect((await host.inspect()).tasks).toHaveLength(0);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("runs a real step through the port and records the structured output", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort();
    port.completeOnCreate = () => ({
      output: { summary: "implemented", outcome: "success" },
    });
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-agent-step",
      });
      await drive(clock, async () => (await statusOf(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await host.getRun(runId);
      expect(doc?.record.steps["build"]?.status).toBe("completed");
      expect(doc?.record.steps["build"]?.outputs).toEqual({ summary: "implemented" });
      expect(doc?.record.steps["build"]?.outcome).toBe("success");
      expect(port.creates).toHaveLength(1);
      expect(port.creates[0]?.labels["argos/launch"]).toBe(`argos:${runId}:build:1`);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("adopts the agent across a crash between create and the agentId commit", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort();
    port.blockCreate();
    const clock = new FakeClock();
    const first = await ArgosHost.open({
      home,
      clock,
      executor: createAgentStepExecutor({ port, now: () => clock.now() }),
    });
    let runId = "";
    try {
      const started = await first.startRun({
        ir: structuredPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-crash",
      });
      runId = started.runId;
      const requestId = `argos:${runId}:build:1`;
      await drive(clock, () => port.agents.size === 1, { stepMs: 500, maxRounds: 10 });
      expect(port.createsFor(requestId)).toBe(1);
    } finally {
      await first.close();
    }

    // Reopen the same SQLite file with a fresh executor: it must find the labelled agent.
    port.releaseCreate();
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({
      home,
      clock: clock2,
      executor: createAgentStepExecutor({ port, now: () => clock2.now() }),
    });
    try {
      port.completeAll({ output: { summary: "adopted", outcome: "success" } });
      await drive(clock2, async () => (await statusOf(second, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await second.getRun(runId);
      expect(doc?.record.status).toBe("completed");
      expect(doc?.record.steps["build"]?.outputs).toEqual({ summary: "adopted" });
      // The whole point: one daemon-side agent, one create, adoption by label.
      expect(port.agents.size).toBe(1);
      expect(port.createsFor(`argos:${runId}:build:1`)).toBe(1);
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("fails launch_uncertain without a second create when labels are unsupported", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort({ supportsLabelFilter: false });
    port.blockCreate();
    const clock = new FakeClock();
    const first = await ArgosHost.open({
      home,
      clock,
      executor: createAgentStepExecutor({ port, now: () => clock.now() }),
    });
    let runId = "";
    try {
      const started = await first.startRun({
        ir: structuredPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-uncertain",
      });
      runId = started.runId;
      await drive(clock, () => port.agents.size === 1, { stepMs: 500, maxRounds: 10 });
      expect(port.createsFor(`argos:${runId}:build:1`)).toBe(1);
    } finally {
      await first.close();
    }

    port.releaseCreate();
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({
      home,
      clock: clock2,
      executor: createAgentStepExecutor({ port, now: () => clock2.now() }),
    });
    try {
      await drive(clock2, async () => (await statusOf(second, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await second.getRun(runId);
      expect(doc?.record.errorCode).toBe("launch_uncertain");
      expect(doc?.record.steps["build"]?.errorCode).toBe("launch_uncertain");
      // No blind relaunch in the crash window.
      expect(port.createsFor(`argos:${runId}:build:1`)).toBe(1);
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("performs one handover relaunch and then fails the step with agent_missing", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort();
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook({ pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-handover",
      });
      await drive(clock, () => port.agents.size === 1, { stepMs: 1_000, maxRounds: 10 });
      expect(port.creates).toHaveLength(1);

      // Agent 1 vanishes: one handover relaunch creates agent 2.
      port.missingAgents.add("paseo-agent-1");
      await drive(clock, () => port.creates.length === 2, { stepMs: 1_000, maxRounds: 10 });
      expect(port.archiveCalls).toEqual(["paseo-agent-1"]);
      expect(port.creates[1]?.labels["argos/handover"]).toBe("1");
      expect(port.creates[1]?.requestId).toBe(`argos:${runId}:build:1`);

      // Agent 2 vanishes too: the handover already happened, so the step fails.
      port.missingAgents.add("paseo-agent-2");
      await drive(clock, async () => (await statusOf(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await host.getRun(runId);
      expect(doc?.record.steps["build"]?.errorCode).toBe("agent_missing");
      expect(port.creates).toHaveLength(2);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("retries a waitForFinish timeout per `retries`, then fails the step with step_timeout", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort({ unsettled: true });
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook({ timeout: 5_000, retries: 1, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-timeout",
      });
      await drive(clock, async () => (await statusOf(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 30,
      });
      const doc = await host.getRun(runId);
      const stepRecord = doc?.record.steps["build"];
      expect(stepRecord?.status).toBe("failed");
      expect(stepRecord?.errorCode).toBe("step_timeout");
      // The run record records one dispatch per child task (Phase 4 deviation); the local retry
      // is visible as a second launched attempt with a fresh request id.
      expect(stepRecord?.attempts).toHaveLength(1);
      expect(port.creates.map((create) => create.requestId)).toEqual([
        `argos:${runId}:build:1`,
        `argos:${runId}:build:2`,
      ]);
      // The retry came from the waitForFinish timeout path, not from a refresh error.
      expect(port.waitCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("retries a schema-invalid result per `retries`, then fails with invalid_output", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort();
    port.completeOnCreate = () => ({ output: { summary: 42 } });
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook({ retries: 1, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-invalid-output",
      });
      await drive(clock, async () => (await statusOf(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await host.getRun(runId);
      expect(doc?.record.steps["build"]?.status).toBe("failed");
      expect(doc?.record.steps["build"]?.errorCode).toBe("invalid_output");
      expect(port.creates.map((create) => create.requestId)).toEqual([
        `argos:${runId}:build:1`,
        `argos:${runId}:build:2`,
      ]);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("moves to a fallback target on quota, recording exhausted and keeping one attempt", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort({ quotaTargets: ["claude/opus"] });
    port.completeOnCreate = () => ({ output: { summary: "fallback", outcome: "success" } });
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook({
          provider: "claude",
          model: "opus",
          fallbacks: [{ provider: "codex", model: "gpt" }],
        }),
        inputs: {},
        cwd: "/tmp/argos-quota",
      });
      await drive(clock, async () => (await statusOf(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await host.getRun(runId);
      // One dispatch attempt: the quota hop did not consume a retry.
      expect(doc?.record.steps["build"]?.attempts).toHaveLength(1);
      expect(doc?.record.steps["build"]?.outputs).toEqual({ summary: "fallback" });
      expect(doc?.record.exhausted).toEqual([{ target: "claude/opus", at: FAKE_EPOCH }]);
      expect(port.creates).toHaveLength(1);
      expect(port.creates[0]?.config.provider).toBe("codex/gpt");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("fails provider_exhausted when every target is quota-blocked, recording each with `at`", async () => {
    const { home, cleanup } = makeTempHome();
    const port = new FakePaseoPort({ quotaTargets: ["claude/opus", "codex/gpt"] });
    const clock = new FakeClock();
    const executor = createAgentStepExecutor({ port, now: () => clock.now() });
    const catalog = await ModelCatalog.load(port);
    const host = await ArgosHost.open({ home, clock, executor, modelCatalog: catalog });
    try {
      const { runId } = await host.startRun({
        ir: structuredPlaybook({
          provider: "claude",
          model: "opus",
          fallbacks: [{ provider: "codex", model: "gpt" }],
        }),
        inputs: {},
        cwd: "/tmp/argos-exhausted",
      });
      await drive(clock, async () => (await statusOf(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const doc = await host.getRun(runId);
      expect(doc?.record.steps["build"]?.errorCode).toBe("provider_exhausted");
      expect(doc?.record.exhausted.map((entry) => entry.target).sort()).toEqual([
        "claude/opus",
        "codex/gpt",
      ]);
      for (const entry of doc?.record.exhausted ?? []) {
        expect(Number.isFinite(entry.at)).toBe(true);
      }
      expect(port.creates).toHaveLength(0);
    } finally {
      await host.close();
      cleanup();
    }
  });
});
