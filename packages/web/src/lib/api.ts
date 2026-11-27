/**
 * The one HTTP client the UI uses (spec FR11/FR14).
 *
 * Every response is validated against the contract schema it came from, so a server that drifts
 * fails loudly with `invalid_response` instead of rendering `undefined`. Failures become
 * {@link ArgosApiError} carrying the server's stable `code` — never a prose status — which is what
 * the toast/error surfaces match on.
 *
 * Same-origin by construction: the app is served by `argos serve` under `/ui`, and the browser
 * session is an HttpOnly cookie, so no Authorization header and no CORS are involved.
 */

import {
  CancelRunResponseSchema,
  ErrorResponseSchema,
  GateDecisionResponseSchema,
  PlaybookFileResponseSchema,
  PlaybookListResponseSchema,
  PlaybookSaveResponseSchema,
  PlaybookVerdictSchema,
  RunDetailSchema,
  RunListResponseSchema,
  ScheduleListResponseSchema,
  ServerInfoSchema,
  StartRunResponseSchema,
  type CancelRunResponse,
  type GateDecisionResponse,
  type PlaybookFileResponse,
  type PlaybookListResponse,
  type PlaybookSaveRequest,
  type PlaybookSaveResponse,
  type PlaybookValidateRequest,
  type PlaybookVerdict,
  type RunDetail,
  type RunListResponse,
  type RunSummary,
  type ScheduleSummary,
  type ServerInfo,
  type StartRunRequest,
  type StartRunResponse,
} from "@thaodangspace/argos-core/rpc/contracts";
import type { z } from "zod";

/**
 * The UI's stable failure shape: the server code when there is one.
 *
 * `details` is passed through as the error body's own record, so a surface that needs a reason
 * (`playbook_conflict`) reads it instead of re-parsing the message. It stays optional, so every
 * existing `new ArgosApiError(code, message, status)` call site is unchanged.
 */
export class ArgosApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArgosApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toApiError(error: unknown): ArgosApiError {
  if (error instanceof ArgosApiError) return error;
  if (error instanceof Error) return new ArgosApiError("internal_error", error.message, 0);
  return new ArgosApiError("internal_error", String(error), 0);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ArgosApiOptions {
  /** Prefix for tests; the browser uses "" (same origin). */
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** Called once per `createApi` instance on the first 401. Defaults to one reload per 10 s. */
  readonly onUnauthorized?: () => void;
}

export interface ArgosApi {
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail>;
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  cancelRun(runId: string): Promise<CancelRunResponse>;
  retryStep(runId: string, stepId: string): Promise<StartRunResponse>;
  forkRun(runId: string, stepId: string): Promise<StartRunResponse>;
  decideGate(
    runId: string,
    gateId: string,
    body: { readonly decision: string; readonly comment?: string; readonly clientRequestId?: string },
  ): Promise<GateDecisionResponse>;
  listPlaybooks(cwd: string): Promise<PlaybookListResponse>;
  /** The schedule roster: the rail uses the enabled ones to tell "in use" from "idle". */
  listSchedules(): Promise<ScheduleSummary[]>;
  info(): Promise<ServerInfo>;
}

/**
 * The playbook editor's surface (editor spec FR20–FR25): read one file with its digest, validate a
 * buffer, and save it. A separate interface on purpose — `ArgosApi` is what every screen already
 * consumes, and a client (or a test fake) that predates the editor keeps implementing exactly it.
 */
export interface PlaybookApi {
  /**
   * The discovered playbooks of one directory. With no `cwd` the server answers for its own working
   * directory and echoes it in `cwd`, which is the editor's fallback scope (editor spec FR21).
   */
  listPlaybooks(cwd?: string): Promise<PlaybookListResponse>;
  /** One discovered playbook's raw text, digest, and verdict (`GET /playbooks/file`). */
  getPlaybookFile(
    query: { readonly cwd: string; readonly file: string; readonly graph?: boolean },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlaybookFileResponse>;
  /** The verdict for a buffer, writing nothing (`POST /playbooks/validate`). */
  validatePlaybook(
    request: PlaybookValidateRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlaybookVerdict>;
  /** Validate then write one playbook atomically (`PUT /playbooks/file`). */
  savePlaybook(
    request: PlaybookSaveRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlaybookSaveResponse>;
}

/** What {@link createApi} returns: the run/schedule client plus the editor's calls. */
export type ArgosClient = ArgosApi & PlaybookApi;

const RELOAD_KEY = "argos:ui:reloaded-at";
const RELOAD_COOLDOWN_MS = 10_000;

/**
 * A stale session (server restarted) answers 401. Reloading `/ui/` issues a fresh cookie, but a
 * loop would freeze the page, so a reload is allowed at most once per 10 seconds. In a non-browser
 * environment (tests) this is a no-op.
 */
export function reloadForSession(): void {
  if (typeof window === "undefined" || typeof sessionStorage === "undefined") return;
  const now = Date.now();
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? "0");
  if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return;
  sessionStorage.setItem(RELOAD_KEY, String(now));
  window.location.reload();
}

export function createApi(options: ArgosApiOptions = {}): ArgosClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? "";
  const onUnauthorized = options.onUnauthorized ?? reloadForSession;
  let unauthorizedSent = false;

  const notifyUnauthorized = (): void => {
    if (unauthorizedSent) return;
    unauthorizedSent = true;
    onUnauthorized();
  };

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: { readonly method?: string; readonly body?: unknown; readonly signal?: AbortSignal },
  ): Promise<T> {
    const hasBody = init?.body !== undefined;
    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: init?.method ?? "GET",
        credentials: "same-origin",
        ...(hasBody ? { headers: { "content-type": "application/json" } } : {}),
        ...(hasBody ? { body: JSON.stringify(init?.body) } : {}),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      };
      response = await fetchImpl(`${baseUrl}${path}`, requestInit);
    } catch (error) {
      // A refused connection is the "argos serve is not running" state, not a process crash.
      throw new ArgosApiError(
        "unreachable",
        error instanceof Error ? error.message : String(error),
        0,
      );
    }

    if (response.status === 401) notifyUnauthorized();

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(body);
      if (parsed.success) {
        throw new ArgosApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
          parsed.data.error.details,
        );
      }
      throw new ArgosApiError(
        "internal_error",
        `HTTP ${String(response.status)} ${response.statusText}`.trim(),
        response.status,
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ArgosApiError(
        "invalid_response",
        `the server response for ${path} does not match the contract`,
        response.status,
      );
    }
    return parsed.data;
  }

  return {
    listRuns: () =>
      request("/runs", RunListResponseSchema).then((body: RunListResponse) => body.runs),
    getRun: (runId) => request(`/runs/${encodeURIComponent(runId)}`, RunDetailSchema),
    startRun: (body) =>
      request("/runs", StartRunResponseSchema, { method: "POST", body }),
    cancelRun: (runId) =>
      request(`/runs/${encodeURIComponent(runId)}/cancel`, CancelRunResponseSchema, {
        method: "POST",
        body: {},
      }),
    retryStep: (runId, stepId) =>
      request(`/runs/${encodeURIComponent(runId)}/retry`, StartRunResponseSchema, {
        method: "POST",
        body: { stepId },
      }),
    forkRun: (runId, stepId) =>
      request(`/runs/${encodeURIComponent(runId)}/fork`, StartRunResponseSchema, {
        method: "POST",
        body: { stepId },
      }),
    decideGate: (runId, gateId, body) =>
      request(
        `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}`,
        GateDecisionResponseSchema,
        { method: "POST", body },
      ),
    listPlaybooks: (cwd?: string) =>
      request(
        cwd === undefined ? "/playbooks" : `/playbooks?cwd=${encodeURIComponent(cwd)}`,
        PlaybookListResponseSchema,
      ),
    getPlaybookFile: (query, options) => {
      const params = new URLSearchParams({ cwd: query.cwd, file: query.file });
      if (query.graph === true) params.set("graph", "1");
      return request(
        `/playbooks/file?${params.toString()}`,
        PlaybookFileResponseSchema,
        options?.signal === undefined ? undefined : { signal: options.signal },
      );
    },
    validatePlaybook: (body, options) =>
      request("/playbooks/validate", PlaybookVerdictSchema, {
        method: "POST",
        body,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
    savePlaybook: (body, options) =>
      request("/playbooks/file", PlaybookSaveResponseSchema, {
        method: "PUT",
        body,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
    listSchedules: async () => (await request("/schedules", ScheduleListResponseSchema)).schedules,
    info: () => request("/info", ServerInfoSchema),
  };
}
