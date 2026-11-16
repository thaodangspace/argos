/**
 * The production-side fake herdr-core port (`src/hc/fake.ts`), the one `ARGOS_FAKE_EXECUTOR=hc`
 * selects in `argos serve` (Phase 7 verification 2 and 3).
 *
 * It is a different fake from `test/fakes/hc.ts`: that one is driven call-by-call by the adapter
 * suites, while this one has to behave like a real core for a whole playbook — settle by itself,
 * honour the block/release knobs, and survive a process restart by replaying `fake-hc.json` plus
 * the append-only creation ledger. The restart case is what the E2E proves with a real `SIGKILL`;
 * this suite proves the persistence contract in-process.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FAKE_HC_LAUNCHES_FILE,
  FAKE_HC_RESULT_TEXT,
  FAKE_HC_STATE_FILE,
  FAKE_HC_TEMPLATES,
  createFakeHcPort,
  type FakeHcLaunch,
} from "../../src/hc/fake.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "argos-fake-hc-"));
  directories.push(directory);
  return directory;
}

const LABELS = {
  "argos/launch": "argos:run-1:step1:1",
  "argos/run": "run-1",
  "argos/step": "step1",
  "argos/attempt": "1",
};

function readLaunches(directory: string): FakeHcLaunch[] {
  return readFileSync(join(directory, FAKE_HC_LAUNCHES_FILE), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeHcLaunch);
}

describe("the fake herdr-core port (ARGOS_FAKE_EXECUTOR=hc)", () => {
  it("answers the handshake the registry probes", async () => {
    const port = createFakeHcPort();
    await expect(port.hello()).resolves.toMatchObject({ generation: 1, framed: false });
    await expect(port.serverStatus()).resolves.toMatchObject({ live: 0, finished: 0 });
    const templates = await port.templatesList();
    expect(templates.map((template) => template.name)).toEqual([...FAKE_HC_TEMPLATES]);
    expect(templates.every((template) => template.error === null)).toBe(true);
  });

  it("runs a template once and settles it with exit code 0 and the fake result text", async () => {
    const port = createFakeHcPort({ templates: ["claude"] });
    const created = await port.runTerminal({
      argv: ["claude", "do the work"],
      cwd: "/repo",
      name: "argos-0123456789abcdef",
      labels: LABELS,
    });
    expect(created).toMatchObject({
      name: "argos-0123456789abcdef",
      state: "live",
      template: "claude",
      labels: LABELS,
      // The template's first message is its argv task, so the adapter never types it again (FR20).
      first_message: { sent: true },
    });
    expect(created.status?.state).toBe("working");

    const polled = await port.getTerminal("argos-0123456789abcdef");
    expect(polled.state).toBe("finished");
    expect(polled.exit_code).toBe(0);
    expect(polled.reason).toBe("exited");
    await expect(port.readTerminal(polled.address)).resolves.toMatchObject({
      text: FAKE_HC_RESULT_TEXT,
    });

    // `terminal.rm` never accepts a live terminal, and the settled one is collected once (FR26).
    await expect(port.removeTerminal(polled.address)).resolves.toEqual({ removed: polled.address });
    expect(port.removes).toEqual([polled.address]);
    await expect(port.getTerminal(polled.address)).rejects.toMatchObject({ kind: "not_found" });
    // The argv task is the delivery: nothing was typed afterwards (FR20).
    expect(port.sends).toEqual([]);
  });

  it("refuses a live duplicate name with name_taken (the adapter adopts instead)", async () => {
    const port = createFakeHcPort({ templates: ["claude"], completeAfterPolls: 0 });
    await port.runTerminal({ argv: ["claude"], name: "argos-same", labels: LABELS });
    await expect(
      port.runTerminal({ argv: ["claude"], name: "argos-same", labels: LABELS }),
    ).rejects.toMatchObject({ kind: "name_taken" });
    expect(await port.listTerminals()).toHaveLength(1);
  });

  it("holds the named step working until the release file exists", async () => {
    const directory = tempDir();
    const releaseFile = join(directory, "release");
    const port = createFakeHcPort({ templates: ["claude"], blockStep: "step2", releaseFile });
    const created = await port.runTerminal({
      argv: ["claude"],
      name: "argos-blocked",
      labels: { ...LABELS, "argos/step": "step2" },
    });
    // Checked on every poll, so the hold has no timer of its own.
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await port.getTerminal(created.address)).state).toBe("live");
    }
    writeFileSync(releaseFile, "released\n", "utf8");
    expect((await port.getTerminal(created.address)).state).toBe("finished");
  });

  it("persists terminals, labels, and the creation ledger so a restart adopts", async () => {
    const directory = tempDir();
    const first = createFakeHcPort({ statePath: directory, templates: ["claude"] });
    const created = await first.runTerminal({
      argv: ["claude", "do the work"],
      cwd: "/repo",
      name: "argos-restart",
      labels: LABELS,
    });
    expect(readLaunches(directory)).toHaveLength(1);

    // A new process (a new port instance) reads the same directory.
    const second = createFakeHcPort({ statePath: directory, templates: ["claude"] });
    const adopted = await second.listTerminals({
      all: true,
      labels: { "argos/launch": LABELS["argos/launch"] },
    });
    expect(adopted.map((terminal) => terminal.address)).toEqual([created.address]);
    expect(adopted[0]?.labels).toEqual(LABELS);
    // The snapshot is the authority for state: the terminal still finishes on this poll, and the
    // restart did not create a second one.
    expect((await second.getTerminal("argos-restart")).state).toBe("finished");
    expect(readLaunches(directory)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, FAKE_HC_STATE_FILE), "utf8"))).toMatchObject({
      version: 1,
    });
    expect(readLaunches(directory)[0]).toMatchObject({
      requestId: LABELS["argos/launch"],
      stepId: "step1",
      attempt: 1,
      name: "argos-restart",
      template: "claude",
      pid: process.pid,
    });
  });

  it("adopts a creation whose snapshot write was lost (the ledger is append-only)", async () => {
    const directory = tempDir();
    const port = createFakeHcPort({ statePath: directory, templates: ["claude"] });
    const created = await port.runTerminal({ argv: ["claude"], name: "argos-torn", labels: LABELS });
    // Model a kill between the ledger append and the snapshot rewrite.
    writeFileSync(
      join(directory, FAKE_HC_STATE_FILE),
      `${JSON.stringify({ version: 1, nextAddress: 1, terminals: [] })}\n`,
      "utf8",
    );
    const restarted = createFakeHcPort({ statePath: directory, templates: ["claude"] });
    const listed = await restarted.listTerminals({
      all: true,
      labels: { "argos/launch": LABELS["argos/launch"] },
    });
    expect(listed.map((terminal) => terminal.address)).toEqual([created.address]);
    expect(readLaunches(directory)).toHaveLength(1);
  });

  it("kills a live terminal before it can be removed", async () => {
    const port = createFakeHcPort({ templates: ["claude"], completeAfterPolls: 0 });
    const created = await port.runTerminal({ argv: ["claude"], name: "argos-live", labels: LABELS });
    await expect(port.removeTerminal(created.address)).rejects.toMatchObject({ kind: "live" });
    await expect(port.killTerminal(created.address)).resolves.toEqual({ killed: created.address });
    expect(port.kills).toEqual([created.address]);
    await expect(port.removeTerminal(created.address)).resolves.toEqual({
      removed: created.address,
    });
  });
});
