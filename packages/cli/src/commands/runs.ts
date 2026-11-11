/** `argos ls`, `argos status <runId>`, `argos gates` (FR25). */

import { rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";
import type { GateSummary, RunDetail, RunSummary } from "argos-core/rpc";

function when(at: number | undefined): string {
  return at === undefined ? "-" : new Date(at).toISOString();
}

function lsHuman(runs: readonly RunSummary[]): string {
  if (runs.length === 0) return "no runs";
  const lines = ["ID                               STATUS      PLAYBOOK                 UPDATED"];
  for (const run of runs) {
    lines.push(
      `${run.id.padEnd(32)} ${run.status.padEnd(11)} ${run.playbookId.padEnd(24)} ${when(run.updatedAt)}`,
    );
  }
  return lines.join("\n");
}

function stepLine(step: RunDetail["steps"][number]): string {
  const attempts = step.attemptCount === 1 ? "1 attempt" : `${step.attemptCount} attempts`;
  const error = step.errorCode === undefined ? "" : `  ${step.errorCode}`;
  return `  ${step.id.padEnd(20)} ${step.status.padEnd(10)} ${attempts}${error}`;
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
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const response = await client.listRuns();
    return { jsonValue: response, human: lsHuman(response.runs) };
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
