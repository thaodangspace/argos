/**
 * In-memory `PaseoPort` for the Phase 6 tests.
 *
 * It models only what the adapter may rely on: labelled agents, an ordered provider catalog, and
 * scripted per-agent outcomes. No socket, no SDK import, no timers — every wait is explicit, so
 * the durable tests can drive a fake clock and assert exact create/list/archive counts.
 *
 * `blockCreate()` reproduces the crash window: the agent exists in the map (the daemon accepted
 * the create) but the promise never resolves until `releaseCreate()`, so the process can be
 * "killed" between `agents.create` and the `agentId` commit.
 */

import type {
  AgentInfo,
  AgentRef,
  CreateAgentInput,
  FinishResult,
  PaseoAgentStatus,
  PaseoPort,
  ProviderCatalog,
} from "../../src/paseo/port.js";
import {
  AgentMissingError,
  LabelFilterUnsupportedError,
  QuotaError,
} from "../../src/paseo/port.js";

export interface FakePaseoAgent {
  readonly id: string;
  readonly requestId: string;
  readonly target: string;
  readonly labels: Readonly<Record<string, string>>;
  status: PaseoAgentStatus;
  archived: boolean;
  /** Structured result the provider would report (when it honours `outputSchema`). */
  output?: unknown;
  /** Plain final message (the D12 fallback path). */
  lastMessage?: string | null;
  error?: string | null;
  usage?: Readonly<Record<string, number>>;
  polls: number;
}

/** Scripted completion of one fake agent. */
export interface FakePaseoResult {
  readonly output?: unknown;
  readonly text?: string | null;
  readonly error?: string | null;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface FakePaseoOptions {
  readonly supportsLabelFilter?: boolean;
  /** Default catalog: claude/opus and codex/gpt are known. */
  readonly providers?: ProviderCatalog;
  /** Targets whose `create` throws a quota error (FR24). */
  readonly quotaTargets?: readonly string[];
  /** Agents whose `refresh` should fail (simulates archived/unknown mid-step). */
  readonly missingAgents?: readonly string[];
  /** New agents report `idle` but their turn never settles (exercises `waitForFinish` timeout). */
  readonly unsettled?: boolean;
}

export const DEFAULT_FAKE_CATALOG: ProviderCatalog = {
  providers: [
    {
      provider: "claude",
      enabled: true,
      models: [{ provider: "claude", id: "opus" }, { provider: "claude", id: "sonnet" }],
    },
    {
      provider: "codex",
      enabled: true,
      models: [{ provider: "codex", id: "gpt" }],
    },
  ],
};

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export class FakePaseoPort implements PaseoPort {
  readonly supportsLabelFilter: boolean;
  readonly agents = new Map<string, FakePaseoAgent>();
  /** Every successful `create` call, in order (what the adapter asked the daemon to launch). */
  readonly creates: CreateAgentInput[] = [];
  /** Every `create` invocation, including quota-rejected ones. */
  readonly createCalls: string[] = [];
  readonly listCalls: Readonly<Record<string, string>>[] = [];
  readonly archiveCalls: string[] = [];
  readonly waitCalls: { readonly agentId: string; readonly timeoutMs: number }[] = [];
  readonly quotaTargets = new Set<string>();
  /** Agents whose refresh should throw `AgentMissingError` once (then behave normally). */
  readonly missingAgents = new Set<string>();
  /** Agents whose `waitForFinish` reports a timeout (the turn never settles). */
  readonly timeoutAgents = new Set<string>();
  /** Completes an agent as soon as it is created (keeps host tests short). */
  completeOnCreate: ((input: CreateAgentInput) => FakePaseoResult | undefined) | undefined;
  readonly #providers: ProviderCatalog;
  readonly #createGate = gate();
  readonly #unsettled: boolean;
  #blocked = false;
  #nextAgent = 1;

  constructor(options: FakePaseoOptions = {}) {
    this.supportsLabelFilter = options.supportsLabelFilter ?? true;
    this.#providers = options.providers ?? DEFAULT_FAKE_CATALOG;
    this.#unsettled = options.unsettled ?? false;
    for (const target of options.quotaTargets ?? []) this.quotaTargets.add(target);
    for (const agent of options.missingAgents ?? []) this.missingAgents.add(agent);
  }

  /** Seed a daemon-side agent (e.g. one created before a simulated crash). */
  seedAgent(input: {
    readonly labels: Readonly<Record<string, string>>;
    readonly target: string;
    readonly output?: unknown;
    readonly lastMessage?: string | null;
    readonly status?: PaseoAgentStatus;
    readonly archived?: boolean;
  }): FakePaseoAgent {
    const id = `paseo-agent-${this.#nextAgent}`;
    this.#nextAgent += 1;
    const agent: FakePaseoAgent = {
      id,
      requestId: input.labels["argos/launch"] ?? "",
      target: input.target,
      labels: { ...input.labels },
      status: input.status ?? "running",
      archived: input.archived ?? false,
      ...(input.output === undefined ? {} : { output: input.output }),
      lastMessage: input.lastMessage ?? null,
      polls: 0,
    };
    this.agents.set(id, agent);
    return agent;
  }

  /** Mark one agent finished with a structured output, text result, or error. */
  complete(agentId: string, result: FakePaseoResult): void {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new Error(`FakePaseoPort: unknown agent ${agentId}`);
    agent.status = result.error === undefined || result.error === null ? "idle" : "error";
    if (result.output !== undefined) agent.output = result.output;
    if (result.text !== undefined) agent.lastMessage = result.text;
    if (result.error !== undefined) agent.error = result.error;
    if (result.usage !== undefined) agent.usage = result.usage;
  }

  completeAll(result: FakePaseoResult): void {
    for (const agent of this.agents.values()) {
      if (agent.status === "running") this.complete(agent.id, result);
    }
  }

  /** Hold every subsequent `create` response (the process "crashes" after the daemon created it). */
  blockCreate(): void {
    this.#blocked = true;
  }

  releaseCreate(): void {
    this.#blocked = false;
    this.#createGate.release();
  }

  /** The latest create request for one `argos/launch` id, if any. */
  createFor(requestId: string): CreateAgentInput | undefined {
    return [...this.creates].reverse().find((create) => create.requestId === requestId);
  }

  /** How many times `create` was invoked (including quota rejections) for one request id. */
  createsFor(requestId: string): number {
    return this.createCalls.filter((id) => id === requestId).length;
  }

  agentFor(requestId: string): FakePaseoAgent | undefined {
    return [...this.agents.values()].find((agent) => agent.requestId === requestId);
  }

  async listByLabels(labels: Readonly<Record<string, string>>): Promise<AgentRef[]> {
    this.listCalls.push({ ...labels });
    if (!this.supportsLabelFilter) {
      throw new LabelFilterUnsupportedError();
    }
    const entries = [...this.agents.values()]
      .filter((agent) =>
        Object.entries(labels).every(([key, value]) => agent.labels[key] === value),
      )
      .map((agent) => ({
        agentId: agent.id,
        target: agent.target,
        status: agent.status,
        archived: agent.archived,
        labels: agent.labels,
      }));
    return entries;
  }

  async create(input: CreateAgentInput): Promise<AgentRef> {
    this.createCalls.push(input.requestId);
    if (this.quotaTargets.has(input.config.provider)) {
      throw new QuotaError(`${input.config.provider}: usage limit reached`, {
        target: input.config.provider,
        code: "insufficient_quota",
      });
    }
    const id = `paseo-agent-${this.#nextAgent}`;
    this.#nextAgent += 1;
    const agent: FakePaseoAgent = {
      id,
      requestId: input.requestId,
      target: input.config.provider,
      labels: { ...input.labels },
      status: this.#unsettled ? "idle" : "running",
      archived: false,
      lastMessage: null,
      polls: 0,
    };
    this.agents.set(id, agent);
    this.creates.push(input);
    const immediate = this.completeOnCreate?.(input);
    if (immediate !== undefined) this.complete(id, immediate);
    if (this.#blocked) await this.#createGate.promise;
    return { agentId: id, target: agent.target, status: agent.status, archived: false };
  }

  async refresh(agentId: string): Promise<AgentInfo | null> {
    if (this.missingAgents.delete(agentId)) {
      throw new AgentMissingError(agentId);
    }
    const agent = this.agents.get(agentId);
    if (agent === undefined) return null;
    agent.polls += 1;
    return {
      agentId: agent.id,
      status: agent.status,
      target: agent.target,
      archived: agent.archived,
      lastMessage: agent.lastMessage ?? null,
      error: agent.error ?? null,
      ...(agent.output === undefined ? {} : { output: agent.output }),
      ...(agent.usage === undefined ? {} : { usage: agent.usage }),
    };
  }

  async waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
    this.waitCalls.push({ agentId, timeoutMs });
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new AgentMissingError(agentId);
    if (this.#unsettled || this.timeoutAgents.has(agentId) || agent.status === "running") {
      return { status: "timeout", final: null, error: null, lastMessage: null };
    }
    if (agent.status === "error") {
      return {
        status: "error",
        final: null,
        error: agent.error ?? "agent failed",
        lastMessage: null,
      };
    }
    return {
      status: "idle",
      final: null,
      error: null,
      lastMessage: agent.lastMessage ?? null,
      ...(agent.output === undefined ? {} : { output: agent.output }),
      ...(agent.usage === undefined ? {} : { usage: agent.usage }),
    };
  }

  async archive(agentId: string): Promise<void> {
    this.archiveCalls.push(agentId);
    const agent = this.agents.get(agentId);
    if (agent !== undefined) agent.archived = true;
  }

  async providersSnapshot(): Promise<ProviderCatalog> {
    return this.#providers;
  }
}
