/**
 * `argos schedule` (FR10.2) — the operator's view of the scheduler.
 *
 * Parsed by hand in the same shape as `commands/worktree.ts` (no dependency, one request per
 * invocation) and every call goes through `argos serve`: the CLI never opens SQLite and never arms
 * a timer. `cwd` and `tz` are filled from the caller's process, because a schedule is unattended
 * execution — the target must not depend on how `argos serve` was started, nor on the zone of
 * whichever machine happens to notice the fire (FR2.5).
 *
 * Only `@thaodangspace/argos-core/rpc` is imported here (the import-graph guard depends on it).
 */

import { resolve } from "node:path";

import type {
  RpcClient,
  Scalar,
  ScheduleCreateRequest,
  ScheduleDetail,
  ScheduleEditRequest,
  ScheduleFire,
  ScheduleSummary,
} from "@thaodangspace/argos-core/rpc";

import { flag, flagValues, hasFlag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, type CliIo } from "../output.js";
import { withRpc, type RpcCommandResult } from "../rpc-command.js";

// ------------------------------------------------------------------ parsing

/** Flags `add` and `edit` share; `add` additionally takes `--id` and `--paused`. */
const FIELD_FLAGS = [
  "cron",
  "tz",
  "cwd",
  "input",
  "isolation",
  "overlap",
  "catch-up",
  "keep",
] as const;

/** The wire's catch-up input (`"all"`, milliseconds, or the CLI shorthand `90m`). */
type CatchUpField = NonNullable<ScheduleCreateRequest["catchUp"]>;

interface Fields {
  readonly cwd?: string;
  readonly tz?: string;
  readonly inputs?: Record<string, Scalar>;
  readonly isolation?: "none" | "worktree";
  readonly overlap?: "skip" | "allow";
  readonly catchUp?: CatchUpField;
  readonly keep?: number | "all";
}

type FieldsResult =
  | { readonly ok: true; readonly fields: Fields }
  | { readonly ok: false; readonly message: string };

/** The caller's zone, so a schedule means the same thing on every machine (FR2.5). */
function cliTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `all` stays a word; a bare number is milliseconds; a duration like `90m` goes as-is (FR3.5). */
function catchUpValue(raw: string): CatchUpField {
  if (raw === "all") return "all";
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** `all`, or a whole number from 1 to 1,000 — refused locally so no request is sent (FR9.1). */
function keepValue(raw: string): number | "all" | undefined {
  if (raw === "all") return "all";
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= 1_000 ? parsed : undefined;
}

/** Normalize and validate the shared flags once; every problem is a usage error (exit 1). */
function readFields(args: ParsedArgs): FieldsResult {
  const rawInputs = flagValues(args, "input");
  const inputs: Record<string, Scalar> = {};
  for (const pair of rawInputs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) return { ok: false, message: "--input expects k=v" };
    inputs[pair.slice(0, equals)] = pair.slice(equals + 1);
  }

  const rawIsolation = flag(args, "isolation");
  const isolation: "none" | "worktree" | undefined =
    rawIsolation === "none" || rawIsolation === "worktree" ? rawIsolation : undefined;
  if (rawIsolation !== undefined && isolation === undefined) {
    return { ok: false, message: "--isolation must be none or worktree" };
  }

  const rawOverlap = flag(args, "overlap");
  const overlap: "skip" | "allow" | undefined =
    rawOverlap === "skip" || rawOverlap === "allow" ? rawOverlap : undefined;
  if (rawOverlap !== undefined && overlap === undefined) {
    return { ok: false, message: "--overlap must be skip or allow" };
  }

  const rawKeep = flag(args, "keep");
  const keep = rawKeep === undefined ? undefined : keepValue(rawKeep);
  if (rawKeep !== undefined && keep === undefined) {
    return { ok: false, message: '--keep must be "all" or a whole number from 1 to 1000' };
  }

  const rawCatchUp = flag(args, "catch-up");
  const tz = flag(args, "tz");
  const cwd = flag(args, "cwd");
  return {
    ok: true,
    fields: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(tz === undefined ? {} : { tz }),
      ...(rawInputs.length === 0 ? {} : { inputs }),
      ...(isolation === undefined ? {} : { isolation }),
      ...(overlap === undefined ? {} : { overlap }),
      ...(rawCatchUp === undefined ? {} : { catchUp: catchUpValue(rawCatchUp) }),
      ...(keep === undefined ? {} : { keep }),
    },
  };
}

// ------------------------------------------------------------------ human output

function when(at: number | null | undefined): string {
  return at === undefined || at === null ? "-" : new Date(at).toISOString();
}

/** `started run 01J…`, `refused model_unavailable`, or `never` — never an input value. */
function fireSummary(fire: ScheduleFire | undefined): string {
  if (fire === undefined) return "never";
  const tail =
    fire.runId !== undefined
      ? ` run ${fire.runId}`
      : fire.errorCode === undefined || fire.errorCode === null
        ? ""
        : ` ${fire.errorCode}`;
  return `${fire.status}${tail} at ${when(fire.at)}`;
}

function catchUpLabel(value: ScheduleSummary["catchUp"]): string {
  return value === "all" ? "all" : `${value} ms`;
}

function keepLabel(value: ScheduleSummary["keep"]): string {
  return value === "all" ? "all" : String(value);
}

function lsHuman(schedules: readonly ScheduleSummary[]): string {
  if (schedules.length === 0) return "no schedules";
  const lines = [
    [
      "ID".padEnd(24),
      "STATE".padEnd(9),
      "PLAYBOOK".padEnd(20),
      "CRON".padEnd(14),
      "TZ".padEnd(20),
      "NEXT FIRE".padEnd(24),
      "LAST FIRE",
    ]
      .join(" ")
      .trimEnd(),
  ];
  for (const schedule of schedules) {
    lines.push(
      [
        schedule.id.padEnd(24),
        (schedule.enabled ? "enabled" : "paused").padEnd(9),
        schedule.playbookId.padEnd(20),
        schedule.cron.padEnd(14),
        schedule.tz.padEnd(20),
        when(schedule.nextFireAt).padEnd(24),
        fireSummary(schedule.lastFire),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function detailHuman(schedule: ScheduleDetail): string {
  // `liveRunId` is the newest run the schedule started; it may already be terminal, so the label
  // says "latest" and leaves the overlap decision to the fire path (FR5.2).
  const live = schedule.liveRunId === undefined ? "" : `; latest run ${schedule.liveRunId}`;
  const lines = [
    `schedule ${schedule.id} (${schedule.playbookId}) in ${schedule.cwd}`,
    `  state     ${schedule.enabled ? "enabled" : "paused"}${live}`,
    `  cron      ${schedule.cron} (${schedule.tz})`,
    `  next      ${when(schedule.nextFireAt)}`,
    `  last      ${fireSummary(schedule.lastFire)}`,
    `  policy    overlap ${schedule.overlap}; catch-up ${catchUpLabel(schedule.catchUp)};` +
      ` keep ${keepLabel(schedule.keep)}` +
      (schedule.isolation === undefined ? "" : `; isolation ${schedule.isolation}`),
    `  failures  ${schedule.consecutiveFailures}`,
    `  fires     ${schedule.fires.length}; recent runs ` +
      (schedule.recentRunIds.length === 0 ? "none" : schedule.recentRunIds.join(", ")),
  ];
  // Names only: the values of a schedule's inputs never reach the terminal (Security NFR).
  const inputNames = Object.keys(schedule.inputs);
  if (inputNames.length > 0) lines.push(`  inputs    ${inputNames.sort().join(", ")}`);
  return lines.join("\n");
}

function usage(io: CliIo, message: string): number {
  io.stderr(`argos: ${message}\n`);
  return EXIT_RUNTIME;
}

// ------------------------------------------------------------------ sub-commands

export async function scheduleCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const [sub, ...rest] = args.positionals;
  if (sub === "add") return addScheduleCommand(args, io, rest);
  if (sub === "ls") return lsScheduleCommand(args, io, rest);
  if (sub === "show") return showScheduleCommand(args, io, rest);
  if (sub === "edit") return editScheduleCommand(args, io, rest);
  if (sub === "pause" || sub === "resume" || sub === "run" || sub === "rm") {
    return idScheduleCommand(args, io, rest, sub);
  }
  return usage(
    io,
    "schedule needs a sub-command (add | ls | show <id> | edit <id> | pause <id> | resume <id> | run <id> | rm <id>)",
  );
}

async function addScheduleCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["id", "paused", ...FIELD_FLAGS]);
  if (unknown !== undefined) return usage(io, unknown);
  const playbookId = positionals[0];
  if (playbookId === undefined) {
    return usage(io, "schedule add needs a playbook id (argos schedule add <playbook> --cron <expr>)");
  }
  if (positionals.length > 1) return usage(io, "schedule add takes exactly one playbook id");
  const cron = flag(args, "cron");
  if (cron === undefined) return usage(io, "schedule add needs --cron <expr>");
  const parsed = readFields(args);
  if (!parsed.ok) return usage(io, parsed.message);
  const { fields } = parsed;
  const id = flag(args, "id");

  const request: ScheduleCreateRequest = {
    ...(id === undefined ? {} : { id }),
    playbook: playbookId,
    // FR2.5: an unattended run must not depend on the server's working directory.
    cwd: fields.cwd === undefined ? process.cwd() : resolve(fields.cwd),
    ...(fields.inputs === undefined ? {} : { inputs: fields.inputs }),
    ...(fields.isolation === undefined ? {} : { isolation: fields.isolation }),
    cron,
    tz: fields.tz ?? cliTimeZone(),
    ...(fields.overlap === undefined ? {} : { overlap: fields.overlap }),
    ...(fields.catchUp === undefined ? {} : { catchUp: fields.catchUp }),
    ...(fields.keep === undefined ? {} : { keep: fields.keep }),
    ...(hasFlag(args, "paused") ? { enabled: false } : {}),
  };

  return withRpc(io, args.json, async (client) => {
    const detail = await client.createSchedule(request);
    return {
      jsonValue: detail,
      human:
        `added schedule ${detail.id} (${detail.playbookId}) "${detail.cron}" ${detail.tz};` +
        ` next ${when(detail.nextFireAt)}${detail.enabled ? "" : " (paused)"}`,
    };
  });
}

async function lsScheduleCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) return usage(io, unknown);
  if (positionals.length > 0) return usage(io, "schedule ls takes no arguments");
  return withRpc(io, args.json, async (client) => {
    const response = await client.listSchedules();
    return { jsonValue: response, human: lsHuman(response.schedules) };
  });
}

async function showScheduleCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) return usage(io, unknown);
  const id = positionals[0];
  if (id === undefined) return usage(io, "schedule show needs a schedule id");
  if (positionals.length > 1) return usage(io, "schedule show takes exactly one schedule id");
  return withRpc(io, args.json, async (client) => {
    const detail = await client.getSchedule(id);
    return { jsonValue: detail, human: detailHuman(detail) };
  });
}

async function editScheduleCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, [...FIELD_FLAGS]);
  if (unknown !== undefined) return usage(io, unknown);
  const id = positionals[0];
  if (id === undefined) return usage(io, "schedule edit needs a schedule id");
  if (positionals.length > 1) return usage(io, "schedule edit takes exactly one schedule id");
  const parsed = readFields(args);
  if (!parsed.ok) return usage(io, parsed.message);
  const { fields } = parsed;
  const cron = flag(args, "cron");

  // FR7.2: an edit that changes nothing is a usage error, not a silent `generation` bump.
  const request: ScheduleEditRequest = {
    ...(fields.cwd === undefined ? {} : { cwd: resolve(fields.cwd) }),
    ...(fields.tz === undefined ? {} : { tz: fields.tz }),
    ...(fields.inputs === undefined ? {} : { inputs: fields.inputs }),
    ...(fields.isolation === undefined ? {} : { isolation: fields.isolation }),
    ...(cron === undefined ? {} : { cron }),
    ...(fields.overlap === undefined ? {} : { overlap: fields.overlap }),
    ...(fields.catchUp === undefined ? {} : { catchUp: fields.catchUp }),
    ...(fields.keep === undefined ? {} : { keep: fields.keep }),
  };
  if (Object.keys(request).length === 0) {
    return usage(
      io,
      "schedule edit needs at least one of --cron, --tz, --cwd, --input, --isolation, --overlap, --catch-up, --keep",
    );
  }

  return withRpc(io, args.json, async (client) => {
    const detail = await client.editSchedule(id, request);
    return {
      jsonValue: detail,
      human:
        `updated schedule ${detail.id} (${detail.playbookId}) "${detail.cron}" ${detail.tz};` +
        ` generation ${detail.generation}; next ${when(detail.nextFireAt)}`,
    };
  });
}

type IdAction = "pause" | "resume" | "run" | "rm";

const ID_ACTIONS: Readonly<
  Record<IdAction, (client: RpcClient, id: string) => Promise<RpcCommandResult>>
> = {
  pause: async (client, id) => {
    const summary = await client.pauseSchedule(id);
    return { jsonValue: summary, human: `paused schedule ${summary.id}` };
  },
  resume: async (client, id) => {
    const summary = await client.resumeSchedule(id);
    return {
      jsonValue: summary,
      human: `resumed schedule ${summary.id}; next ${when(summary.nextFireAt)}`,
    };
  },
  run: async (client, id) => {
    const started = await client.runSchedule(id);
    return {
      jsonValue: started,
      human: `started run ${started.runId} from schedule ${id} (task ${started.taskId})`,
    };
  },
  rm: async (client, id) => {
    const result = await client.removeSchedule(id);
    return { jsonValue: result, human: `removed schedule ${result.id}` };
  },
};

async function idScheduleCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
  action: IdAction,
): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) return usage(io, unknown);
  const id = positionals[0];
  if (id === undefined) return usage(io, `schedule ${action} needs a schedule id`);
  if (positionals.length > 1) return usage(io, `schedule ${action} takes exactly one schedule id`);
  const call = ID_ACTIONS[action];
  return withRpc(io, args.json, (client) => call(client, id));
}
