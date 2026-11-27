/**
 * The API client's contract behavior (spec FR14): schema validation, stable codes, the 401 hook.
 */

import { describe, expect, it, vi } from "vitest";

import { ArgosApiError, createApi } from "./api.js";

const summary = {
  id: "01J0000000000000000000000A",
  playbookId: "release",
  playbookHash: "h",
  status: "running",
  inputs: {},
  cwd: "/repo",
  steps: [],
  gates: [],
  after: [],
  createdAt: 1,
  updatedAt: 2,
  seq: 1,
};

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  it("parses a valid list response", async () => {
    const api = createApi({
      fetchImpl: async () => response({ runs: [summary] }),
    });
    await expect(api.listRuns()).resolves.toHaveLength(1);
  });

  it("parses a run detail whose attempts carry detail, exitCode, and stream tails (FR5)", async () => {
    const api = createApi({
      fetchImpl: async () =>
        response({
          ...summary,
          steps: [
            {
              id: "run",
              title: "Run",
              kind: "script",
              status: "failed",
              attemptCount: 1,
              attempts: [
                {
                  n: 1,
                  startedAt: 1,
                  endedAt: 2,
                  outcome: "failed",
                  errorCode: "step_failed",
                  detail: "the script exited 3: Fetch failed: HTTP 503",
                  exitCode: 3,
                  streams: { stderr: "… (truncated)\nFetch failed: HTTP 503\n" },
                },
              ],
            },
          ],
          history: [],
        }),
    });

    const run = await api.getRun("01J0000000000000000000000A");
    expect(run.steps[0]?.attempts[0]).toMatchObject({
      exitCode: 3,
      detail: "the script exited 3: Fetch failed: HTTP 503",
      streams: { stderr: "… (truncated)\nFetch failed: HTTP 503\n" },
    });
  });

  it("still parses a run detail without the additive attempt fields (older server)", async () => {
    const api = createApi({
      fetchImpl: async () =>
        response({
          ...summary,
          steps: [
            {
              id: "a",
              title: "A",
              kind: "agent",
              status: "completed",
              attemptCount: 1,
              attempts: [{ n: 1, startedAt: 1, endedAt: 2, outcome: "completed" }],
            },
          ],
          history: [],
        }),
    });

    const run = await api.getRun("01J0000000000000000000000A");
    const attempt = run.steps[0]?.attempts[0] as unknown as Record<string, unknown>;
    expect(attempt["detail"]).toBeUndefined();
    expect(attempt["exitCode"]).toBeUndefined();
    expect(attempt["streams"]).toBeUndefined();
  });

  it("maps an error body to its stable code and status", async () => {
    const api = createApi({
      fetchImpl: async () => response({ error: { code: "gate_already_decided", message: "taken" } }, 409),
    });
    await expect(api.decideGate("r", "g", { decision: "approve" })).rejects.toMatchObject({
      code: "gate_already_decided",
      status: 409,
    });
  });

  it("maps a non-JSON error body to internal_error", async () => {
    const api = createApi({ fetchImpl: async () => new Response("nope", { status: 502 }) });
    const error = await api.listRuns().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArgosApiError);
    expect((error as ArgosApiError).code).toBe("internal_error");
    expect((error as ArgosApiError).status).toBe(502);
  });

  it("refuses a response that does not match the contract", async () => {
    const api = createApi({ fetchImpl: async () => response({ runs: [{ nope: true }] }) });
    await expect(api.listRuns()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports a refused connection as unreachable", async () => {
    const api = createApi({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(api.listRuns()).rejects.toMatchObject({ code: "unreachable", status: 0 });
  });

  it("calls the unauthorized hook once per client", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({
      fetchImpl: async () => response({ error: { code: "unauthorized", message: "no" } }, 401),
      onUnauthorized,
    });
    await api.listRuns().catch(() => undefined);
    await api.listRuns().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("posts a start request as JSON with the same-origin credential mode", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = createApi({
      baseUrl: "http://test",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response({ runId: "r1", taskId: "t1" }, 201);
      },
    });
    await api.startRun({ playbookId: "release", cwd: "/repo", inputs: { n: 1 } });
    expect(calls[0]?.url).toBe("http://test/runs");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      playbookId: "release",
      cwd: "/repo",
      inputs: { n: 1 },
    });
  });

  it("encodes ids and the playbook cwd", async () => {
    const urls: string[] = [];
    const api = createApi({
      fetchImpl: async (url) => {
        urls.push(url);
        return response({ cwd: "/a b", playbooks: [], errors: [] });
      },
    });
    await api.listPlaybooks("/a b");
    expect(urls[0]).toBe(`/playbooks?cwd=${encodeURIComponent("/a b")}`);
  });
});
