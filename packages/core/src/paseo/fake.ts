/**
 * The deterministic fake executor behind `ARGOS_FAKE_PASEO=1` (Phase 8/10 tests only).
 *
 * `argos serve` uses this when the environment flag is set: every agent step "launches" an
 * in-memory agent and reports `done` on its first status poll, so a playbook advances without a
 * Paseo daemon, a model, or a network socket. Gate steps still wait for a human decision and
 * script steps still run for real, which is exactly what the end-to-end durability test needs.
 *
 * It is intentionally shipped on `argos-core/paseo` (no SDK import, no side effects) so both the
 * CLI and the Phase 10 E2E can share one fake instead of growing two divergent ones. Production
 * `argos serve` never selects it unless the test-only flag is present.
 */

import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../durable/context.js";
import type { ProviderCatalog } from "./port.js";

export interface FakeStepExecutorOptions {
  /** Complete an attempt after this many status polls (default 1, i.e. immediately). */
  readonly completeAfterPolls?: number;
}

interface FakeAgent {
  readonly requestId: string;
  readonly agentId: string;
  readonly stepId: string;
  readonly attempt: number;
  polls: number;
}

/** In-memory executor: adopts by `requestId`, completes deterministically, never touches a socket. */
export function createFakeStepExecutor(options: FakeStepExecutorOptions = {}): StepExecutor {
  const completeAfterPolls = options.completeAfterPolls ?? 1;
  const agents = new Map<string, FakeAgent>();
  let nextId = 1;

  return {
    async launch(input: LaunchInput): Promise<AgentLaunch> {
      let agent = agents.get(input.requestId);
      if (agent === undefined) {
        agent = {
          requestId: input.requestId,
          agentId: `fake-agent-${nextId}`,
          stepId: input.stepId,
          attempt: input.attempt,
          polls: 0,
        };
        nextId += 1;
        agents.set(input.requestId, agent);
      }
      return { agentId: agent.agentId };
    },

    async status(input: AgentStatusInput): Promise<StepAgentStatus> {
      const agent = agents.get(input.requestId);
      if (agent === undefined) return { state: "running" };
      agent.polls += 1;
      if (agent.polls < completeAfterPolls) return { state: "running" };
      const outcome = input.outcomes.includes("success")
        ? "success"
        : (input.outcomes[0] ?? "success");
      return { state: "done", outcome };
    },
  };
}

/** The provider catalog the fake advertises, so `startRun`'s FR24 check accepts common targets. */
export function fakeProviderCatalog(): ProviderCatalog {
  const models: Record<string, string[]> = {
    claude: ["opus", "sonnet"],
    codex: ["gpt"],
    opencode: ["build"],
    pi: ["default"],
  };
  return {
    providers: Object.entries(models).map(([provider, ids]) => ({
      provider,
      enabled: true,
      models: ids.map((id) => ({ provider, id })),
    })),
  };
}
