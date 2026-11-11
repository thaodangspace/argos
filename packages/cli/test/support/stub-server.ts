/**
 * A tiny contract-shaped HTTP stub for the CLI tests. It is **not** the Argos server: it exists so
 * the CLI renderers can be snapshot-tested without a durable host, a database, or Paseo. Server
 * behavior itself is covered by `packages/core/test/rpc/server.test.ts` and the CLI sentinel test.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { DecideGateRequest } from "argos-core/rpc";

import {
  DECIDED_AT,
  RUN_DETAIL,
  RUN_ID,
  RUN_SUMMARY,
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export async function startStubServer(token = "stub-token"): Promise<StubServer> {
  const requests: StubRequest[] = [];
  let port = 0;

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
        send(200, { runs: [RUN_SUMMARY] });
        return;
      }
      if (segments[1] !== RUN_ID) {
        error(404, "run_unknown", `unknown run "${segments[1] ?? ""}"`);
        return;
      }
      if (segments.length === 2 && req.method === "GET") {
        send(200, RUN_DETAIL);
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
