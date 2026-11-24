/**
 * `argos chart` (FR9–FR12, Phase 3).
 *
 * The command is the loader plus a renderer: discovery is `validatePlaybooks` (so these tests drive
 * a real temp repository rather than a fake), and `--run` is the one mode that talks to a server —
 * the stub, never a durable host. Every assertion here is about bytes a user sees: the fenced
 * Mermaid blocks, the JSON contract, the exit codes, and the fact that `--out` prints nothing.
 *
 * Update the golden deliberately with `UPDATE_GOLDEN=1 npx vitest run --project cli`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DecoratedGraph } from "@thaodangspace/argos-core/view";

import { runCli } from "../src/main.js";
import { capture, makeTempHome, withEnv, type TempHome } from "./support/cli.js";
import { CHART_RUN_DETAIL, RUN_DETAIL, RUN_ID } from "./support/fixtures.js";
import { startStubServer, type StubServer } from "./support/stub-server.js";

const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

const ALPHA = `title: Alpha
steps:
  - id: build
    prompt: Build it
  - id: ship
    needs: [build]
    prompt: Ship it
    on:
      success: { end: shipped }
`;

const BETA = `title: Beta
steps:
  - id: plan
    prompt: Plan it
  - id: approve
    title: Approval gate
    needs: [plan]
    gate:
      question: Ship it?
      choices:
        approved: { label: Approve }
        rejected: { label: Request changes, comment: required }
    on:
      rejected: { goto: plan }
`;

const BROKEN = `title: Broken
steps:
  - id: build
    title: Nothing to say
`;

interface Invoked {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Commit a stable `--json` shape as a golden file, like `json-shapes.test.ts`. */
function expectGolden(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(goldenDir, name);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  if (!existsSync(file)) throw new Error(`missing golden ${file}; run with UPDATE_GOLDEN=1`);
  expect(text).toBe(readFileSync(file, "utf8"));
}

const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argos-chart-"));
  scratch.push(dir);
  return dir;
}

function writeFile(dir: string, relativePath: string, body: string): string {
  const file = join(dir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** A repository whose `.argos/playbooks` holds exactly {@link ALPHA} and {@link BETA}. */
function twoPlaybookRepo(): string {
  const repo = tempDir();
  writeFile(repo, join(".argos", "playbooks", "alpha.yaml"), ALPHA);
  writeFile(repo, join(".argos", "playbooks", "beta.yaml"), BETA);
  return repo;
}

async function run(argv: readonly string[]): Promise<Invoked> {
  const captured = capture();
  const code = await runCli(argv, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

interface Running {
  readonly stub: StubServer;
  readonly home: TempHome;
  restore(): void;
  close(): Promise<void>;
}

let running: Running | undefined;

beforeEach(async () => {
  // The stub serves the detail *with* its projected graph, so `--run` asserts the annotation
  // rather than the plumbing.
  const stub = await startStubServer("stub-token", { detail: CHART_RUN_DETAIL });
  const home = makeTempHome(stub.token);
  const restore = withEnv({ ARGOS_HOME: home.home, ARGOS_PORT: String(stub.port) });
  running = {
    stub,
    home,
    restore,
    close: async () => {
      restore();
      await stub.close();
      home.cleanup();
    },
  };
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function current(): Running {
  if (running === undefined) throw new Error("stub server is not running");
  return running;
}

describe("argos chart (discovery)", () => {
  it("prints one fenced block per playbook, with a heading only when there are several", async () => {
    const repo = twoPlaybookRepo();
    const result = await run(["chart", repo]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.match(/```mermaid/g)).toHaveLength(2);
    expect(result.stdout).toContain("## alpha\n\n```mermaid\n");
    expect(result.stdout).toContain("## beta\n\n```mermaid\n");
    expect(result.stdout).toContain("flowchart LR");
    // The gate node keeps its shape and the loop is drawn as a dashed jump.
    expect(result.stdout).toContain('approve{{"Approval gate"}}');
    expect(result.stdout).toContain("approve -.->|rejected| plan");
    expect(result.stdout.endsWith("```\n")).toBe(true);
  });

  it("is byte-identical across runs", async () => {
    const repo = twoPlaybookRepo();
    const first = await run(["chart", repo]);
    const second = await run(["chart", repo]);
    expect(second.stdout).toBe(first.stdout);
  });

  it("narrows with --playbook, and a single playbook gets no heading", async () => {
    const repo = twoPlaybookRepo();
    const narrowed = await run(["chart", repo, "--playbook", "alpha"]);
    expect(narrowed.code, narrowed.stderr).toBe(0);
    expect(narrowed.stdout.match(/```mermaid/g)).toHaveLength(1);
    expect(narrowed.stdout).not.toContain("## ");
    expect(narrowed.stdout).toContain("argos playbook alpha");
    expect(narrowed.stdout).not.toContain("argos playbook beta");

    // A file argument charts that file, with the repository root inferred: same bytes.
    const file = await run(["chart", join(repo, ".argos", "playbooks", "alpha.yaml")]);
    expect(file.code, file.stderr).toBe(0);
    expect(file.stdout).toBe(narrowed.stdout);

    // An id nothing discovered is a validation failure, never an empty diagram.
    const missing = await run(["chart", repo, "--playbook", "gamma"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain('playbook_missing: no playbook "gamma"');
  });

  it("prints the contract-shaped JSON, and --json means --format json", async () => {
    const repo = twoPlaybookRepo();
    const discovery = await run(["chart", repo, "--json"]);
    expect(discovery.code, discovery.stderr).toBe(0);
    expect((await run(["chart", repo, "--format", "json"])).stdout).toBe(discovery.stdout);

    const runJson = await run(["chart", "--run", RUN_ID, "--json"]);
    expect(runJson.code, runJson.stderr).toBe(0);

    // One golden pins both new shapes: the discovered `{playbooks: [{id, hash, graph}]}` and the
    // decorated `{runId, graph}` that `--run` adds.
    expectGolden("chart.json", {
      discovery: JSON.parse(discovery.stdout) as unknown,
      run: JSON.parse(runJson.stdout) as unknown,
    });

    const report = JSON.parse(discovery.stdout) as {
      playbooks: Array<{ id: string; hash: string; graph: { nodes: unknown[] } }>;
    };
    expect(report.playbooks.map((playbook) => playbook.id)).toEqual(["alpha", "beta"]);
    for (const playbook of report.playbooks) {
      expect(playbook.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(playbook.graph.nodes.length).toBeGreaterThan(0);
    }

    // `--run` names the record and decorates every node the run reports, one status per step.
    const detail = JSON.parse(runJson.stdout) as { runId: string; graph: DecoratedGraph };
    expect(detail.runId).toBe(RUN_ID);
    expect(detail.graph.nodes.map((node) => [node.id, node.status, node.tone])).toEqual([
      ["draft", "completed", "success"],
      ["review", "completed", "success"],
      ["@end", undefined, undefined],
    ]);
  });

  it("writes the rendered text with --out and prints nothing", async () => {
    const repo = twoPlaybookRepo();
    const printed = await run(["chart", repo]);
    const target = join(tempDir(), "graph.mmd");

    const written = await run(["chart", repo, "--out", target]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toBe("");
    expect(readFileSync(target, "utf8")).toBe(printed.stdout);

    // A path that cannot be created is a clean runtime failure; nothing is silently dropped.
    const refused = await run(["chart", repo, "--out", join(target, "nested", "graph.mmd")]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("cannot write");
  });

  it("exits 2 with the file and step of a broken playbook, and prints no partial graph", async () => {
    const repo = twoPlaybookRepo();
    writeFile(repo, join(".argos", "playbooks", "broken.yaml"), BROKEN);

    const result = await run(["chart", repo]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("broken.yaml");
    expect(result.stderr).toContain("step build");
    expect(result.stderr).toContain("playbook_invalid");
  });

  it("rejects usage errors with exit 1, no stdout, and a message", async () => {
    const repo = twoPlaybookRepo();
    const cases: readonly (readonly string[])[] = [
      ["chart", repo, "--nope", "x"],
      ["chart", repo, "--format", "yaml"],
      ["chart", repo, "--direction", "RL"],
      ["chart", repo, "--json", "--format", "mermaid"],
      ["chart", repo, "--playbook"],
      ["chart", repo, "--run", RUN_ID],
      ["chart", "a", "b"],
    ];
    for (const argv of cases) {
      const result = await run(argv);
      const label = argv.join(" ");
      expect(result.code, label).toBe(1);
      expect(result.stdout, label).toBe("");
      expect(result.stderr, label).toContain("argos: ");
    }
  });
});

describe("argos chart --run", () => {
  it("annotates the run's graph with each step's status and tone", async () => {
    const result = await run(["chart", "--run", RUN_ID]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("flowchart LR");
    expect(result.stdout).toContain("argos playbook gated");
    expect(result.stdout).toContain("%% tones: ok");
    expect(result.stdout).toContain("classDef ok");
    expect(result.stdout).toContain("class draft ok");
    expect(result.stdout).toContain("class review ok");
    // One graph in the output, so no heading.
    expect(result.stdout).not.toContain("## ");
  });

  it("honours --direction TB", async () => {
    const result = await run(["chart", "--run", RUN_ID, "--direction", "TB"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("flowchart TB");
  });

  it("exits 1 for an unknown run", async () => {
    const result = await run(["chart", "--run", "run-nope"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("run_unknown");
  });

  it("exits 3 with the house message when the server is unreachable", async () => {
    await current().stub.close();
    const result = await run(["chart", "--run", RUN_ID]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("argos serve");
  });

  it("fails cleanly when the detail carries no graph (an older server)", async () => {
    // A second stub, because the fixture without `graph` is what an older server returns.
    const alt = await startStubServer("alt-token", { detail: RUN_DETAIL });
    const home = makeTempHome(alt.token);
    const restore = withEnv({ ARGOS_HOME: home.home, ARGOS_PORT: String(alt.port) });
    try {
      const result = await run(["chart", "--run", RUN_ID]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`graph unavailable for run ${RUN_ID}`);
    } finally {
      restore();
      await alt.close();
      home.cleanup();
    }
  });
});
