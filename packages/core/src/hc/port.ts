/**
 * The herdr-core (`hc`) port — the whole seam between Argos and an hc core (FR25/FR27).
 *
 * The `hc` step executor (Phase 6), the catalog, and every test speak only this interface, so no
 * test opens a socket and the durable layer never depends on the client. The production
 * implementation is `client.ts`; it is the **only** file in the repository allowed to import
 * `node:net` (enforced by `test/hc/isolation.test.ts`).
 *
 * `hc` is a JSON-RPC 2.0 terminal host (protocol generation 1, `hc` 0.1.21): plain mode is one
 * JSON object per line, params by name. Values here keep hc's own field names (`exit_code`,
 * `created_ms`, `first_message`) and are plain JSON data — no socket, no class handle, no Paseo
 * type — so a fake is trivial and a checkpoint never depends on transport internals. Fields hc may
 * omit are normalized to `null` (or `0` for `turn`) by the client, so consumers never guess.
 *
 * `hello()` is an addition to the plan's eight methods: FR27/FR9 need the protocol generation and
 * the core's version to refuse an `incompatible`/`unsupported_generation` core at registry build
 * time instead of failing inside a step.
 *
 * Error taxonomy (the adapter maps every port error to a stable Argos code through
 * {@link hcFailureCode}):
 *
 * | Port error           | Argos code                                | When                                  |
 * |----------------------|-------------------------------------------|---------------------------------------|
 * | `HcTransportError`   | `executor_unreachable`                    | connect/read/write/timeout/closed     |
 * | `HcKindError`        | `classifyHcKind(kind)` (table below)      | a JSON-RPC error with `data.kind`     |
 */

import type { ArgosErrorCode } from "../errors.js";

/** The protocol generation this client speaks. `hello().generation` says what the core speaks. */
export const HC_PROTOCOL_GENERATION = 1;

/** Longest error text Argos keeps from one failure (no hc message, no hint, no params). */
export const HC_ERROR_TEXT_LIMIT = 200;

// ------------------------------------------------------------------ core values

/** A core's permanent id and display name. */
export interface HcCoreInfo {
  readonly id: string;
  readonly name: string;
}

/**
 * `hello` — FR27/FR9 handshake. `generation` is the protocol generation the core speaks and
 * `framed` is always `false` here: Argos stays in plain mode (one JSON object per line) and never
 * sends `framed: true`.
 */
export interface HcHello {
  readonly generation: number;
  readonly version: string;
  readonly core: HcCoreInfo;
  readonly framed: boolean;
  readonly methods: readonly string[];
  readonly features: readonly string[];
}

/** `server.status` — identity, version, and terminal counts (`argos doctor`, FR9). */
export interface HcServerStatus {
  readonly core: HcCoreInfo;
  readonly pid: number;
  readonly version: string;
  readonly uptimeMs: number;
  readonly live: number;
  readonly finished: number;
}

/** One `templates.list` entry; `error` is set when the template file cannot be used. */
export interface HcTemplate {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly error: string | null;
}

// ------------------------------------------------------------------ terminals

/** The status words Argos distinguishes (hc: "the program's own word; nothing is translated"). */
export type HcProgramState = "idle" | "working" | "done" | "blocked" | "error";

/** One OSC 7501 record. `state` stays a string because a program may report its own word. */
export interface HcTerminalStatus {
  readonly state: string;
  readonly msg: string | null;
  readonly title: string | null;
  /** `permission`, `question`, or `auth` — set for `blocked` only, when the program said. */
  readonly kind: string | null;
  readonly progress: number | null;
}

/** Whether a template's first message went in (FR20: `sent === false` means "not submitted"). */
export interface HcFirstMessage {
  readonly sent: boolean;
  readonly started: boolean | null;
  readonly turn: number | null;
  readonly reason: string | null;
}

/**
 * One terminal (`terminal.get`, `terminal.run`, `terminal.list`). Every field is present so the
 * adapter never has to tell "absent" from "null"; `status` is `null` once the program exited or
 * when it never reported.
 */
export interface HcTerminal {
  /** `t7`: stable on this core, and what every terminal-addressed method takes. */
  readonly address: string;
  readonly name: string | null;
  readonly state: "live" | "finished";
  readonly status: HcTerminalStatus | null;
  /** Goes up each time the status leaves `working`; `0` means nothing was ever submitted. */
  readonly turn: number;
  readonly exit_code: number | null;
  readonly signal: number | null;
  /** Why the program ended: `exited`, `killed`, `signaled`, `holder_lost`, `stopped_by_restart`, … */
  readonly reason: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pid: number | null;
  readonly created_ms: number;
  readonly finished_ms: number | null;
  /** `exact`, or `inexact` after a core crash (older history may be missing). */
  readonly screen: string;
  readonly title: string;
  /** Whether the program ever sent a 7501 report (a program that never does never completes). */
  readonly reported: boolean;
  /** The template that started it, when there was one. */
  readonly template: string | null;
  readonly first_message: HcFirstMessage | null;
}

/** `terminal.run` input. Names and units are hc's own; `timeout` is **seconds**. */
export interface HcRunInput {
  /** Program and arguments, or a template name followed by its task (FR19). */
  readonly argv: readonly string[];
  /** Working directory; hc defaults to the core's. */
  readonly cwd?: string;
  /** 1–32 of `[a-z0-9-_]`, unique among live terminals. */
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** Overrides the core's environment; never carries `ARGOS_*` names (NFR Security). */
  readonly env?: Readonly<Record<string, string>>;
  /** A shell line instead of `argv` (`sh -c`). */
  readonly line?: string;
  readonly size?: { readonly cols: number; readonly rows: number };
  /** Replace a lost program with a shell in place; never re-runs the original command. */
  readonly keep?: boolean;
  /**
   * Remove the terminal right after it exits. Argos never passes this at launch (FR26): a crash
   * window needs the record to adopt, and settle removes the terminal itself.
   */
  readonly rm?: boolean;
  /** Wait until the program stops working and return its text in `output`. */
  readonly wait?: boolean;
  /** Seconds before a wait checks in (hc default: config, else 180). */
  readonly timeout?: number;
}

/** `terminal.run` result: the terminal plus the waited text. */
export interface HcRunResult extends HcTerminal {
  readonly output: string | null;
}

/** `terminal.list` filter: live only unless `all`, and every label must match. */
export interface HcListOptions {
  readonly all?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

/** `terminal.send` input (FR20: the prompt goes in with `if: "idle"`). */
export interface HcSendInput {
  /** Address, name, or `machine/t7`. */
  readonly terminal: string;
  readonly text: string;
  /** Only type when the status is exactly this word. */
  readonly if?: "idle" | "working";
  /** Type even when the program is blocked (it may answer its dialog). */
  readonly force?: boolean;
  readonly wait?: boolean;
  /** Seconds before a wait checks in. */
  readonly timeout?: number;
}

/** `terminal.send` result. `started` is `null` when the program never reports status. */
export interface HcSendResult {
  readonly turn: number;
  readonly status: string | null;
  readonly started: boolean | null;
}

/** `terminal.read` options: lines of history above the screen. */
export interface HcReadOptions {
  readonly lines?: number;
}

/** `terminal.read` result: text plus how complete it is. */
export interface HcReadResult {
  readonly text: string;
  readonly complete: boolean;
  readonly how: string;
  readonly why: string | null;
}

/** `terminal.rm` result. hc 0.1.21 answers with the removed terminal's address. */
export interface HcRemoveResult {
  readonly removed: string;
}

// ------------------------------------------------------------------ the port

export interface HcPort {
  /** FR27/FR9: protocol generation, versions, methods, and features. */
  hello(): Promise<HcHello>;
  serverStatus(): Promise<HcServerStatus>;
  /** FR18: the catalog of `hc/<template>` targets. */
  templatesList(): Promise<HcTemplate[]>;
  runTerminal(input: HcRunInput): Promise<HcRunResult>;
  getTerminal(terminal: string): Promise<HcTerminal>;
  listTerminals(options?: HcListOptions): Promise<HcTerminal[]>;
  sendText(input: HcSendInput): Promise<HcSendResult>;
  readTerminal(terminal: string, options?: HcReadOptions): Promise<HcReadResult>;
  removeTerminal(terminal: string): Promise<HcRemoveResult>;
}

// ------------------------------------------------------------------ errors

/** Bound one message so no error can grow with a payload. */
function bounded(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= HC_ERROR_TEXT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, HC_ERROR_TEXT_LIMIT - 1)}…`;
}

/**
 * The core could not be reached, the socket failed, a call timed out, or the client was closed.
 * The CLI/host maps this to `executor_unreachable` (503); `argosCode` saves every caller from
 * re-deriving that.
 */
export class HcTransportError extends Error {
  readonly socket: string | undefined;
  readonly argosCode: "executor_unreachable" = "executor_unreachable";

  constructor(
    message: string,
    options: { readonly cause?: unknown; readonly socket?: string } = {},
  ) {
    super(bounded(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HcTransportError";
    this.socket = options.socket;
  }
}

/**
 * A JSON-RPC error response. `kind` is hc's stable `data.kind`; hc's `message` and `data.hint`
 * are deliberately dropped (they echo parameters and prompt text — NFR Privacy), and the kind is
 * never part of `message` either, so a log or a database row cannot leak it by accident.
 */
export class HcKindError extends Error {
  readonly kind: HcErrorKind;
  /** The JSON-RPC method that failed. Never a parameter value. */
  readonly method: string;
  /** The stable Argos code for this kind (FR25), precomputed from the one table. */
  readonly argosCode: ArgosErrorCode;

  constructor(kind: HcErrorKind, method: string, options: { readonly cause?: unknown } = {}) {
    super(
      bounded(`hc ${method} failed`),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "HcKindError";
    this.kind = kind;
    this.method = method;
    this.argosCode = classifyHcKind(kind);
  }
}

/** True for a transport failure (connect/read/write/timeout/closed). */
export function isHcTransportError(value: unknown): value is HcTransportError {
  return value instanceof HcTransportError;
}

/** True for a JSON-RPC error response carrying an hc `kind`. */
export function isHcKindError(value: unknown): value is HcKindError {
  return value instanceof HcKindError;
}

// ------------------------------------------------------------------ kind classification

/**
 * Every `kind` in the spec's FR25 list. hc may add kinds; an unknown one normalizes to
 * `"unknown"`, which maps like a protocol mismatch instead of escaping the typed surface.
 */
export const HC_ERROR_KINDS = [
  "not_found",
  "machine_unknown",
  "name_taken",
  "blocked",
  "status_mismatch",
  "finished",
  "live",
  "invalid_params",
  "unavailable",
  "unreachable",
  "spawn_failed",
  "conflict",
  "hc_missing",
  "incompatible",
  "unsupported_generation",
  "needs_update",
] as const;

export type HcErrorKind = (typeof HC_ERROR_KINDS)[number] | "unknown";

const HC_KIND_SET: ReadonlySet<string> = new Set<string>(HC_ERROR_KINDS);

/** Normalize a wire `data.kind` to the typed vocabulary (`"unknown"` for anything new). */
export function normalizeHcKind(value: unknown): HcErrorKind {
  if (typeof value !== "string") return "unknown";
  const kind = value.trim();
  return HC_KIND_SET.has(kind) ? (kind as HcErrorKind) : "unknown";
}

/**
 * FR25, the one table. Every hc kind maps to a stable Argos code:
 *
 * - `unreachable` — the socket/machine cannot be reached → `executor_unreachable` (503).
 * - `hc_missing`, `incompatible`, `unsupported_generation`, `needs_update`, `unavailable` — this
 *   core cannot serve Argos (not installed, wrong protocol generation, degraded) →
 *   `executor_unavailable` (422). `unknown` (a kind this Argos has never seen, or a JSON-RPC
 *   method error) means the protocol moved under us, so it lands here too.
 * - `not_found`, `machine_unknown` — the terminal (or the machine holding it) is gone →
 *   `agent_missing`, which is the code the adapter's handover path already understands. The raw
 *   `kind` stays on the error so the two can be told apart.
 * - `name_taken` — the name already exists; the adapter adopts it, and a failed adoption is
 *   `launch_uncertain` (never a blind relaunch).
 * - everything else (`blocked`, `status_mismatch`, `finished`, `live`, `invalid_params`,
 *   `spawn_failed`, `conflict`) is a failure of this attempt → `step_failed`.
 */
const HC_KIND_CODES: Readonly<Record<HcErrorKind, ArgosErrorCode>> = {
  not_found: "agent_missing",
  machine_unknown: "agent_missing",
  name_taken: "launch_uncertain",
  blocked: "step_failed",
  status_mismatch: "step_failed",
  finished: "step_failed",
  live: "step_failed",
  invalid_params: "step_failed",
  unavailable: "executor_unavailable",
  unreachable: "executor_unreachable",
  spawn_failed: "step_failed",
  conflict: "step_failed",
  hc_missing: "executor_unavailable",
  incompatible: "executor_unavailable",
  unsupported_generation: "executor_unavailable",
  needs_update: "executor_unavailable",
  unknown: "executor_unavailable",
};

/** The stable Argos code for one hc `kind` (FR25). */
export function classifyHcKind(kind: HcErrorKind): ArgosErrorCode {
  return HC_KIND_CODES[kind];
}

/**
 * The single mapping every hc failure goes through: a kind error uses its table row, a transport
 * error is `executor_unreachable`, and anything else is the caller's fallback (the adapter's
 * `step_failed`).
 */
export function hcFailureCode(
  error: unknown,
  fallback: ArgosErrorCode = "step_failed",
): ArgosErrorCode {
  if (isHcKindError(error)) return error.argosCode;
  if (isHcTransportError(error)) return "executor_unreachable";
  return fallback;
}
