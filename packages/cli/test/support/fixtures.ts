/** Deterministic contract fixtures shared by the CLI golden tests and their stub server. */

import type {
  GateSummary,
  RunDetail,
  RunSummary,
  ServerInfo,
} from "argos-core/rpc";

export const RUN_ID = "run-1";
export const TASK_ID = "11";
export const DECIDED_AT = 3_000;

export const PENDING_GATE: GateSummary = {
  runId: RUN_ID,
  gateId: "review:1",
  stepId: "review",
  kind: "step",
  question: "Ship it?",
  choices: {
    approve: { label: "Approve", comment: "optional" },
    revise: { label: "Revise", comment: "required", color: "danger" },
  },
  status: "pending",
};

export const DECIDED_GATE: GateSummary = {
  ...PENDING_GATE,
  status: "decided",
  decision: "approve",
  decidedBy: "dt",
  decidedVia: "cli",
  comment: "ship it",
  decidedAt: DECIDED_AT,
};

export const RUN_SUMMARY: RunSummary = {
  id: RUN_ID,
  playbookId: "gated",
  playbookHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  status: "waiting",
  inputs: { issue: "42" },
  cwd: "/repo",
  worktree: { path: "/home/worktrees/run-1", branch: "argos/run-1", baseSha: "abc123" },
  steps: [
    {
      id: "draft",
      title: "Draft the change",
      kind: "agent",
      status: "completed",
      attemptCount: 1,
      startedAt: 1_000,
      endedAt: 2_000,
    },
    { id: "review", title: "Review", kind: "gate", status: "waiting", attemptCount: 0 },
  ],
  gates: [PENDING_GATE],
  after: [],
  createdAt: 1_000,
  updatedAt: 2_000,
  seq: 4,
};

export const RUN_DETAIL: RunDetail = {
  ...RUN_SUMMARY,
  status: "completed",
  gates: [DECIDED_GATE],
  steps: [
    RUN_SUMMARY.steps[0] as RunDetail["steps"][number],
    {
      id: "review",
      title: "Review",
      kind: "gate",
      status: "completed",
      attemptCount: 0,
      startedAt: 2_000,
      endedAt: DECIDED_AT,
    },
  ],
  updatedAt: DECIDED_AT,
  seq: 6,
  history: [
    { at: 1_000, seq: 0, type: "run_started", stepId: null, attempt: null, detail: "gated" },
    { at: 1_500, seq: 1, type: "dispatch", stepId: "draft", attempt: 1, detail: null },
    { at: 2_000, seq: 2, type: "gate", stepId: "review", attempt: null, detail: "review:1 step" },
    { at: DECIDED_AT, seq: 3, type: "gate_decided", stepId: "review", attempt: null, detail: "review:1 approve" },
    { at: DECIDED_AT, seq: 4, type: "finish", stepId: null, attempt: null, detail: "approved" },
  ],
};

/** `GET /info` with a fixed pid/start time; the port is filled in by the stub. */
export function serverInfo(port: number): ServerInfo {
  return {
    name: "argos",
    rpcVersion: 1,
    schemaVersion: 1,
    pid: 4_242,
    port,
    home: "/home",
    node: process.versions.node,
    startedAt: 1_000,
    uptimeMs: 0,
    paseo: { mode: "fake", reachable: true },
    providers: [
      { provider: "claude", enabled: true, models: ["claude/opus", "claude/sonnet"] },
      { provider: "codex", enabled: true, models: ["codex/gpt"] },
    ],
    pendingGates: [PENDING_GATE],
    runs: { total: 1, active: 1 },
  };
}
