/**
 * The Paseo port — the whole seam between Argos and a Paseo daemon.
 *
 * The adapter (`agent-step.ts`) and every test speak only this interface, so no test imports
 * `@getpaseo/client`. The production implementation is `client.ts`; it is the **only** file in
 * the repository allowed to import the Paseo SDK (FR2/FR5, enforced by
 * `test/paseo/isolation.test.ts`).
 *
 * Values are deliberately plain data: ids, scalars, and JSON. The port never exposes an SDK
 * handle, a socket, or a class instance, so a fake is trivial and a checkpoint never depends on
 * SDK internals.
 *
 * Error taxonomy (the adapter maps every port error to a stable Argos code):
 *
 * | Port error                    | Argos code            | When                                          |
 * |-------------------------------|-----------------------|-----------------------------------------------|
 * | `PaseoUnreachableError`       | `paseo_unreachable`   | connect/auth lost, daemon down                |
 * | `LabelFilterUnsupportedError` | `launch_uncertain`    | label filter unsupported on a re-entry         |
 * | `QuotaError`                  | (fallback / exhausted) | usage limit, rate limit, credits             |
 * | `AgentMissingError`           | `agent_missing`       | archived/unknown after the handover attempt    |
 * | `ProviderTimeoutError`        | (parked / retried)    | `waitForFinish` timeout                       |
 */

// ------------------------------------------------------------------ agent values

/**
 * The Paseo agent statuses Argos distinguishes. `permission` is treated like `running` by the
 * adapter (a human must unblock it; the step deadline still bounds the wait).
 */
export type PaseoAgentStatus =
  | "initializing"
  | "running"
  | "idle"
  | "error"
  | "permission"
  | "closed";

/** A created or listed agent. `target` is `provider/model` when the daemon knows it. */
export interface AgentRef {
  readonly agentId: string;
  readonly target?: string;
  readonly status?: PaseoAgentStatus;
  readonly archived?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

/** A refreshed agent snapshot. `output` is the provider's structured result when it has one. */
export interface AgentInfo {
  readonly agentId: string;
  readonly status: PaseoAgentStatus;
  readonly target?: string;
  readonly archived?: boolean;
  /** Structured provider output (already a JSON value), or `undefined` for plain text. */
  readonly output?: unknown;
  readonly lastMessage?: string | null;
  readonly error?: string | null;
  readonly usage?: Readonly<Record<string, number>>;
}

/** Agent provider settings for one launch. `provider` is `provider/model`. */
export interface PaseoAgentConfig {
  readonly provider: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
}

export interface CreateAgentInput {
  /** Idempotency key: `argos:<runId>:<stepId>:<attempt>`. */
  readonly requestId: string;
  readonly config: PaseoAgentConfig;
  readonly cwd: string;
  readonly prompt?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly title?: string;
}

export type FinishStatus = "idle" | "error" | "permission" | "timeout";

/**
 * Result of waiting for the current turn. `timeout` means the turn is still in flight — the
 * adapter parks the step and lets the step deadline decide whether to retry.
 */
export interface FinishResult {
  readonly status: FinishStatus;
  readonly final?: AgentInfo | null;
  readonly error?: string | null;
  readonly lastMessage?: string | null;
  /** Structured output when the provider honoured `outputSchema`. */
  readonly output?: unknown;
  readonly usage?: Readonly<Record<string, number>>;
}

// ------------------------------------------------------------------ provider catalog

export interface ProviderModel {
  readonly provider: string;
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly selectable?: boolean;
}

export interface ProviderEntry {
  readonly provider: string;
  readonly enabled: boolean;
  readonly models: readonly ProviderModel[];
  readonly error?: string;
}

/** What `providers.snapshot()` exposes: the catalog `model_unavailable` is checked against. */
export interface ProviderCatalog {
  readonly providers: readonly ProviderEntry[];
  readonly fetchedAt?: number;
}

// ------------------------------------------------------------------ the port

export interface PaseoPort {
  /**
   * Capability flag: can this daemon filter agents by label? When `false`, the adapter never
   * blind-relaunches after a crash (`launch_uncertain` instead), so "unsupported" can be told
   * apart from "no agent found".
   */
  readonly supportsLabelFilter: boolean;
  listByLabels(labels: Readonly<Record<string, string>>): Promise<AgentRef[]>;
  create(input: CreateAgentInput): Promise<AgentRef>;
  refresh(agentId: string): Promise<AgentInfo | null>;
  waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult>;
  archive(agentId: string): Promise<void>;
  providersSnapshot(): Promise<ProviderCatalog>;
}

// ------------------------------------------------------------------ errors

/** The daemon could not be reached, or rejected our credentials. */
export class PaseoUnreachableError extends Error {
  readonly url: string | undefined;

  constructor(message: string, options: { readonly cause?: unknown; readonly url?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PaseoUnreachableError";
    this.url = options.url;
  }
}

/** The daemon does not support filtering agents by label. */
export class LabelFilterUnsupportedError extends Error {
  constructor(message = "the Paseo daemon does not support filtering agents by label") {
    super(message);
    this.name = "LabelFilterUnsupportedError";
  }
}

/** A quota / usage-limit error for one provider target (FR24). */
export class QuotaError extends Error {
  readonly target: string | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly target?: string;
      readonly code?: string;
      readonly retryAfterMs?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QuotaError";
    this.target = options.target;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The agent is unknown or archived. */
export class AgentMissingError extends Error {
  readonly agentId: string;

  constructor(agentId: string, message = `agent ${agentId} is unknown or archived`) {
    super(message);
    this.name = "AgentMissingError";
    this.agentId = agentId;
  }
}

/** `waitForFinish` did not observe a settled turn within the timeout. */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message = `agent did not finish within ${timeoutMs} ms`) {
    super(message);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ------------------------------------------------------------------ classification

/** Error codes / HTTP statuses that mean "quota" across the providers Argos targets. */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
  "rate_limit_exceeded",
  "rate_limited",
  "usage_limit_reached",
  "resource_exhausted",
  "billing_hard_limit_reached",
]);

const QUOTA_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bquota\b/i,
  /\busage limit\b/i,
  /\brate limit\b/i,
  /\btoo many requests\b/i,
  /\binsufficient (quota|credits|funds)\b/i,
  /\bcredit balance\b/i,
  /\bbilling (hard )?limit\b/i,
  /\bexceeded your current quota\b/i,
  /\bresource[ _-]exhausted\b/i,
  // Subscription CLIs (Claude Code, Codex) report the plan limit as plain text, e.g.
  // "You've hit your 5-hour limit · resets 1:50am (Asia/Saigon)" or "You've hit your weekly limit".
  /\bhit your\b[^.\n]{0,40}\blimit\b/i,
  /\b\d+[- ]hour limit\b/i,
  /\bweekly limit\b/i,
];

/** A final agent message longer than this is a real answer, never a bare usage-limit notice. */
const QUOTA_NOTICE_MAX_LENGTH = 1_000;

const CONNECTION_CODES = new Set([
  "DAEMON_CONNECTION_LOST",
  "DAEMON_REQUEST_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const CONNECTION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /connection (lost|refused|closed|reset|failed)/i,
  /socket hang up/i,
  /failed to connect/i,
  /cannot connect/i,
  /unable to connect/i,
  /websocket/i,
  /password_required/i,
  /incorrect_password/i,
  /timed out connecting/i,
];

const LABEL_FILTER_MESSAGE_PATTERNS: readonly RegExp[] = [
  /labels?[^.]{0,40}not (supported|implemented)/i,
  /(unknown|unsupported|invalid|unexpected)[^.]{0,20}(filter|parameter)[^.]{0,20}label/i,
  /label[^.]{0,20}(filter|filters)[^.]{0,20}(not supported|unsupported|unknown)/i,
];

const MISSING_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bnot found\b/i,
  /\bunknown agent\b/i,
  /agent[^.]{0,30}(does not exist|is missing)\b/i,
];

/** Pull `message`, `code`, and an HTTP-ish status out of an arbitrary thrown value. */
function errorFacts(error: unknown): { message: string; code: string | undefined; status: number | undefined } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const status = (error as Error & { status?: unknown }).status;
    return {
      message: error.message,
      code: typeof code === "string" ? code : undefined,
      status: typeof status === "number" ? status : undefined,
    };
  }
  return { message: String(error), code: undefined, status: undefined };
}

/** True when the thrown value is a quota / usage-limit failure (FR24, centralized). */
export function isQuotaError(error: unknown): boolean {
  if (error instanceof QuotaError) return true;
  const { message, code, status } = errorFacts(error);
  if (status === 429) return true;
  if (code !== undefined && QUOTA_CODES.has(code)) return true;
  return QUOTA_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when an agent's final message is a provider usage-limit notice instead of an answer. Some
 * providers finish the turn "successfully" with only that text, so it never surfaces as an error.
 * Callers only ask after the message failed the step's output schema, and long text never counts,
 * so a real answer that merely mentions a rate limit is not mistaken for one.
 */
export function isQuotaNotice(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > QUOTA_NOTICE_MAX_LENGTH) return false;
  return QUOTA_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** True when the daemon rejected a label filter as unsupported. */
export function isLabelFilterUnsupported(error: unknown): boolean {
  if (error instanceof LabelFilterUnsupportedError) return true;
  const { message } = errorFacts(error);
  return LABEL_FILTER_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when the thrown value is a connection/auth failure. */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof PaseoUnreachableError) return true;
  const { message, code, status } = errorFacts(error);
  if (code !== undefined && CONNECTION_CODES.has(code)) return true;
  if (status === 401 || status === 403) return true;
  return CONNECTION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when the thrown value says the agent is unknown or archived. */
export function isAgentMissing(error: unknown): boolean {
  if (error instanceof AgentMissingError) return true;
  const { message, status } = errorFacts(error);
  if (status === 404) return true;
  return MISSING_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Classification context: the target helps attribute a quota failure to a provider. */
export interface ClassifyContext {
  readonly target?: string;
  readonly url?: string;
}

/**
 * The one classifier every port error goes through. Returns a typed port error when the thrown
 * value matches a known category, otherwise the original value unchanged (the adapter treats it
 * as `step_failed`).
 */
export function classifyPaseoFailure(error: unknown, context: ClassifyContext = {}): unknown {
  if (
    error instanceof PaseoUnreachableError ||
    error instanceof LabelFilterUnsupportedError ||
    error instanceof QuotaError ||
    error instanceof AgentMissingError ||
    error instanceof ProviderTimeoutError
  ) {
    return error;
  }
  const { message, code } = errorFacts(error);
  if (isQuotaError(error)) {
    return new QuotaError(message, {
      cause: error,
      ...(context.target === undefined ? {} : { target: context.target }),
      ...(code === undefined ? {} : { code }),
    });
  }
  if (isLabelFilterUnsupported(error)) {
    return new LabelFilterUnsupportedError(message);
  }
  if (isConnectionError(error)) {
    return new PaseoUnreachableError(message, {
      cause: error,
      ...(context.url === undefined ? {} : { url: context.url }),
    });
  }
  if (isAgentMissing(error)) {
    return new AgentMissingError(context.target ?? "unknown", message);
  }
  return error;
}
