/**
 * `GET /playbooks` (spec FR4): the discovery + input-metadata route behind the UI's "Run workflow"
 * form. A real in-process server, real YAML files, and plain `fetch`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { PlaybookListResponseSchema, type PlaybookListResponse } from "../../src/rpc/contracts.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, type TempHome } from "../durable/support.js";

const TOKEN = "playbooks-test-token-0123456789";

interface Harness {
  server: RpcServer;
  home: TempHome;
  repo: string;
  roots: string[];
}

const open: Harness[] = [];

const RELEASE_YAML = `
title: Release
executor: hc
isolation: worktree
inputs:
  version:
    type: string
    required: true
    description: What to ship
  dry_run:
    type: boolean
    default: false
  channel:
    type: enum
    values: [stable, beta]
    default: stable
  API_KEY:
    type: string
    default: super-secret-value
steps:
  - id: build
    prompt: "Build {{ inputs.version }}"
  - id: ship
    prompt: "Ship it"
    needs: [build]
`;

const DOCS_YAML = `
title: Docs
inputs:
  topic:
    type: string
steps:
  - id: write
    prompt: "Write about {{ inputs.topic }}"
`;

const BROKEN_YAML = `
title: Broken
unknown_key_here: true
steps:
  - id: nope
    prompt: hi
`;

function writePlaybook(root: string, id: string, body: string): string {
  const dir = join(root, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.yaml`);
  writeFileSync(file, body, "utf8");
  return file;
}

async function start(): Promise<Harness> {
  const home = makeTempHome();
  const repo = mkdtempSync(join(tmpdir(), "argos-playbooks-"));
  const roots = [repo];
  writePlaybook(repo, "release", RELEASE_YAML);
  writePlaybook(repo, "docs", DOCS_YAML);
  writePlaybook(repo, "broken", BROKEN_YAML);

  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor: new FakeExecutor(),
  });
  const server = await createRpcServer({ host, home: home.home, port: 0, token: TOKEN, cwd: repo });
  const harness = { server, home, repo, roots };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.server.host.close();
    harness.home.cleanup();
    for (const root of harness.roots) rmSync(root, { recursive: true, force: true });
  }
});

async function list(
  h: Harness,
  query: string,
  options: { readonly token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${h.server.url}/playbooks?${query}`, {
    headers: { authorization: `Bearer ${options.token ?? TOKEN}` },
  });
  return { status: response.status, body: await response.json() };
}

describe("GET /playbooks", () => {
  it("lists playbooks with typed inputs and drops a secret-shaped default", async () => {
    const h = await start();
    const { status, body } = await list(h, `cwd=${encodeURIComponent(h.repo)}`);
    expect(status).toBe(200);
    const parsed: PlaybookListResponse = PlaybookListResponseSchema.parse(body);
    const ids = parsed.playbooks.map((playbook) => playbook.id).sort();
    expect(ids).toEqual(["docs", "release"]);

    const release = parsed.playbooks.find((playbook) => playbook.id === "release");
    expect(release).toBeDefined();
    expect(release?.executor).toBe("hc");
    expect(release?.isolation).toBe("worktree");
    expect(release?.stepCount).toBe(2);
    expect(release?.file.endsWith(join(".argos", "playbooks", "release.yaml"))).toBe(true);

    const byName = new Map(release?.inputs.map((input) => [input.name, input]));
    expect(byName.get("version")).toMatchObject({ type: "string", required: true });
    expect(byName.get("version")?.description).toBe("What to ship");
    expect(byName.get("dry_run")).toMatchObject({ type: "boolean", required: false, default: false });
    expect(byName.get("channel")).toMatchObject({
      type: "enum",
      values: ["stable", "beta"],
      default: "stable",
    });
    // A credential-shaped name is listed (the form must ask for it) but its default is never sent.
    expect(byName.get("API_KEY")).toMatchObject({ type: "string", required: false });
    expect(byName.get("API_KEY")?.default).toBeUndefined();

    // No prompt or step body may cross this boundary.
    expect(JSON.stringify(body)).not.toContain("Build it");
    expect(JSON.stringify(body)).not.toContain("Ship it");
  });

  it("reports a broken playbook per file while still listing the valid ones", async () => {
    const h = await start();
    const { status, body } = await list(h, `cwd=${encodeURIComponent(h.repo)}`);
    expect(status).toBe(200);
    const parsed = PlaybookListResponseSchema.parse(body);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.file.endsWith("broken.yaml")).toBe(true);
    expect(parsed.errors[0]?.code).toBe("playbook_invalid");
    expect(parsed.playbooks.map((playbook) => playbook.id)).not.toContain("broken");
  });

  it("includes a playbook from the host home", async () => {
    const h = await start();
    const homePlaybooks = join(h.home.home, "playbooks");
    mkdirSync(homePlaybooks, { recursive: true });
    writeFileSync(join(homePlaybooks, "shared.yaml"), DOCS_YAML, "utf8");

    const { body } = await list(h, `cwd=${encodeURIComponent(h.repo)}`);
    const parsed = PlaybookListResponseSchema.parse(body);
    expect(parsed.playbooks.map((playbook) => playbook.id)).toContain("shared");
  });

  it("refuses an invalid cwd with invalid_request before discovery", async () => {
    const h = await start();
    const file = join(h.repo, "README.md");
    writeFileSync(file, "not a directory", "utf8");
    for (const cwd of ["relative/path", join(h.repo, "missing"), file, `${h.repo}\u0000x`]) {
      const { status, body } = await list(h, `cwd=${encodeURIComponent(cwd)}`);
      expect(status, cwd).toBe(400);
      expect((body as { error: { code: string } }).error.code).toBe("invalid_request");
    }
  });

  it("requires a token and is not swallowed by the run router", async () => {
    const h = await start();
    const anonymous = await fetch(`${h.server.url}/playbooks?cwd=${encodeURIComponent(h.repo)}`);
    expect(anonymous.status).toBe(401);

    const { status } = await list(h, `cwd=${encodeURIComponent(h.repo)}`);
    expect(status).toBe(200);
  });
});
