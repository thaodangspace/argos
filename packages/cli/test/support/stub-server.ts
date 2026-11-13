/**
 * A tiny contract-shaped HTTP stub for the CLI tests. It is **not** the Argos server: it exists so
 * the CLI renderers can be snapshot-tested without a durable host, a database, or Paseo. Server
 * behavior itself is covered by `packages/core/test/rpc/server.test.ts` and the CLI sentinel test.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  DecideGateRequest,
  RunDetail,
  RunSummary,
  ScheduleCreateRequest,
  ScheduleSummary,
} from "@thaodangspace/argos-core/rpc";

import {
  DECIDED_AT,
  NEXT_FIRE_AT,
  RUN_DETAIL,
  RUN_ID,
  RUN_SUMMARY,
  SCHEDULE_DETAIL,
  SCHEDULE_SUMMARY,
  TASK_ID,
  serverInfo,
} from "./fixtures.js";

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

export interface StubServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

/**
 * Per-test overrides. The defaults are the committed fixtures, so `ls.json` (and every other
 * pre-existing golden) cannot move just because a new route exists.
 */
export interface StubOptions {
  /** `GET /runs`; the default is exactly `[RUN_SUMMARY]`. */
  readonly runs?: readonly RunSummary[];
  /** `GET /runs/:id`; the default is exactly `RUN_DETAIL`. */
  readonly detail?: RunDetail;
  /** `GET /schedules`; the default is exactly `[SCHEDULE_SUMMARY]`. */
  readonly schedules?: readonly ScheduleSummary[];
  /** Answer every `/schedules` request with a 500, so `argos doctor` reports the failure. */
  readonly failSchedules?: boolean;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export async function startStubServer(
  token = "stub-token",
  options: StubOptions = {},
): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const runs = options.runs ?? [RUN_SUMMARY];
  const detail = options.detail ?? RUN_DETAIL;
  const schedules = options.schedules ?? [SCHEDULE_SUMMARY];
  let port = 0;

  /**
   * `FR10.1` routes. Unknown id ⇒ 404 `schedule_unknown`, a duplicate create ⇒ 409
   * `schedule_exists`, and run-now ⇒ 201 unless the schedule already has a live run.
   */
  const handleSchedules = (
    segments: readonly string[],
    method: string | undefined,
    body: unknown,
    send: (status: number, value: unknown) => void,
    error: (status: number, code: string, message: string) => void,
  ): void => {
    if (segments.length === 1) {
      if (method === "GET") {
        send(200, { schedules });
        return;
      }
      if (method === "POST") {
        const request = (body ?? {}) as Partial<ScheduleCreateRequest>;
        if (
          request.id !== undefined &&
          schedules.some((candidate) => candidate.id === request.id)
        ) {
          error(409, "schedule_exists", `schedule "${request.id}" already exists`);
          return;
        }
        // Echo the requested id and `enabled` (and nothing else from the body: `cwd` and `tz` are
        // the caller's and would make the golden machine-dependent).
        const enabled = request.enabled ?? SCHEDULE_DETAIL.enabled;
        send(201, {
          ...SCHEDULE_DETAIL,
          ...(request.id === undefined ? {} : { id: request.id }),
          enabled,
          ...(enabled ? {} : { nextFireAt: null }),
        });
        return;
      }
      error(405, "method_not_allowed", "GET or POST");
      return;
    }

    const id = decodeURIComponent(segments[1] ?? "");
    const schedule = schedules.find((candidate) => candidate.id === id);
    if (schedule === undefined) {
      error(404, "schedule_unknown", `unknown schedule "${id}"`);
      return;
    }
    if (segments.length === 2) {
      if (method === "GET" || method === "POST") {
        send(200, SCHEDULE_DETAIL);
        return;
      }
      if (method === "DELETE") {
        send(200, { id, removed: true });
        return;
      }
      error(405, "method_not_allowed", "GET, POST, or DELETE");
      return;
    }
    if (segments.length === 3 && method === "POST") {
      if (segments[2] === "pause") {
        send(200, { ...schedule, enabled: false, nextFireAt: null });
        return;
      }
      if (segments[2] === "resume") {
        send(200, { ...schedule, enabled: true, nextFireAt: NEXT_FIRE_AT });
        return;
      }
      if (segments[2] === "run") {
        if (schedule.liveRunId !== undefined) {
          error(409, "run_active", `schedule "${id}" already has a live run ${schedule.liveRunId}`);
          return;
        }
        send(201, { runId: RUN_ID, taskId: TASK_ID });
        return;
      }
    }
    error(404, "not_found", "unknown route");
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      const authorization = typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
      requests.push({ method: req.method ?? "GET", path: url.pathname, body, authorization });

      const send = (status: number, value: unknown): void => {
        const text = JSON.stringify(value);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      };
      const error = (status: number, code: string, message: string): void => {
        send(status, { error: { code, message } });
      };

      if (authorization !== `Bearer ${token}`) {
        error(401, "unauthorized", "a valid bearer token is required");
        return;
      }
      const segments = url.pathname.split("/").filter((segment) => segment !== "");

      if (req.method === "GET" && segments[0] === "health") {
        send(200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && segments[0] === "info") {
        send(200, serverInfo(port));
        return;
      }
      if (req.method === "POST" && segments[0] === "worktrees" && segments[1] === "gc") {
        const request = body as { olderThan?: string } | undefined;
        if (request?.olderThan === undefined) {
          error(400, "invalid_request", "olderThan is required");
          return;
        }
        send(200, {
          removed: [{ runId: RUN_ID, path: "/home/worktrees/run-1", branchDeleted: false }],
          skipped: [{ runId: "run-2", reason: "active" }],
          orphans: ["/home/worktrees/orphan-1"],
        });
        return;
      }
      if (segments[0] === "schedules") {
        if (options.failSchedules === true) {
          error(500, "internal_error", "the schedule store is unavailable");
          return;
        }
        handleSchedules(segments, req.method, body, send, error);
        return;
      }
      if (segments[0] !== "runs") {
        error(404, "not_found", "unknown route");
        return;
      }
      if (segments.length === 1 && req.method === "POST") {
        const request = body as { playbookId?: string } | undefined;
        if (request?.playbookId === "missing") {
          error(400, "playbook_missing", 'unknown playbook "missing"');
          return;
        }
        send(201, { runId: RUN_ID, taskId: TASK_ID });
        return;
      }
      if (segments.length === 1 && req.method === "GET") {
        send(200, { runs });
        return;
      }
      if (segments[1] !== RUN_ID) {
        error(404, "run_unknown", `unknown run "${segments[1] ?? ""}"`);
        return;
      }
      if (segments.length === 2 && req.method === "GET") {
        send(200, detail);
        return;
      }
      if (segments.length === 2 && req.method === "DELETE") {
        send(200, { runId: RUN_ID, status: "completed", worktree: "/home/worktrees/run-1" });
        return;
      }
      if (segments.length === 3 && segments[2] === "cancel") {
        send(200, { runId: RUN_ID, status: "cancelled" });
        return;
      }
      if (segments.length === 3 && segments[2] === "retry") {
        send(201, { runId: RUN_ID, taskId: "12" });
        return;
      }
      if (segments.length === 3 && segments[2] === "fork") {
        // S-FR1: a fork is a new run id, unlike a retry.
        send(201, { runId: "run-2", taskId: "13" });
        return;
      }
      if (segments.length === 4 && segments[2] === "worktree" && segments[3] === "remove") {
        const request = body as { force?: boolean; deleteBranch?: boolean } | undefined;
        send(200, {
          runId: RUN_ID,
          path: "/home/worktrees/run-1",
          removed: true,
          branchDeleted: request?.deleteBranch === true,
        });
        return;
      }
      if (segments.length === 4 && segments[2] === "gates") {
        const decision = body as DecideGateRequest;
        send(200, {
          runId: RUN_ID,
          gateId: decodeURIComponent(segments[3] ?? ""),
          decision: decision.decision,
          ...(decision.comment === undefined ? {} : { comment: decision.comment }),
          ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
          ...(decision.decidedVia === undefined ? {} : { decidedVia: decision.decidedVia }),
          decidedAt: DECIDED_AT,
        });
        return;
      }
      error(404, "not_found", "unknown route");
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
