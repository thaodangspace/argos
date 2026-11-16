/**
 * The `hc` `StepExecutor` (FR19–FR26, plan Phase 6 verification 1–8).
 *
 * Mirrors `test/paseo/agent-step.test.ts`, with the two differences hc brings: a step is a
 * **terminal** (so adoption is name- and label-based, the prompt may need a second delivery, and
 * settle cleanup removes the terminal), and the substrate reports its own status word and exit code
 * instead of a structured result. Every test counts on the fake's ledgers (`runs`, `sends`,
 * `removes`, `kills`) instead of sleeping, and no test opens a socket.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";

import type {
  AgentStatusInput,
  CollectInput,
  LaunchInput,
  StepAgentStatus,
} from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { isArgosError } from "../../src/errors.js";
import { createHcStepExecutor, hcTerminalName, stripAnsi } from "../../src/hc/agent-step.js";
import { HcCatalog } from "../../src/hc/catalog.js";
import type { HcPort } from "../../src/hc/port.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { FakeHcPort } from "../fakes/hc.js";
import { drive } from "../durable/support.js";

const HOME = "/tmp/argos-home";

/** The executor plus the catalog it needs, both over one fake port. */
async function subject(
  port: HcPort,
  options: { readonly handoverNote?: string; readonly home?: string } = {},
) {
  const catalog = await HcCatalog.load(port);
  return {
    catalog,
    executor: createHcStepExecutor({
      port,
      catalog,
      home: options.home ?? HOME,
      ...(options.handoverNote === undefined ? {} : { handoverNote: options.handoverNote }),
    }),
  };
}

function launchInput(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    requestId: "argos:run-1:build:1",
    label: "argos/run=run-1,argos/step=build,argos/attempt=1",
    runId: "run-1",
    stepId: "build",
    attempt: 1,
    cwd: "/tmp/argos-hc-work",
    target: "hc/claude",
    targets: ["hc/claude"],
    prompt: "Implement the change.",
    outcomes: ["success", "failure"],
    outputs: ["summary"],
    outputDefs: { summary: { type: "string", required: true } },
    ...overrides,
  };
}

/** The same step with nothing declared: a plain "run this and succeed" step. */
function plainInput(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return launchInput({ outcomes: ["success", "failure"], outputs: [], outputDefs: {}, ...overrides });
}

function statusInput(agentId: string, overrides: Partial<LaunchInput> = {}): AgentStatusInput {
  return { ...launchInput(overrides), agentId };
}

function collectInput(
  agentId: string,
  status: StepAgentStatus,
  overrides: Partial<LaunchInput> = {},
): CollectInput {
  return { ...launchInput(overrides), agentId, status };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

function expectCode(error: unknown, code: string): void {
  expect(isArgosError(error)).toBe(true);
  if (isArgosError(error)) expect(error.code).toBe(code);
}

describe("hc launch (FR19)", () => {
  it("runs one terminal with the cwd, deterministic name, and the five labels", async () => {
    const port = new FakeHcPort({ templates: ["claude", "codex"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const name = hcTerminalName(input.requestId);

    const launched = await executor.launch(input);
    expect(launched).toEqual({ agentId: name, target: "hc/claude" });
    expect(name).toMatch(/^argos-[0-9a-f]{16}$/);

    expect(port.runs).toHaveLength(1);
    const run = port.runs[0];
    expect(run).toBeDefined();
    expect(run?.name).toBe(name);
    expect(run?.cwd).toBe("/tmp/argos-hc-work");
    expect(run?.argv[0]).toBe("claude");
    expect(run?.argv[1]).toContain("Implement the change.");
    expect(run?.labels).toEqual({
      "argos/launch": input.requestId,
      "argos/run": "run-1",
      "argos/step": "build",
      "argos/attempt": "1",
      "argos/home": HOME,
    });
    // FR26: never `rm` at launch — the crash window needs the record to adopt.
    expect(run?.rm).toBeUndefined();
    expect(run?.wait).toBeUndefined();
  });

  it("adopts the labelled terminal on a second launch and never creates twice", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();

    const first = await executor.launch(input);
    // A second lifetime re-enters `launch` after the crash window (the `agentId` commit was lost).
    const second = await executor.launch({ ...input, priorCreateAttempt: true });

    expect(second.agentId).toBe(first.agentId);
    expect(port.runs).toHaveLength(1);
    expect(port.runsFor(hcTerminalName(input.requestId))).toBe(1);
    // Adoption goes through the label filter, not through a rejected create.
    expect(port.lists).toEqual([
      { all: true, labels: { "argos/launch": input.requestId } },
      { all: true, labels: { "argos/launch": input.requestId } },
    ]);
  });

  it("adopts a name_taken terminal instead of creating a second one", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const name = hcTerminalName(input.requestId);
    // A terminal with this name exists but carries no launch label (another `$ARGOS_HOME`, or a
    // create whose labels never landed): `terminal.run` answers `name_taken`.
    port.seedTerminal({ name, template: "claude", status: "working" });

    const launched = await executor.launch(input);
    expect(launched.agentId).toBe(name);
    expect(port.runs).toHaveLength(0);
    expect(port.runsFor(name)).toBe(1);
  });

  it("fails launch_uncertain when a taken name cannot be adopted", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    // The name is taken but no terminal answers to it any more: never a blind relaunch.
    port.failNext("terminal.run", "name_taken");

    expectCode(await rejected(executor.launch(input)), "launch_uncertain");
    expect(port.runs).toHaveLength(0);
    expect(port.runsFor(hcTerminalName(input.requestId))).toBe(1);
  });

  it("gives a handover relaunch its own name and the handover note (FR24)", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const original = port.terminalFor(launched.agentId);
    expect(original).toBeDefined();
    port.forget(launched.agentId);

    const handover = await executor.status(statusInput(launched.agentId));
    expect(handover).toMatchObject({ state: "running", handover: true });
    if (handover.state !== "running") throw new Error("expected a running handover");
    const replacement = handover.agentId;
    if (replacement === undefined) throw new Error("expected the relaunched terminal");
    expect(replacement).not.toBe(launched.agentId);
    expect(handover.detail).toContain("relaunched once");

    const created = port.runs[1];
    expect(created?.name).toBe(hcTerminalName(input.requestId, true));
    expect(created?.name).not.toBe(launched.agentId);
    expect(created?.labels?.["argos/handover"]).toBe("1");
    expect(created?.labels?.["argos/launch"]).toBe(input.requestId);
    expect(created?.argv[1]).toContain("previous terminal was lost");

    // A second loss fails the step: exactly one handover, then `agent_missing`.
    port.forget(replacement);
    const failed = await executor.status({
      ...statusInput(replacement),
      ...input,
      handoverAttempted: true,
    });
    expect(failed).toMatchObject({ state: "done", errorCode: "agent_missing" });
    expect(port.runs).toHaveLength(2);
  });

  it("fails model_unavailable for a target the core does not offer, before any terminal", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);

    expectCode(
      await rejected(executor.launch(launchInput({ target: "hc/missing", targets: ["hc/missing"] }))),
      "model_unavailable",
    );
    // A Paseo target on the hc executor is refused too: hc runs templates.
    expectCode(
      await rejected(executor.launch(launchInput({ target: "claude/opus", targets: ["claude/opus"] }))),
      "model_unavailable",
    );
    expect(port.runCalls).toEqual([]);
  });

  it("keeps the alias provider spelling and falls back to the next offered template", async () => {
    const port = new FakeHcPort({ templates: ["codex"] });
    const { executor } = await subject(port);

    const launched = await executor.launch(
      launchInput({
        target: "herdr-core/missing",
        targets: ["herdr-core/missing", "hc/codex"],
      }),
    );
    expect(launched.target).toBe("hc/codex");
    expect(port.runs[0]?.argv[0]).toBe("codex");
  });
});

describe("hc prompt delivery (FR20)", () => {
  it("delivers once when the template's first message did not go in", async () => {
    const port = new FakeHcPort({ templates: ["claude"], initialStatus: "idle", firstMessageSent: false });
    const { executor } = await subject(port);
    const input = launchInput();

    const launched = await executor.launch(input);
    expect(port.sends).toHaveLength(1);
    expect(port.sends[0]?.if).toBe("idle");
    expect(port.sends[0]?.text).toContain("Implement the change.");
    expect(port.sends[0]?.text).toContain("```json");

    for (let poll = 0; poll < 5; poll += 1) {
      await executor.status(statusInput(launched.agentId));
    }
    // hc now records the message as sent, so five polls send nothing more.
    expect(port.sends).toHaveLength(1);
  });

  it("sends at turn === 0 and stays silent while a turn already ran", async () => {
    const port = new FakeHcPort({ templates: ["claude"], initialStatus: "idle", firstMessageSent: false });
    const { executor } = await subject(port);
    const name = hcTerminalName("argos:run-2:build:1");

    // A program that already ran a turn: hc's own "something was submitted" fact forbids a send.
    port.seedTerminal({
      name: `${name}-busy`,
      template: "claude",
      status: "working",
      turn: 1,
      firstMessageSent: false,
    });
    for (let poll = 0; poll < 5; poll += 1) {
      await executor.status(statusInput(`${name}-busy`));
    }
    expect(port.sends).toEqual([]);

    // A fresh terminal with nothing submitted: exactly one send, then silence.
    port.seedTerminal({ name, template: "claude", status: "idle", turn: 0, firstMessageSent: false });
    for (let poll = 0; poll < 5; poll += 1) {
      await executor.status(statusInput(name));
    }
    expect(port.sends).toHaveLength(1);
    expect(port.sends[0]?.terminal).toBe("t2");
  });

  it("does not append a prompt when the step declares nothing and has no prompt", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const { prompt: _prompt, ...withoutPrompt } = plainInput();
    const launched = await executor.launch(withoutPrompt);

    expect(port.runs[0]?.argv).toEqual(["claude"]);
    expect(port.sends).toEqual([]);
    expect(launched.target).toBe("hc/claude");
  });

  it("appends the fenced-json instruction when outputs are declared, and nothing else", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);

    await executor.launch(launchInput());
    const led = port.runs[0]?.argv[1] ?? "";
    expect(led).toContain("```json");
    expect(led).toContain('"summary"');
    expect(led).toContain('"outcome"');
    expect(led).toContain('"success"');
    expect(led).not.toContain("previous terminal was lost");

    await executor.launch(plainInput({ requestId: "argos:run-1:build:2" }));
    expect(port.runs[1]?.argv[1]).toBe("Implement the change.");
  });
});

describe("hc status (FR21/FR22)", () => {
  it("reports running while working and done once hc says so", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);

    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({ state: "running" });

    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.reportStatus(address, { state: "blocked", msg: "approve this?", kind: "permission" });
    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({
      state: "running",
      detail: "blocked: approve this?",
    });

    port.reportStatus(address, { state: "done" });
    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({ state: "done" });
  });

  it("settles success from a finished terminal with exit code 0", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.finishTerminal(address, { exitCode: 0 });

    const status = await executor.status(statusInput(launched.agentId, input));
    expect(status).toEqual({ state: "done" });
    const collected = await executor.collect?.(collectInput(launched.agentId, status, input));
    expect(collected).toMatchObject({ outcome: "success", detail: "exit code 0" });
    expect(collected?.errorCode).toBeUndefined();
    expect(collected?.outputs).toBeUndefined();
  });

  it("fails step_failed with the exit code as detail", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.finishTerminal(address, { exitCode: 3 });

    const status = await executor.status(statusInput(launched.agentId, input));
    expect(status).toEqual({ state: "done" });
    expect(await executor.collect?.(collectInput(launched.agentId, status, input))).toMatchObject({
      errorCode: "step_failed",
      detail: "exit code 3",
    });
  });

  it("fails step_failed for a signalled program", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.finishTerminal(address, { exitCode: null, signal: 9, reason: "signaled" });

    const status = await executor.status(statusInput(launched.agentId, input));
    expect(await executor.collect?.(collectInput(launched.agentId, status, input))).toMatchObject({
      errorCode: "step_failed",
      detail: "signal 9",
    });
  });

  it("fails a handover relaunch that loses its terminal twice with agent_missing", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    port.forget(launched.agentId);

    const handover = await executor.status(statusInput(launched.agentId, input));
    if (handover.state !== "running" || handover.agentId === undefined) {
      throw new Error("expected a handover relaunch");
    }
    port.forget(handover.agentId);
    const second = await executor.status({
      ...statusInput(handover.agentId, input),
      handoverAttempted: true,
    });
    expect(second).toMatchObject({ state: "done", errorCode: "agent_missing" });
    if (second.state === "done") expect(second.feedback).toContain("one handover relaunch");
  });
});

describe("hc result decision on the terminal poll (FR23)", () => {
  it("parses a fenced json block into the declared outputs, reading the terminal once", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";

    // Nothing is read while the program is still working.
    for (let poll = 0; poll < 3; poll += 1) {
      expect(await executor.status(statusInput(launched.agentId, input))).toEqual({ state: "running" });
    }
    expect(port.reads).toEqual([]);

    port.appendText(address, 'Done.\n```json\n{"summary":"all good","outcome":"success"}\n```\n');
    port.finishTerminal(address, { exitCode: 0 });
    const status = await executor.status(statusInput(launched.agentId, input));
    expect(status).toEqual({
      state: "done",
      outputs: { summary: "all good" },
      outcome: "success",
    });
    // Exactly one read, on the terminal poll; the prose never travels in the status.
    expect(port.reads).toEqual([address]);
    expect(JSON.stringify(status)).not.toContain("Done.");

    // `collect` is cleanup plus the ending: it never re-reads and never re-parses.
    expect(await executor.collect?.(collectInput(launched.agentId, status, input))).toEqual({
      detail: "exit code 0",
    });
    expect(port.reads).toEqual([address]);
    expect(port.removes).toEqual([address]);
  });

  it("strips ansi and OSC sequences before parsing", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.appendText(
      address,
      '\u001b]7501;working\u0007\u001b[1m```json\n{"summary":"clean","outcome":"success"}\n```\u001b[0m',
    );
    port.finishTerminal(address, { exitCode: 0 });

    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(await executor.status(statusInput(launched.agentId, input))).toMatchObject({
      state: "done",
      outputs: { summary: "clean" },
    });
  });

  it("reports invalid_output from the poll so `argos.step` retries it", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.appendText(address, "I finished, no json here.");
    port.finishTerminal(address, { exitCode: 0 });

    const status = await executor.status(statusInput(launched.agentId, input));
    expect(status).toMatchObject({ state: "done", errorCode: "invalid_output" });
    if (status.state !== "done") throw new Error("expected a done status");
    expect(status.feedback).toContain("json block");
    expect(status.outputs).toBeUndefined();
    // The screen never reaches the checkpoint: no text, and no `raw` to carry it.
    expect(JSON.stringify(status)).not.toContain("no json here");
    expect(status.raw).toBeUndefined();
    expect(port.reads).toHaveLength(1);
  });

  it("fails a bad process ending without reading or retrying, even with outputs declared", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    // A valid block is present, but the program exited non-zero: the process failed, not the schema.
    port.appendText(address, '```json\n{"summary":"all good","outcome":"success"}\n```');
    port.finishTerminal(address, { exitCode: 3 });

    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({
      state: "done",
      errorCode: "step_failed",
      detail: "exit code 3",
    });
    expect(port.reads).toEqual([]);
  });

  it("fails a finished terminal whose screen cannot be read instead of parking", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.finishTerminal(address, { exitCode: 0 });
    port.failNext("terminal.read", "unavailable");

    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({
      state: "done",
      errorCode: "step_failed",
      detail: "could not read the terminal result",
    });
  });

  it("keeps a blocked program running with its own message and reads nothing", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = launchInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.reportStatus(address, { state: "blocked", msg: "waiting for a human" });

    expect(await executor.status(statusInput(launched.agentId, input))).toEqual({
      state: "running",
      detail: "blocked: waiting for a human",
    });
    expect(port.reads).toEqual([]);
  });

  it("keeps a task-decided failure code and adds how the program ended", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.reportStatus(address, { state: "blocked", msg: "waiting for a human" });

    // The step deadline decided this attempt failed; `collect` must not turn it into a success.
    const collected = await executor.collect?.(
      collectInput(launched.agentId, { state: "done", errorCode: "step_timeout" }, input),
    );
    expect(collected?.errorCode).toBeUndefined();
    expect(port.removes).toEqual([address]);
  });
});

describe("hc settle cleanup (FR26)", () => {
  it("removes a finished terminal exactly once, and only at settle", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    // Nothing is removed while the attempt is in flight.
    await executor.status(statusInput(launched.agentId, input));
    expect(port.removes).toEqual([]);

    port.finishTerminal(address, { exitCode: 0 });
    const status = await executor.status(statusInput(launched.agentId, input));
    await executor.collect?.(collectInput(launched.agentId, status, input));

    expect(port.removes).toEqual([address]);
    expect(port.kills).toEqual([]);
    expect(port.terminalFor(address)).toBeUndefined();
  });

  it("kills a still-live terminal before removing it (terminal.rm refuses `live`)", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    // The program says it is done but keeps running: hc still reports the terminal `live`.
    port.reportStatus(address, { state: "done" });

    const status = await executor.status(statusInput(launched.agentId, input));
    expect(status).toEqual({ state: "done" });
    const collected = await executor.collect?.(collectInput(launched.agentId, status, input));

    expect(collected?.errorCode).toBeUndefined();
    expect(port.kills).toEqual([address]);
    expect(port.removes).toEqual([address]);
    expect(port.terminalFor(address)).toBeUndefined();
  });

  it("never fails the step because cleanup failed", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const input = plainInput();
    const launched = await executor.launch(input);
    const address = port.terminalFor(launched.agentId)?.address ?? "";
    port.finishTerminal(address, { exitCode: 0 });
    port.failNext("terminal.rm", "not_found");

    const status = await executor.status(statusInput(launched.agentId, input));
    const collected = await executor.collect?.(collectInput(launched.agentId, status, input));
    expect(collected).toMatchObject({ outcome: "success" });
    expect(collected?.errorCode).toBeUndefined();
  });
});

describe("hc unreachable (FR7/FR17)", () => {
  it("fails executor_unreachable at launch time", async () => {
    const port = new FakeHcPort({ templates: ["claude"], unreachable: true });
    // The catalog is loaded before the core goes away (`argos serve` does the same at startup).
    const catalog = HcCatalog.fromTemplates([
      { name: "claude", description: "", command: "claude", error: null },
    ]);
    const executor = createHcStepExecutor({ port, catalog, home: HOME });
    expectCode(await rejected(executor.launch(launchInput())), "executor_unreachable");
    expect(port.runs).toHaveLength(0);
  });

  it("reports executor_unreachable at poll time so the step can park", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { executor } = await subject(port);
    const launched = await executor.launch(plainInput());
    port.unreachable = true;

    expectCode(
      await rejected(executor.status(statusInput(launched.agentId, plainInput()))),
      "executor_unreachable",
    );
  });
});

// ------------------------------------------------------------------ through the durable host

/** A one-step hc playbook that declares one output and one routable outcome. */
function hcPlaybook(
  options: { readonly timeout?: number; readonly pollMs?: number; readonly retries?: number } = {},
) {
  return playbook({
    id: "hc-phase6",
    steps: [
      step({
        id: "build",
        agent: { provider: "hc", model: "claude", labels: {} },
        prompt: "Build the change.",
        outputs: { summary: { type: "string", required: true } },
        outcomes: ["success"],
        on: { success: { kind: "complete" } },
        pollMs: options.pollMs ?? 1_000,
        timeout: options.timeout ?? 30_000,
        ...(options.retries === undefined ? {} : { retries: options.retries }),
      }),
    ],
  });
}

async function openHost(port: FakeHcPort) {
  const catalog = await HcCatalog.load(port);
  const clock = new FakeClock();
  const executor = createHcStepExecutor({ port, catalog, home: HOME });
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    clock,
    // The `paseo` entry is required by the host and never used by an `hc` run.
    executor: new FakeExecutor(),
    executors: { hc: executor },
    catalogs: { hc: catalog },
  });
  return { host, clock, catalog, executor };
}

describe("hc through the durable host (Phase 6)", () => {
  it("runs a step on hc end to end and records its structured output", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { host, clock } = await openHost(port);
    try {
      const { runId } = await host.startRun({
        ir: hcPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-hc-run",
        executor: "hc",
        id: "run-hc-e2e",
      });
      await drive(clock, () => port.runs.length === 1, { stepMs: 250, maxRounds: 10 });

      const run = port.runs[0];
      expect(run).toBeDefined();
      if (run === undefined) return;
      expect(run.labels?.["argos/launch"]).toBe(`argos:${runId}:build:1`);

      port.appendText(run.address, '```json\n{"summary":"shipped","outcome":"success"}\n```');
      port.finishTerminal(run.address, { exitCode: 0 });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 1_000, maxRounds: 30 },
      );

      const doc = await host.getRun(runId);
      expect(doc?.record.status).toBe("completed");
      expect(doc?.record.executor).toBe("hc");
      expect(doc?.record.steps["build"]?.status).toBe("completed");
      expect(doc?.record.steps["build"]?.outputs).toEqual({ summary: "shipped" });
      expect(doc?.record.steps["build"]?.outcome).toBe("success");
      // The attempt names the terminal it ran (the target column is the catalog's `hc/<template>`).
      expect(doc?.record.steps["build"]?.attempts[0]?.agentId).toBe(hcTerminalName(`argos:${runId}:build:1`));
      expect(port.runs[0]?.labels?.["argos/home"]).toBe(HOME);
      // One terminal for the attempt, removed once when the step settled.
      expect(port.runs).toHaveLength(1);
      expect(port.removes).toEqual([run.address]);
    } finally {
      await host.close();
    }
  });

  it("retries an invalid hc result per `retries` and then fails invalid_output", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { host, clock } = await openHost(port);
    try {
      const { runId } = await host.startRun({
        ir: hcPlaybook({ retries: 1, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-hc-invalid",
        executor: "hc",
        id: "run-hc-invalid",
      });
      await drive(clock, () => port.runs.length === 1, { stepMs: 250, maxRounds: 10 });
      const first = port.runs[0];
      if (first === undefined) throw new Error("expected the first terminal");

      // Attempt 1 finishes with prose instead of the declared json block.
      port.appendText(first.address, "I finished, no json here.");
      port.finishTerminal(first.address, { exitCode: 0 });

      // A schema-invalid result retries like a timeout: a second attempt, a new request id, a new
      // deterministic terminal name.
      await drive(clock, () => port.runs.length === 2, { stepMs: 1_000, maxRounds: 30 });
      const second = port.runs[1];
      if (second === undefined) throw new Error("expected the retried terminal");
      expect(second.name).not.toBe(first.name);
      expect(second.labels?.["argos/launch"]).toBe(`argos:${runId}:build:2`);
      expect(first.labels?.["argos/launch"]).toBe(`argos:${runId}:build:1`);

      // Attempt 2 is invalid too: no retries left, so the step fails with the stable code.
      port.appendText(second.address, "still no json");
      port.finishTerminal(second.address, { exitCode: 0 });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "failed",
        { stepMs: 1_000, maxRounds: 30 },
      );

      const doc = await host.getRun(runId);
      expect(doc?.record.status).toBe("failed");
      expect(doc?.record.steps["build"]?.errorCode).toBe("invalid_output");
      // Exactly one terminal per attempt, and nothing adopted a stale one.
      expect(port.runs).toHaveLength(2);
      expect(new Set(port.runs.map((run) => run.name)).size).toBe(2);
    } finally {
      await host.close();
    }
  });

  it("parks on an unreachable core at poll time and fails step_timeout at the deadline", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { host, clock } = await openHost(port);
    try {
      const { runId } = await host.startRun({
        ir: hcPlaybook({ timeout: 1_000, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-hc-unreachable",
        executor: "hc",
        id: "run-hc-unreachable",
      });
      await drive(clock, () => port.runs.length === 1, { stepMs: 250, maxRounds: 10 });

      // The core goes away mid-step: every poll now throws `executor_unreachable`.
      port.unreachable = true;
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "failed",
        { stepMs: 1_000, maxRounds: 30 },
      );

      const doc = await host.getRun(runId);
      // Not `executor_unreachable`: poll-time unreachability parks, and the deadline decides.
      expect(doc?.record.status).toBe("failed");
      expect(doc?.record.steps["build"]?.errorCode).toBe("step_timeout");
    } finally {
      await host.close();
    }
  });

  it("keeps hc's blocked detail in the checkpoint and the exit code on the receipt", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const { host, clock } = await openHost(port);
    try {
      const { runId } = await host.startRun({
        ir: hcPlaybook({ timeout: 60_000, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-hc-detail",
        executor: "hc",
        id: "run-hc-detail",
      });
      await drive(clock, () => port.runs.length === 1, { stepMs: 250, maxRounds: 10 });
      const run = port.runs[0];
      if (run === undefined) throw new Error("expected one terminal");

      // FR22: a blocked program keeps running, and its own message lands in the checkpoint.
      port.reportStatus(run.address, { state: "blocked", msg: "waiting for a human" });
      await clock.advance(1_000);
      const blockedTask = (await host.inspect()).tasks.find(
        (candidate) => candidate.record.kind === "argos.step",
      );
      const checkpoint = (
        blockedTask?.record.state as { checkpoint?: { detail?: string } } | undefined
      )?.checkpoint;
      expect(checkpoint?.detail).toBe("blocked: waiting for a human");
      const stepTaskId = blockedTask === undefined ? undefined : String(blockedTask.record.id);
      expect(stepTaskId).toBeDefined();

      // FR23: a non-zero exit fails the step, and the exit code survives on the task receipt.
      port.finishTerminal(run.address, { exitCode: 2 });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "failed",
        { stepMs: 1_000, maxRounds: 30 },
      );
      expect((await host.getRun(runId))?.record.steps["build"]?.errorCode).toBe("step_failed");

      const task = stepTaskId === undefined ? undefined : await host.getTaskRecord(stepTaskId);
      const outcome = (
        task?.state as
          | { outcome?: { result?: { errorCode?: string; detail?: string } } }
          | undefined
      )?.outcome;
      expect(outcome?.result?.errorCode).toBe("step_failed");
      expect(outcome?.result?.detail).toBe("exit code 2");
    } finally {
      await host.close();
    }
  });
});
