import { describe, expect, it } from "vitest";

import type {
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
} from "../../src/durable/context.js";
import { isArgosError } from "../../src/errors.js";
import { ProviderExhaustedError, createAgentStepExecutor } from "../../src/paseo/agent-step.js";
import { buildStepOutputSchema } from "../../src/paseo/output.js";
import { FakePaseoPort } from "../fakes/paseo.js";
import { flushMicrotasks } from "../fakes/clock.js";

const NOW = 5_000;

function launchInput(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    requestId: "argos:run-1:build:1",
    label: "argos/run=run-1,argos/step=build,argos/attempt=1",
    runId: "run-1",
    stepId: "build",
    attempt: 1,
    cwd: "/tmp/argos-work",
    target: "claude/opus",
    targets: ["claude/opus"],
    agentConfig: { provider: "claude", model: "opus", modeId: "acceptEdits" },
    prompt: "Implement the change. Feedback so far: {{ feedback }}",
    feedback: "tighten the error handling",
    outcomes: ["success", "failure"],
    outputs: ["summary"],
    outputDefs: { summary: { type: "string", required: true } },
    ...overrides,
  };
}

function statusInput(overrides: Partial<AgentStatusInput> = {}): AgentStatusInput {
  const base = launchInput();
  return { ...base, agentId: "paseo-agent-1", ...overrides };
}

function expectCode(error: unknown, code: string): void {
  expect(isArgosError(error)).toBe(true);
  if (isArgosError(error)) expect(error.code).toBe(code);
}

describe("agent step executor (FR16/FR17/FR24)", () => {
  it("creates an agent with provider, cwd, rendered prompt, labels, and the compiled schema", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const input = launchInput({ targets: ["claude/opus", "codex/gpt"] });

    const launch = await executor.launch(input);
    expect(launch.agentId).toBe("paseo-agent-1");

    const create = port.creates[0];
    expect(create).toBeDefined();
    expect(create?.config.provider).toBe("claude/opus");
    expect(create?.config.modeId).toBe("acceptEdits");
    expect(create?.cwd).toBe("/tmp/argos-work");
    expect(create?.prompt).toContain("tighten the error handling");
    expect(create?.prompt).not.toContain("{{ feedback }}");
    expect(create?.labels).toEqual({
      "argos/launch": input.requestId,
      "argos/run": "run-1",
      "argos/step": "build",
      "argos/attempt": "1",
    });
    expect(create?.outputSchema).toEqual(
      buildStepOutputSchema({ outputs: input.outputDefs, outcomes: input.outcomes }).schema,
    );
  });

  it("adopts the agent found by the launch label and never creates twice (crash window)", async () => {
    const port = new FakePaseoPort();
    port.blockCreate();
    const requestId = "argos:run-1:build:1";

    // Lifetime 1: the daemon accepts the create and dies before the `agentId` commit.
    const first = createAgentStepExecutor({ port, now: () => NOW });
    const pending = first.launch(launchInput({ requestId, priorCreateAttempt: false }));
    await flushMicrotasks();
    expect(port.agents.size).toBe(1);
    expect(port.createsFor(requestId)).toBe(1);

    // Lifetime 2: re-enters `launch`, finds the labelled agent, adopts it.
    const second = createAgentStepExecutor({ port, now: () => NOW });
    const adopted = await second.launch(launchInput({ requestId, priorCreateAttempt: true }));
    expect(adopted.agentId).toBe("paseo-agent-1");
    expect(port.createsFor(requestId)).toBe(1);

    port.releaseCreate();
    await expect(pending).resolves.toMatchObject({ agentId: "paseo-agent-1" });
    expect(port.createsFor(requestId)).toBe(1);
  });

  it("fails launch_uncertain on an unsupported label filter after a create was attempted", async () => {
    const port = new FakePaseoPort({ supportsLabelFilter: false });
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const requestId = "argos:run-1:build:1";

    const error: unknown = await executor
      .launch(launchInput({ requestId, priorCreateAttempt: true }))
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expectCode(error, "launch_uncertain");
    expect(port.createsFor(requestId)).toBe(0);
    expect(port.listCalls).toHaveLength(0);
  });

  it("still creates on the first attempt when the daemon cannot filter by label", async () => {
    const port = new FakePaseoPort({ supportsLabelFilter: false });
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const launch = await executor.launch(launchInput({ priorCreateAttempt: false }));
    expect(launch.agentId).toBe("paseo-agent-1");
    expect(port.creates).toHaveLength(1);
  });

  it("performs exactly one handover relaunch, then fails agent_missing", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const launch = await executor.launch(launchInput());
    expect(launch.agentId).toBe("paseo-agent-1");

    // The agent is archived/unknown between two polls.
    port.missingAgents.add(launch.agentId);
    const handover = await executor.status(statusInput({ agentId: launch.agentId }));
    expect(handover).toMatchObject({
      state: "running",
      handover: true,
      agentId: "paseo-agent-2",
    });
    expect(port.archiveCalls).toEqual(["paseo-agent-1"]);
    expect(port.creates).toHaveLength(2);
    expect(port.creates[1]?.labels["argos/handover"]).toBe("1");
    expect(port.creates[1]?.prompt).toContain("archived mid-step");

    // A second occurrence fails the step instead of relaunching again.
    port.missingAgents.add("paseo-agent-2");
    const failed = await executor.status(
      statusInput({ agentId: "paseo-agent-2", handoverAttempted: true }),
    );
    expect(failed).toMatchObject({ state: "done", errorCode: "agent_missing" });
    expect(port.creates).toHaveLength(2);
  });

  it("moves to the next fallback target on a quota error without creating twice for retries", async () => {
    const port = new FakePaseoPort({ quotaTargets: ["claude/opus"] });
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const input = launchInput({ targets: ["claude/opus", "codex/gpt"] });

    const launch = await executor.launch(input);
    expect(launch.target).toBe("codex/gpt");
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]?.config.provider).toBe("codex/gpt");
    expect(port.createCalls).toEqual([input.requestId, input.requestId]);
    expect(launch.exhausted).toEqual([{ target: "claude/opus", at: NOW }]);
  });

  it("fails provider_exhausted with the ledger when every target is quota-blocked", async () => {
    const port = new FakePaseoPort({ quotaTargets: ["claude/opus", "codex/gpt"] });
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const input = launchInput({ targets: ["claude/opus", "codex/gpt"] });

    const error: unknown = await executor.launch(input).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProviderExhaustedError);
    expectCode(error, "provider_exhausted");
    if (error instanceof ProviderExhaustedError) {
      expect(error.exhausted).toEqual([
        { target: "claude/opus", at: NOW },
        { target: "codex/gpt", at: NOW },
      ]);
    }
    expect(port.creates).toHaveLength(0);
  });

  it("skips targets that are still inside their persisted exhaustion window", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW, quotaWindowMs: 60_000 });
    const input = launchInput({
      targets: ["claude/opus", "codex/gpt"],
      exhausted: [{ target: "claude/opus", at: NOW - 30_000 }],
    });
    const launch = await executor.launch(input);
    expect(launch.target).toBe("codex/gpt");
    expect(port.creates).toHaveLength(1);
    expect(launch.exhausted).toEqual([{ target: "claude/opus", at: NOW - 30_000 }]);
  });

  it("parks on waitForFinish timeout instead of failing the attempt", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const launch = await executor.launch(launchInput());
    // The agent is idle but its turn never settles: refresh says idle, waitForFinish times out.
    port.complete(launch.agentId, {});
    port.timeoutAgents.add(launch.agentId);

    const status = await executor.status(statusInput({ agentId: launch.agentId }));
    expect(status).toEqual({ state: "running" });
    expect(port.waitCalls).toEqual([{ agentId: launch.agentId, timeoutMs: 0 }]);
  });

  it("returns invalid_output for a schema-invalid result and re-validates in collect", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const launch = await executor.launch(launchInput());
    port.complete(launch.agentId, { output: { summary: 42 } });

    const status = await executor.status(statusInput({ agentId: launch.agentId }));
    expect(status).toMatchObject({ state: "done", errorCode: "invalid_output" });

    const collected = await executor.collect?.({
      ...statusInput({ agentId: launch.agentId }),
      status,
    });
    expect(collected).toMatchObject({ errorCode: "invalid_output" });
  });

  it("parses the fenced-JSON fallback when the step declares outputs", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const launch = await executor.launch(launchInput());
    port.complete(launch.agentId, {
      text: 'Done.\n```json\n{"summary":"all good","outcome":"success"}\n```',
    });

    const status = await executor.status(statusInput({ agentId: launch.agentId }));
    expect(status).toMatchObject({
      state: "done",
      outcome: "success",
      outputs: { summary: "all good" },
    });
  });

  it("does not parse prose when the step declares no outputs", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const { feedback: _feedback, ...base } = launchInput();
    const input: LaunchInput = {
      ...base,
      outcomes: [],
      outputs: [],
      outputDefs: {},
      prompt: "Say hello.",
    };
    const launch = await executor.launch(input);
    port.complete(launch.agentId, { text: "hello" });

    const status = await executor.status({ ...input, agentId: launch.agentId });
    expect(status).toMatchObject({ state: "done", outputs: {} });
    if (status.state === "done") expect(status.outcome).toBeUndefined();
  });

  it("collect validates the raw checkpoint result after a restart that never relaunched", async () => {
    const port = new FakePaseoPort();
    const executor = createAgentStepExecutor({ port, now: () => NOW });
    const status: StepAgentStatus = {
      state: "done",
      raw: { text: '```json\n{"summary":"recovered","outcome":"success"}\n```' },
    };
    const collected = await executor.collect?.({
      ...statusInput({ agentId: "paseo-agent-1" }),
      status,
    });
    expect(collected).toEqual({
      outcome: "success",
      outputs: { summary: "recovered" },
    });
  });
});
