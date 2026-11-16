/** `argos ls` (with `--schedule`), `argos status <runId>`, `argos gates` (FR25, FR8.4). */

import { flag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, formatCost, formatUsage, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";
import type { GateSummary, RunDetail, RunSummary } from "@thaodangspace/argos-core/rpc";

function when(at: number | undefined): string {
  return at === undefined ? "-" : new Date(at).toISOString();
}

/** The cost component of an aggregate usage record, if the executor reported one. */
function costLabel(usage: Readonly<Record<string, number>> | undefined): string | undefined {
  const total = usage?.["totalCostUsd"];
  return total === undefined ? undefined : formatCost(total);
}

function lsHuman(runs: readonly RunSummary[]): string {
  if (runs.length === 0) return "no runs";
  const costs = runs.map((run) => costLabel(run.usage));
  // The COST column appears only when at least one run reported accounting, so a deployment with
  // no usage data keeps the old (shorter) line byte-for-byte.
  const withCost = costs.some((cost) => cost !== undefined);
  const header = withCost
    ? "ID                               STATUS      PLAYBOOK                 UPDATED                     COST"
    : "ID                               STATUS      PLAYBOOK                 UPDATED";
  const lines = [header];
  for (const [index, run] of runs.entries()) {
    // FR8.4: a scheduled run says so; a manual run's line stays byte-identical.
    const schedule = run.trigger === undefined ? "" : `  [schedule ${run.trigger.scheduleId}]`;
    // S-FR12: a forked run names its parent and fork point, after the schedule marker (a run can
    // be both).
    const fork =
      run.forkedFrom === undefined
        ? ""
        : `  [fork ${run.forkedFrom.runId.slice(0, 8)}@${run.forkedFrom.stepId}]`;
    const cost = withCost ? `  ${(costs[index] ?? "-").padStart(7)}` : "";
    lines.push(
      `${run.id.padEnd(32)} ${run.status.padEnd(11)} ${run.playbookId.padEnd(24)} ${when(run.updatedAt)}${cost}${schedule}${fork}`,
    );
  }
  return lines.join("\n");
}

function stepLine(step: RunDetail["steps"][number]): string {
  const attempts = step.attemptCount === 1 ? "1 attempt" : `${step.attemptCount} attempts`;
  const error = step.errorCode === undefined ? "" : `  ${step.errorCode}`;
  const cost = costLabel(step.usage);
  return `  ${step.id.padEnd(20)} ${step.status.padEnd(10)} ${attempts}${error}${cost === undefined ? "" : `  ${cost}`}`;
}

function gateLine(gate: GateSummary): string {
  const decision =
    gate.status === "decided"
      ? `  decided "${gate.decision ?? "?"}"${gate.decidedBy === undefined ? "" : ` by ${gate.decidedBy}`}`
      : "";
  return `  ${gate.gateId.padEnd(20)} ${gate.kind.padEnd(10)} ${gate.status}${decision}  ${gate.question}`;
}

function statusHuman(run: RunDetail): string {
  const lines = [
    `run ${run.id}`,
    `  status    ${run.status}`,
    `  playbook  ${run.playbookId} (${run.playbookHash.slice(0, 12)})`,
    `  cwd       ${run.cwd}`,
  ];
  if (run.worktree !== undefined) {
    lines.push(`  worktree  ${run.worktree.path} [${run.worktree.branch}]`);
  }
  // S-FR12: both hashes, so the discontinuity is visible without `--json`.
  if (run.forkedFrom !== undefined) {
    lines.push(
      `  forked    from ${run.forkedFrom.runId} at ${run.forkedFrom.stepId} ` +
        `(${run.forkedFrom.fromHash.slice(0, 12)} -> ${run.forkedFrom.toHash.slice(0, 12)})`,
    );
  }
  // Workflow total: counters summed across every agent step; absent when nothing was reported.
  const usage = formatUsage(run.usage);
  if (usage !== null) lines.push(`  usage     ${usage}`);
  lines.push("steps:");
  for (const step of run.steps) lines.push(stepLine(step));
  if (run.gates.length > 0) {
    lines.push("gates:");
    for (const gate of run.gates) lines.push(gateLine(gate));
  }
  if (run.after.length > 0) {
    lines.push("after:");
    for (const after of run.after) lines.push(`  ${after.id.padEnd(20)} ${after.status}`);
  }
  if (run.history.length > 0) {
    const last = run.history.at(-1);
    lines.push(`history  ${run.history.length} event(s), last ${last?.type ?? "?"} at ${when(last?.at)}`);
  }
  return lines.join("\n");
}

function gatesHuman(gates: readonly GateSummary[]): string {
  if (gates.length === 0) return "no pending gates";
  return gates
    .map(
      (gate) =>
        `${gate.runId}  ${gate.gateId.padEnd(20)} ${gate.kind.padEnd(10)} ${gate.question}`,
    )
    .join("\n");
}

export async function lsCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["schedule"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const scheduleId = flag(args, "schedule");
  return withRpc(io, args.json, async (client) => {
    const response = await client.listRuns();
    // FR8.4: filter on the client, by the trigger the mirror already carries. A run started by
    // hand never matches, because it has no trigger at all.
    const runs =
      scheduleId === undefined
        ? response.runs
        : response.runs.filter((run) => run.trigger?.scheduleId === scheduleId);
    return {
      jsonValue: scheduleId === undefined ? response : { runs },
      human: lsHuman(runs),
    };
  });
}

export async function statusCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const runId = args.positionals[0];
  if (runId === undefined) {
    io.stderr("argos: status needs a run id\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const detail = await client.getRun(runId);
    return { jsonValue: detail, human: statusHuman(detail) };
  });
}

export async function gatesCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const response = await client.listPendingGates();
    return { jsonValue: response, human: gatesHuman(response.gates) };
  });
}
