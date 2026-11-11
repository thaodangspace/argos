/**
 * In-memory `StepExecutor` for the durable tests.
 *
 * The map is keyed by `requestId` and lives for the whole test (it outlives a harness
 * close/reopen in the same process), which is exactly the point: a relaunched step must **adopt**
 * the existing agent instead of creating a second one. Every call is recorded so tests can assert
 * one creation per step across two harness lifetimes.
 *
 * Completion is manual (`complete(requestId)`) or poll-count based (`completeAfterPolls`); nothing
 * here uses a real timer, so the whole suite is deterministic. Launches can be blocked to
 * reproduce the crash window between the launch intent commit and the `agentId` commit.
 */

import type { ArgosErrorCode } from "../../src/errors.js";
import type { Scalar } from "../../src/playbook/ir.js";
import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../../src/durable/context.js";

export interface FakeAgentResult {
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, Scalar>>;
  readonly errorCode?: ArgosErrorCode;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface FakeAgent {
  readonly requestId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly label: string;
  readonly cwd: string;
  readonly target?: string;
  status: "running" | "done";
  result: FakeAgentResult;
  polls: number;
}

export interface FakeExecutorOptions {
  /** Complete automatically after this many status polls; undefined = manual only. */
  readonly completeAfterPolls?: number;
  /** Outcome reported on completion; default `"success"` (the engine test helper's default). */
  readonly defaultOutcome?: string;
}

interface LaunchGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): LaunchGate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export class FakeExecutor implements StepExecutor {
  readonly agents = new Map<string, FakeAgent>();
  /** Every `launch()` invocation, in order. A second entry for one id means "adopted". */
  readonly launchCalls: string[] = [];
  /** Request ids that actually created an agent (exactly once per step). */
  readonly creations: string[] = [];
  readonly #gates = new Map<string, LaunchGate>();
  readonly #options: FakeExecutorOptions;
  #nextAgent = 1;

  constructor(options: FakeExecutorOptions = {}) {
    this.#options = options;
  }

  async launch(input: LaunchInput): Promise<AgentLaunch> {
    this.launchCalls.push(input.requestId);
    let agent = this.agents.get(input.requestId);
    if (agent === undefined) {
      const created: FakeAgent = {
        requestId: input.requestId,
        agentId: `agent-${this.#nextAgent}`,
        runId: input.runId,
        stepId: input.stepId,
        attempt: input.attempt,
        label: input.label,
        cwd: input.cwd,
        ...(input.target === undefined ? {} : { target: input.target }),
        status: "running",
        result: {},
        polls: 0,
      };
      this.#nextAgent += 1;
      this.agents.set(input.requestId, created);
      this.creations.push(input.requestId);
      agent = created;
    }
    const blocked = this.#gates.get(input.requestId);
    if (blocked !== undefined) await blocked.promise;
    return {
      agentId: agent.agentId,
      ...(agent.target === undefined ? {} : { target: agent.target }),
    };
  }

  async status(input: AgentStatusInput): Promise<StepAgentStatus> {
    const agent = this.agents.get(input.requestId);
    if (agent === undefined) return { state: "running" };
    agent.polls += 1;
    if (agent.status === "running" && this.#options.completeAfterPolls !== undefined) {
      if (agent.polls >= this.#options.completeAfterPolls) {
        agent.status = "done";
        agent.result = { outcome: this.#options.defaultOutcome ?? "success" };
      }
    }
    if (agent.status === "running") return { state: "running" };
    return {
      state: "done",
      ...(agent.result.outcome === undefined ? {} : { outcome: agent.result.outcome }),
      ...(agent.result.outputs === undefined ? {} : { outputs: agent.result.outputs }),
      ...(agent.result.errorCode === undefined ? {} : { errorCode: agent.result.errorCode }),
      ...(agent.result.usage === undefined ? {} : { usage: agent.result.usage }),
    };
  }

  /** Mark one attempt done with an optional result. */
  complete(requestId: string, result: FakeAgentResult = {}): void {
    const agent = this.agents.get(requestId);
    if (agent === undefined) throw new Error(`FakeExecutor: unknown requestId ${requestId}`);
    agent.status = "done";
    agent.result = {
      outcome: this.#options.defaultOutcome ?? "success",
      ...result,
    };
  }

  /** Complete every attempt still running. */
  completeAll(result: FakeAgentResult = {}): void {
    for (const agent of this.agents.values()) {
      if (agent.status === "running") this.complete(agent.requestId, result);
    }
  }

  /** Hold `launch` for this request id (the process "crashes" while launch is in flight). */
  blockLaunch(requestId: string): void {
    if (!this.#gates.has(requestId)) this.#gates.set(requestId, gate());
  }

  /** Release a blocked launch (a later launch for the same id then adopts and returns). */
  releaseLaunch(requestId: string): void {
    this.#gates.get(requestId)?.release();
    this.#gates.delete(requestId);
  }

  /** Request ids of one step, in call order. */
  callsForStep(stepId: string): string[] {
    return [...this.agents.values()]
      .filter((agent) => agent.stepId === stepId)
      .map((agent) => agent.requestId);
  }

  /** Agent creations per step id. */
  creationsByStep(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const agent of this.agents.values()) {
      counts[agent.stepId] = (counts[agent.stepId] ?? 0) + 1;
    }
    return counts;
  }

  /** Attempts that exist, per step id. */
  attemptsByStep(): Record<string, number[]> {
    const attempts: Record<string, number[]> = {};
    for (const agent of this.agents.values()) {
      const list = attempts[agent.stepId] ?? [];
      list.push(agent.attempt);
      attempts[agent.stepId] = list.sort((left, right) => left - right);
    }
    return attempts;
  }

  /** The single agent of a step; throws when a step created zero or several. */
  agentForStep(stepId: string): FakeAgent {
    const agents = [...this.agents.values()].filter((agent) => agent.stepId === stepId);
    if (agents.length !== 1) {
      throw new Error(`FakeExecutor: step ${stepId} has ${agents.length} agents, expected 1`);
    }
    return agents[0] as FakeAgent;
  }
}
