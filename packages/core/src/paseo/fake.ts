/**
 * The deterministic fake executor behind `ARGOS_FAKE_PASEO=1` (tests only).
 *
 * `argos serve` uses this when the environment flag is set: every agent step "launches" a fake
 * agent and reports `done` on its first status poll, so a playbook advances without a Paseo
 * daemon, a model, or a network socket. Gate steps still wait for a human decision and script
 * steps still run for real, which is exactly what the end-to-end durability tests need.
 *
 * Two modes:
 *
 * - **In-memory** (default, `createFakeStepExecutor()`): the unit-test fake. Nothing is written.
 * - **File-backed** (`statePath` set; `argos serve` passes `$ARGOS_HOME`): the agent registry is
 *   persisted as `fake-paseo.json` and every creation is appended to
 *   `fake-paseo-launches.jsonl`. That is what lets a `SIGKILL`ed `argos serve` restart and adopt
 *   the agents it created in its previous lifetime instead of launching them twice (Phase 10,
 *   D17). The JSONL ledger is the source of truth for adoption; the JSON file is the readable
 *   snapshot plus the next id.
 *
 * Test-only environment knobs (read by `argos serve`, never by production code paths):
 *
 * - `ARGOS_FAKE_PASEO=1` — select this executor.
 * - `ARGOS_FAKE_PASEO_DIR` — state directory; defaults to `$ARGOS_HOME`.
 * - `ARGOS_FAKE_PASEO_BLOCK_STEP=<stepId>` — every agent of that step reports `running` until
 *   the release file exists. Used to hold a run mid-step for the kill/restart scenario.
 * - `ARGOS_FAKE_PASEO_RELEASE_FILE=<path>` — the file whose appearance releases the blocked step
 *   (checked on every status poll; the E2E playbook polls every 50 ms).
 *
 * It is intentionally shipped on `@thaodangspace/argos-core/paseo` (no SDK import) so both the CLI and the
 * Phase 10 E2E can share one fake instead of growing two divergent ones.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../durable/context.js";
import type { ProviderCatalog } from "./port.js";

/** One fake agent, as persisted in `fake-paseo.json` and `fake-paseo-launches.jsonl`. */
export interface FakePaseoAgent {
  readonly requestId: string;
  readonly agentId: string;
  readonly stepId: string;
  readonly attempt: number;
  /** Creation time (epoch ms). */
  readonly at: number;
  /** The `argos serve` process that created the agent (proves the cross-lifetime ledger). */
  readonly pid: number;
}

export interface FakeStepExecutorOptions {
  /** Complete an attempt after this many status polls (default 1, i.e. immediately). */
  readonly completeAfterPolls?: number;
  /**
   * Persist agents and the creation ledger in this directory (Phase 10 E2E). Omit for the
   * in-memory unit-test fake.
   */
  readonly statePath?: string;
  /** Environment used for the block/release knobs; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Blocked step id override (default `ARGOS_FAKE_PASEO_BLOCK_STEP`). */
  readonly blockStep?: string;
  /** Release file override (default `ARGOS_FAKE_PASEO_RELEASE_FILE`). */
  readonly releaseFile?: string;
}

/** File names inside the state directory; exported so tests can assert the layout. */
export const FAKE_PASEO_STATE_FILE = "fake-paseo.json";
export const FAKE_PASEO_LAUNCHES_FILE = "fake-paseo-launches.jsonl";

interface MutableAgent extends FakePaseoAgent {
  polls: number;
}

function isAgentRecord(value: unknown): value is FakePaseoAgent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FakePaseoAgent>;
  return (
    typeof record.requestId === "string" &&
    typeof record.agentId === "string" &&
    typeof record.stepId === "string" &&
    typeof record.attempt === "number" &&
    typeof record.at === "number" &&
    typeof record.pid === "number"
  );
}

/** Read every valid line of an append-only JSONL ledger (a torn tail line is ignored). */
function readLedger(file: string): FakePaseoAgent[] {
  if (!existsSync(file)) return [];
  const result: FakePaseoAgent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isAgentRecord(parsed)) result.push(parsed);
    } catch {
      // A kill during an append can leave a partial final line; the next create rewrites state.
    }
  }
  return result;
}

/**
 * The file-backed agent registry. The JSONL ledger is authoritative (append-only, survives a
 * `SIGKILL`); `fake-paseo.json` is rewritten atomically as a readable snapshot.
 */
function createFileState(directory: string) {
  const stateFile = join(directory, FAKE_PASEO_STATE_FILE);
  const launchesFile = join(directory, FAKE_PASEO_LAUNCHES_FILE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const byRequest = new Map<string, MutableAgent>();
  const byAgent = new Map<string, MutableAgent>();
  let nextId = 1;
  let loaded = false;

  const register = (record: FakePaseoAgent): MutableAgent => {
    const existing = byRequest.get(record.requestId);
    if (existing !== undefined) return existing;
    const agent: MutableAgent = { ...record, polls: 0 };
    byRequest.set(agent.requestId, agent);
    byAgent.set(agent.agentId, agent);
    const numeric = Number.parseInt(agent.agentId.replace(/^fake-agent-/, ""), 10);
    if (Number.isInteger(numeric) && numeric >= nextId) nextId = numeric + 1;
    return agent;
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    for (const record of readLedger(launchesFile)) register(record);
    if (existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
          nextId?: unknown;
          agents?: unknown;
        };
        if (Array.isArray(parsed.agents)) {
          for (const record of parsed.agents) if (isAgentRecord(record)) register(record);
        }
        if (typeof parsed.nextId === "number" && Number.isInteger(parsed.nextId)) {
          nextId = Math.max(nextId, parsed.nextId);
        }
      } catch {
        // A corrupt snapshot is not fatal: the ledger is authoritative for agents.
      }
    }
  };

  const snapshot = (): void => {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, nextId, agents: [...byRequest.values()] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, stateFile);
  };

  return {
    find(requestId: string): MutableAgent | undefined {
      load();
      return byRequest.get(requestId);
    },
    findByAgentId(agentId: string): MutableAgent | undefined {
      load();
      return byAgent.get(agentId);
    },
    create(input: { requestId: string; stepId: string; attempt: number }): MutableAgent {
      load();
      const record: FakePaseoAgent = {
        requestId: input.requestId,
        agentId: `fake-agent-${nextId}`,
        stepId: input.stepId,
        attempt: input.attempt,
        at: Date.now(),
        pid: process.pid,
      };
      nextId += 1;
      // Append first: the ledger is the adoption source after a crash. Then rewrite the readable
      // snapshot. A kill between the two leaves an adoptable ledger entry, never a duplicate.
      appendFileSync(launchesFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const agent = register(record);
      snapshot();
      return agent;
    },
  };
}

/** In-memory executor: adopts by `requestId`, completes deterministically, never touches a socket. */
export function createFakeStepExecutor(options: FakeStepExecutorOptions = {}): StepExecutor {
  const completeAfterPolls = options.completeAfterPolls ?? 1;
  const env = options.env ?? process.env;
  const blockStep = options.blockStep ?? env["ARGOS_FAKE_PASEO_BLOCK_STEP"];
  const releaseFile = options.releaseFile ?? env["ARGOS_FAKE_PASEO_RELEASE_FILE"];
  const state = options.statePath === undefined ? undefined : createFileState(options.statePath);
  const memory = new Map<string, MutableAgent>();
  let nextId = 1;

  const adopt = (requestId: string): MutableAgent | undefined =>
    state === undefined ? memory.get(requestId) : state.find(requestId);

  const statusOf = (input: AgentStatusInput): StepAgentStatus => {
    const agent =
      state === undefined
        ? memory.get(input.requestId)
        : (state.find(input.requestId) ?? state.findByAgentId(input.agentId));
    if (agent === undefined) return { state: "running" };
    // Test-only hold: an agent of the named step stays running until the release file appears.
    // Checked on every poll, so the playbook's `poll_ms` controls the pacing.
    if (blockStep !== undefined && agent.stepId === blockStep) {
      if (releaseFile === undefined || !existsSync(releaseFile)) return { state: "running" };
    }
    agent.polls += 1;
    if (agent.polls < completeAfterPolls) return { state: "running" };
    const outcome = input.outcomes.includes("success") ? "success" : (input.outcomes[0] ?? "success");
    return { state: "done", outcome };
  };

  return {
    async launch(input: LaunchInput): Promise<AgentLaunch> {
      const existing = adopt(input.requestId);
      if (existing !== undefined) return { agentId: existing.agentId };
      if (state !== undefined) {
        const agent = state.create({
          requestId: input.requestId,
          stepId: input.stepId,
          attempt: input.attempt,
        });
        return { agentId: agent.agentId };
      }
      const agent: MutableAgent = {
        requestId: input.requestId,
        agentId: `fake-agent-${nextId}`,
        stepId: input.stepId,
        attempt: input.attempt,
        at: Date.now(),
        pid: process.pid,
        polls: 0,
      };
      nextId += 1;
      memory.set(input.requestId, agent);
      return { agentId: agent.agentId };
    },

    async status(input: AgentStatusInput): Promise<StepAgentStatus> {
      return statusOf(input);
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
