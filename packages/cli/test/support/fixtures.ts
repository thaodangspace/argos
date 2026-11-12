/** Deterministic contract fixtures shared by the CLI golden tests and their stub server. */

import type {
  GateSummary,
  RunDetail,
  RunSummary,
  ScheduleDetail,
  ScheduleFire,
  ScheduleSummary,
  ServerInfo,
} from "argos-core/rpc";

export const RUN_ID = "run-1";
export const TASK_ID = "11";
export const DECIDED_AT = 3_000;

/** FR10: fixed schedule timestamps, so the `--json` goldens never depend on the wall clock. */
export const SCHEDULE_ID = "nightly";
export const CREATED_AT = 1_793_491_200_000; // 2026-11-01T00:00:00.000Z
export const FIRE_AT = 1_794_466_800_000; // 2026-11-12T07:00:00.000Z
export const NEXT_FIRE_AT = 1_794_553_200_000; // 2026-11-13T07:00:00.000Z

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

export const LAST_FIRE: ScheduleFire = {
  fireAt: FIRE_AT,
  at: FIRE_AT,
  reason: "cron",
  status: "started",
  runId: RUN_ID,
};

/** `GET /schedules` / `argos schedule ls`: an enabled, healthy schedule with one started fire. */
export const SCHEDULE_SUMMARY: ScheduleSummary = {
  id: SCHEDULE_ID,
  playbookId: "gated",
  cwd: "/repo",
  inputs: { issue: "42" },
  isolation: "worktree",
  cron: "0 7 * * *",
  tz: "Europe/Berlin",
  overlap: "skip",
  catchUp: "all",
  keep: 30,
  enabled: true,
  generation: 1,
  createdAt: CREATED_AT,
  updatedAt: FIRE_AT,
  nextFireAt: NEXT_FIRE_AT,
  lastFire: LAST_FIRE,
  consecutiveFailures: 0,
};

/** `GET /schedules/:id` and the create/edit responses: the summary plus the log and recent runs. */
export const SCHEDULE_DETAIL: ScheduleDetail = {
  ...SCHEDULE_SUMMARY,
  fires: [LAST_FIRE],
  recentRunIds: [RUN_ID],
};

/** FR8.2/FR8.4: the same run, started by {@link SCHEDULE_ID} at {@link FIRE_AT}. */
export const SCHEDULED_RUN_SUMMARY: RunSummary = {
  ...RUN_SUMMARY,
  trigger: { kind: "schedule", scheduleId: SCHEDULE_ID, fireAt: FIRE_AT, reason: "cron" },
};

/** A schedule whose last fire was refused; FR10.3 turns the doctor entry red for it. */
export const REFUSED_SCHEDULE_SUMMARY: ScheduleSummary = {
  ...SCHEDULE_SUMMARY,
  lastFire: {
    fireAt: FIRE_AT,
    at: FIRE_AT,
    reason: "cron",
    status: "refused",
    errorCode: "model_unavailable",
    message: "no provider is available",
  },
  consecutiveFailures: 1,
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
