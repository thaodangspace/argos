/** Deterministic contract fixtures shared by the CLI golden tests and their stub server. */

import type {
  DbPurgeResponse,
  DbStats,
  DbVacuumResponse,
  ExecutorInfo,
  GateSummary,
  RunDetail,
  RunSummary,
  ScheduleDetail,
  ScheduleFire,
  ScheduleSummary,
  ServerInfo,
} from "@thaodangspace/argos-core/rpc";

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
    {
      ...(RUN_SUMMARY.steps[0] as RunDetail["steps"][number]),
      outcome: "success",
      attempts: [
        { n: 1, startedAt: 1_500, endedAt: 2_000, outcome: "completed", target: "claude/opus" },
      ],
      outputs: { note: "drafted" },
    },
    {
      id: "review",
      title: "Review",
      kind: "gate",
      status: "completed",
      attemptCount: 0,
      startedAt: 2_000,
      endedAt: DECIDED_AT,
      attempts: [],
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

/**
 * Accounting fixture (FR26): two agent steps that reported cost/tokens, one gate step that did not.
 * Kept out of the committed goldens so `ls.json`/`status.json` stay byte-identical.
 */
export const USAGE_RUN_SUMMARY: RunSummary = {
  ...RUN_SUMMARY,
  status: "completed",
  usage: {
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 4_096,
    inputTokens: 240,
    outputTokens: 6_000,
    totalCostUsd: 0.67,
  },
  steps: [
    {
      id: "draft",
      title: "Draft the change",
      kind: "agent",
      status: "completed",
      attemptCount: 1,
      startedAt: 1_000,
      endedAt: 2_000,
      usage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 2_048,
        inputTokens: 120,
        outputTokens: 3_000,
        totalCostUsd: 0.25,
      },
    },
    {
      id: "verify",
      title: "Verify",
      kind: "agent",
      status: "completed",
      attemptCount: 1,
      startedAt: 2_000,
      endedAt: 3_000,
      usage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 4_096,
        inputTokens: 120,
        outputTokens: 3_000,
        totalCostUsd: 0.42,
      },
    },
    { id: "review", title: "Review", kind: "gate", status: "completed", attemptCount: 0 },
  ],
  gates: [DECIDED_GATE],
  updatedAt: DECIDED_AT,
};

/** The same run as `argos status` sees it: every step carries its (empty) attempt list. */
export const USAGE_RUN_DETAIL: RunDetail = {
  ...USAGE_RUN_SUMMARY,
  steps: USAGE_RUN_SUMMARY.steps.map((step) => ({ ...step, attempts: [] })),
  history: [],
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

/** `argos status` for a forked run: the detail plus the provenance edge (S-FR12). */
export const FORKED_RUN_DETAIL: RunDetail = {
  ...RUN_DETAIL,
  forkedFrom: {
    runId: RUN_ID,
    stepId: "review",
    fromHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    toHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  },
};

/** A run started by `argos fork`: same shape plus the provenance edge (S-FR5). */
export const FORKED_RUN_SUMMARY: RunSummary = {
  ...SCHEDULED_RUN_SUMMARY,
  id: "run-2",
  forkedFrom: {
    runId: RUN_ID,
    stepId: "review",
    fromHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    toHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  },
};

/**
 * FR8: the same run on the non-default substrate. Kept out of the committed goldens, so `ls.json`
 * still proves a paseo run carries no `executor` key at all.
 */
export const HC_RUN_SUMMARY: RunSummary = {
  ...RUN_SUMMARY,
  executor: "hc",
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
    executors: [PASEO_EXECUTOR, HC_EXECUTOR],
    pendingGates: [PENDING_GATE],
    runs: { total: 1, active: 1 },
  };
}

/** FR9: the registry a stub server advertises — paseo is the default, hc is also reachable. */
export const PASEO_EXECUTOR: ExecutorInfo = {
  id: "paseo",
  default: true,
  reachable: true,
  capabilities: {
    structuredOutput: true,
    quota: true,
    interactiveBlocked: false,
    scheduleSafe: true,
  },
};

export const HC_EXECUTOR: ExecutorInfo = {
  id: "hc",
  default: false,
  reachable: true,
  version: "0.9.1",
  capabilities: {
    structuredOutput: false,
    quota: false,
    interactiveBlocked: true,
    scheduleSafe: true,
  },
};

/** `GET /db/stats` (`argos db stats`). Fixed sizes/counts; the goldens never touch a real file. */
export const DB_STATS: DbStats = {
  path: "/home/argos.sqlite",
  bytes: 12_345_678,
  walBytes: 4_194_304,
  pageSize: 4_096,
  pageCount: 3_014,
  freePages: 12,
  journalMode: "wal",
  runs: { total: 244, active: 1 },
  documents: {
    total: 535,
    live: 288,
    retired: 247,
    byKind: [
      { kind: "argos.gate", live: 33, retired: 3, bytes: 4_356 },
      { kind: "argos.history", live: 122, retired: 122, bytes: 30_146 },
      { kind: "argos.run", live: 122, retired: 122, bytes: 29_170 },
      { kind: "argos.runs", live: 1, retired: 0, bytes: 70 },
    ],
  },
  tasks: {
    total: 1_560,
    live: 4,
    terminal: 1_556,
    byKind: [
      { kind: "argos.delay", live: 0, terminal: 53, bytes: 29_499 },
      { kind: "argos.gate", live: 0, terminal: 36, bytes: 32_494 },
      { kind: "argos.run", live: 1, terminal: 247, bytes: 3_710_970 },
      { kind: "argos.script", live: 0, terminal: 961, bytes: 826_414 },
      { kind: "argos.step", live: 3, terminal: 259, bytes: 2_461_608 },
    ],
  },
  revisions: 288,
  entries: 0,
  conversations: 1,
  submissions: 0,
  receipts: { total: 12, expired: 4 },
};

/** `POST /db/purge` (`argos db purge`): three old runs, one live one skipped. */
export const DB_PURGE: DbPurgeResponse = {
  dryRun: false,
  olderThanMs: 2_592_000_000,
  removed: [
    { runId: "run-old-1", status: "completed", updatedAt: 1_790_000_000_000 },
    { runId: "run-old-2", status: "failed", updatedAt: 1_790_100_000_000 },
    {
      runId: "run-old-3",
      status: "cancelled",
      updatedAt: 1_790_200_000_000,
      worktree: "/home/worktrees/run-old-3",
    },
  ],
  skipped: [{ runId: "run-live", reason: "active" }],
  tasksRemoved: 42,
  receiptsRetired: 4,
  vacuumed: false,
  before: { bytes: 12_345_678, walBytes: 4_194_304 },
  after: { bytes: 11_010_048, walBytes: 0 },
};

/** `POST /db/vacuum` (`argos db vacuum`). */
export const DB_VACUUM: DbVacuumResponse = {
  vacuumed: true,
  before: { bytes: 12_345_678, walBytes: 4_194_304 },
  after: { bytes: 6_291_456, walBytes: 0 },
};

