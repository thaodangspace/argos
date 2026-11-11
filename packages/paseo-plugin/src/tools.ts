/**
 * The four chat tools (FR28), registered on every agent session through `agent.open.before`.
 *
 * They are thin: validate the input with the RPC contract's own zod schema, call one route, and
 * render a short, prompt-free summary. Two rules matter:
 *
 * 1. **Never throw.** A tool that throws gives the model a stack trace; these return
 *    `{ isError: true, structuredContent: { error: { code, message } } }` with a stable code, so
 *    the model can act on it (and the panel/test can match on the code).
 * 2. **Never prompt past the boundary.** `argos_run_status` renders step titles, statuses, gate
 *    questions, and error codes. The contract has no prompts or transcripts to leak.
 */

import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import {
  DecideGateRequestSchema,
  StartRunRequestSchema,
  type GateSummary,
  type RunDetail,
  type RunSummary,
  type StepSummary,
} from "argos-core/rpc";
import { z } from "zod";

import { PluginRpcError, type ArgosRpc } from "./rpc-client.js";
import { RUN_STATUS_LABELS, STEP_STATUS_LABELS } from "./panel.js";

/** The exact tool names (FR28). Order is the registration order. */
export const ARGOS_TOOL_NAMES = [
  "argos_start_playbook",
  "argos_run_status",
  "argos_decide_gate",
  "argos_cancel_run",
] as const;

export type ArgosToolName = (typeof ARGOS_TOOL_NAMES)[number];

/** Inputs of a start request are the RPC contract's, so a typo is a validation error, not a 400. */
export const StartPlaybookInputSchema = StartRunRequestSchema;

export const RunStatusInputSchema = z.strictObject({
  runId: z.string().min(1).describe("Run id returned by argos_start_playbook"),
});

/** The decision body plus the two ids that live in the route. */
export const DecideGateInputSchema = DecideGateRequestSchema.extend({
  runId: z.string().min(1),
  gateId: z.string().min(1).describe("<stepId>:<n>, from argos_run_status or the panel"),
});

export const CancelRunInputSchema = z.strictObject({
  runId: z.string().min(1),
});

/** Codes that all mean "fix the playbook or its inputs before retrying". */
const START_FAILURE_CODES: Readonly<Record<string, string>> = {
  invalid_request: "playbook_invalid",
  playbook_missing: "playbook_invalid",
  playbook_invalid: "playbook_invalid",
  playbook_cycle: "playbook_invalid",
  worktree_base_dirty: "playbook_invalid",
};

function failure(code: string, message: string): AgentToolResult {
  return {
    isError: true,
    structuredContent: { error: { code, message } },
    text: `Argos error (${code}): ${message}`,
  };
}

function failureFrom(error: unknown): AgentToolResult {
  const pluginError = PluginRpcError.from(error);
  return failure(pluginError.code, pluginError.message);
}

function startFailure(error: unknown): AgentToolResult {
  const pluginError = PluginRpcError.from(error);
  const code = START_FAILURE_CODES[pluginError.code];
  if (code === undefined) return failure(pluginError.code, pluginError.message);
  return failure(code, pluginError.message);
}

function ok(text: string, structuredContent: unknown): AgentToolResult {
  return { text, structuredContent };
}

// ------------------------------------------------------------------ rendering

function stepLine(step: StepSummary): string {
  const attempts = step.attemptCount > 1 ? ` (${step.attemptCount} attempts)` : "";
  const error = step.errorCode === undefined ? "" : ` — ${step.errorCode}`;
  return `- ${step.title === "" ? step.id : step.title} [${step.id}] · ${STEP_STATUS_LABELS[step.status]}${attempts}${error}`;
}

function gateLine(gate: GateSummary): string {
  const choices = Object.entries(gate.choices)
    .map(([id, choice]) => (choice.label === id ? id : `${id} (${choice.label})`))
    .join(" | ");
  return `- gate ${gate.gateId} on step ${gate.stepId}: ${gate.question} → ${choices}`;
}

function renderStatus(run: RunSummary | RunDetail): string {
  const lines: string[] = [
    `run ${run.id} · ${run.playbookId} · ${RUN_STATUS_LABELS[run.status]}`,
    `cwd ${run.cwd}${run.worktree === undefined ? "" : ` (worktree ${run.worktree.path} on ${run.worktree.branch})`}`,
    "steps:",
    ...run.steps.map((step) => stepLine(step)),
  ];
  const gates = run.gates.filter((gate) => gate.status === "pending");
  if (gates.length > 0) {
    lines.push("pending gates:", ...gates.map((gate) => gateLine(gate)));
  }
  const after = run.after.filter((entry) => entry.status !== "pending");
  if (after.length > 0) {
    lines.push(
      "after-tasks:",
      ...after.map((entry) => `- ${entry.id} · ${entry.status}`),
    );
  }
  return lines.join("\n");
}

/** The structured half of `argos_run_status`: status + steps + gates, never a prompt. */
function statusPayload(run: RunDetail): unknown {
  return {
    run: {
      id: run.id,
      playbookId: run.playbookId,
      playbookHash: run.playbookHash,
      status: run.status,
      cwd: run.cwd,
      ...(run.worktree === undefined ? {} : { worktree: run.worktree }),
      updatedAt: run.updatedAt,
      steps: run.steps,
      gates: run.gates,
      after: run.after,
    },
    history: run.history.slice(-20),
  };
}

// ------------------------------------------------------------------ tools

/** Build the four tools bound to one RPC client. */
export function argosTools(client: ArgosRpc): AgentToolDefinition[] {
  const start = defineAgentTool({
    name: ARGOS_TOOL_NAMES[0],
    title: "Start an Argos playbook",
    description:
      "Start an Argos YAML playbook (YAML files under .argos/playbooks in the workspace). " +
      "Returns the run id to follow with argos_run_status. Invalid inputs or an invalid playbook " +
      "return isError with code playbook_invalid.",
    input: StartPlaybookInputSchema,
    execute: async (input) => {
      try {
        const started = await client.startRun({
          ...input,
          clientRequestId: input.clientRequestId ?? globalThis.crypto.randomUUID(),
        });
        return ok(`started run ${started.runId} (task ${started.taskId})`, {
          runId: started.runId,
          taskId: started.taskId,
        });
      } catch (error) {
        return startFailure(error);
      }
    },
  });

  const status = defineAgentTool({
    name: ARGOS_TOOL_NAMES[1],
    title: "Argos run status",
    description:
      "Report one Argos run: overall status, every step's status and error code, and the pending " +
      "gates with their choices. Use the gate id with argos_decide_gate.",
    input: RunStatusInputSchema,
    execute: async (input) => {
      try {
        const run = await client.getRun(input.runId);
        return ok(renderStatus(run), statusPayload(run));
      } catch (error) {
        return failureFrom(error);
      }
    },
  });

  const decide = defineAgentTool({
    name: ARGOS_TOOL_NAMES[2],
    title: "Decide an Argos gate",
    description:
      "Decide one pending Argos gate. decision must be one of the gate's choices; comment is " +
      "passed to the next attempt as feedback. A gate that was already decided returns " +
      "gate_already_decided (fetch the status again instead of retrying).",
    input: DecideGateInputSchema,
    execute: async (input) => {
      try {
        const { runId, gateId, ...body } = input;
        const receipt = await client.decideGate(runId, gateId, body);
        return ok(
          `decided gate ${receipt.gateId} on run ${receipt.runId}: ${receipt.decision}`,
          receipt,
        );
      } catch (error) {
        return failureFrom(error);
      }
    },
  });

  const cancel = defineAgentTool({
    name: ARGOS_TOOL_NAMES[3],
    title: "Cancel an Argos run",
    description:
      "Cancel an Argos run and report the status it reached. Cancelling a finished run returns " +
      "run_terminal.",
    input: CancelRunInputSchema,
    execute: async (input) => {
      try {
        const result = await client.cancelRun(input.runId);
        return ok(`run ${result.runId} is ${result.status}`, result);
      } catch (error) {
        return failureFrom(error);
      }
    },
  });

  return [start, status, decide, cancel];
}

/**
 * Append the Argos tools to a session's tool list, replacing any earlier Argos tool by name. A
 * session that opens twice (resume/refresh) or a plugin reloaded in place therefore still has
 * exactly four Argos tools.
 */
export function appendArgosTools(
  existing: readonly AgentToolDefinition[],
  tools: readonly AgentToolDefinition[],
): AgentToolDefinition[] {
  const names = new Set(tools.map((tool) => tool.name));
  return [...existing.filter((tool) => !names.has(tool.name)), ...tools];
}
