/**
 * The in-memory `HcPort` (plan Phase 5 step 4, used by the Phase 6 adapter tests).
 *
 * A fake is only useful if it refuses what a real core refuses and records what a test must
 * count. This suite pins the behaviours later phases depend on: the creation ledger, `name_taken`
 * adoption, `first_message.sent`, turns, statuses, exit codes, `not_found` after a loss, `live` on
 * removing a running terminal, injectable failures, and an unreachable core.
 */

import { describe, expect, it } from "vitest";

import {
  HcKindError,
  HcTransportError,
  hcFailureCode,
  isHcKindError,
  isHcTransportError,
} from "../../src/hc/port.js";
import { FakeHcPort } from "../fakes/hc.js";

describe("fake hc port", () => {
  it("reports its identity and the template catalog", async () => {
    const port = new FakeHcPort({ templates: ["claude", "codex"], version: "0.1.21" });
    await expect(port.hello()).resolves.toMatchObject({
      generation: 1,
      version: "0.1.21",
      framed: false,
    });
    await expect(port.serverStatus()).resolves.toMatchObject({
      pid: 4242,
      live: 0,
      finished: 0,
    });
    const templates = await port.templatesList();
    expect(templates.map((template) => template.name)).toEqual(["claude", "codex"]);
    expect(templates[0]?.error).toBeNull();
  });

  it("creates one terminal per run and remembers the request", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const run = await port.runTerminal({
      argv: ["claude", "fix the bug"],
      cwd: "/work",
      name: "argos-abc123",
      labels: { "argos/launch": "req-1", "argos/step": "build" },
    });

    expect(run.address).toBe("t1");
    expect(run.state).toBe("live");
    expect(run.turn).toBe(0);
    expect(run.template).toBe("claude");
    expect(run.first_message).toEqual({ sent: true, started: null, turn: null, reason: null });
    expect(port.runs).toHaveLength(1);
    expect(port.runsFor("argos-abc123")).toBe(1);
    expect(port.runFor("argos-abc123")).toMatchObject({ cwd: "/work", template: "claude" });
  });

  it("has no first message for a plain command", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const run = await port.runTerminal({ argv: ["sh", "-c", "true"], name: "plain" });
    expect(run.template).toBeNull();
    expect(run.first_message).toBeNull();
  });

  it("refuses a duplicate live name with name_taken and keeps the ledger at one creation", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    await port.runTerminal({ argv: ["claude", "a"], name: "argos-same" });

    const error = await port
      .runTerminal({ argv: ["claude", "b"], name: "argos-same" })
      .then(() => null, (thrown: unknown) => thrown);
    expect(isHcKindError(error)).toBe(true);
    expect((error as HcKindError).kind).toBe("name_taken");
    expect(hcFailureCode(error)).toBe("launch_uncertain");
    // The ledger counts the attempt; the terminal map still holds exactly one.
    expect(port.runsFor("argos-same")).toBe(2);
    expect(port.runs).toHaveLength(1);
    expect(port.liveTerminals()).toHaveLength(1);
  });

  it("can report a first message that did not go in (FR20)", async () => {
    const port = new FakeHcPort({ templates: ["claude"], firstMessageSent: false });
    const run = await port.runTerminal({ argv: ["claude", "task"], name: "argos-fm" });
    expect(run.first_message).toEqual({ sent: false, started: null, turn: null, reason: null });
  });

  it("moves through status words and turns, then finishes with an exit code", async () => {
    const port = new FakeHcPort({ templates: ["claude"] });
    const run = await port.runTerminal({ argv: ["claude", "task"], name: "argos-status" });

    expect(run.status?.state).toBe("working");
    port.reportStatus(run.address, { state: "blocked", msg: "approve this?", kind: "permission" });
    const blocked = await port.getTerminal(run.address);
    expect(blocked.status).toEqual({
      state: "blocked",
      msg: "approve this?",
      title: null,
      kind: "permission",
      progress: null,
    });
    // Leaving `working` bumps the turn, exactly like hc.
    expect(blocked.turn).toBe(1);

    port.reportStatus(run.address, { state: "working" });
    port.finishTerminal(run.address, { exitCode: 3, signal: null, text: "boom" });
    const finished = await port.getTerminal(run.address);
    expect(finished.state).toBe("finished");
    expect(finished.status).toBeNull();
    expect(finished.exit_code).toBe(3);
    expect(finished.reason).toBe("exited");
    expect(finished.turn).toBe(1);

    const read = await port.readTerminal(run.address, { lines: 20 });
    expect(read).toEqual({ text: "boom", complete: true, how: "history", why: null });
  });

  it("delivers a prompt once, refuses a blocked program, and enforces `if`", async () => {
    const port = new FakeHcPort({ initialStatus: "idle" });
    const run = await port.runTerminal({ argv: ["sh", "-c", "true"], name: "argos-send" });

    const sent = await port.sendText({ terminal: run.address, text: "go", if: "idle" });
    expect(sent).toEqual({ turn: 0, status: "working", started: true });
    expect(port.sends).toHaveLength(1);

    // Now working: `if: idle` no longer holds.
    const mismatch = await port
      .sendText({ terminal: run.address, text: "again", if: "idle" })
      .then(() => null, (thrown: unknown) => thrown);
    expect((mismatch as HcKindError).kind).toBe("status_mismatch");

    port.reportStatus(run.address, { state: "blocked", msg: "waiting for input" });
    const blocked = await port
      .sendText({ terminal: run.address, text: "answer" })
      .then(() => null, (thrown: unknown) => thrown);
    expect((blocked as HcKindError).kind).toBe("blocked");
    // `force` types into a blocked program.
    await expect(
      port.sendText({ terminal: run.address, text: "answer", force: true }),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(port.sends).toHaveLength(2);
  });

  it("refuses to remove a live terminal and removes a finished one once", async () => {
    const port = new FakeHcPort();
    const run = await port.runTerminal({ argv: ["sh", "-c", "true"], name: "argos-rm" });

    const live = await port
      .removeTerminal(run.address)
      .then(() => null, (thrown: unknown) => thrown);
    expect((live as HcKindError).kind).toBe("live");

    port.finishTerminal(run.address, { exitCode: 0 });
    await expect(port.removeTerminal(run.address)).resolves.toEqual({ removed: run.address });
    expect(port.removes).toEqual([run.address]);
    await expect(port.getTerminal(run.address)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reports a lost terminal as not_found without recording a removal", async () => {
    const port = new FakeHcPort();
    const run = await port.runTerminal({ argv: ["sh", "-c", "true"], name: "argos-lost" });
    port.forget(run.address);
    await expect(port.getTerminal(run.address)).rejects.toMatchObject({ kind: "not_found" });
    expect(port.removes).toEqual([]);
  });

  it("can be unreachable, and can inject a failure for one method", async () => {
    const port = new FakeHcPort({ templates: ["claude"], unreachable: true });
    const down = await port
      .serverStatus()
      .then(() => null, (thrown: unknown) => thrown);
    expect(isHcTransportError(down)).toBe(true);
    expect(hcFailureCode(down)).toBe("executor_unreachable");

    port.unreachable = false;
    port.failNext("terminal.run", "name_taken");
    const taken = await port
      .runTerminal({ argv: ["claude", "task"], name: "argos-x" })
      .then(() => null, (thrown: unknown) => thrown);
    expect((taken as HcKindError).kind).toBe("name_taken");
    // One injected failure only: the next call behaves normally.
    await expect(port.runTerminal({ argv: ["claude", "task"], name: "argos-x" })).resolves.toMatchObject({
      address: "t1",
    });
    expect(new HcTransportError("x")).toBeInstanceOf(Error);
  });

  it("filters lists by labels and by liveness", async () => {
    const port = new FakeHcPort();
    const first = await port.runTerminal({
      argv: ["sh", "-c", "true"],
      name: "argos-a",
      labels: { "argos/run": "r1" },
    });
    await port.runTerminal({
      argv: ["sh", "-c", "true"],
      name: "argos-b",
      labels: { "argos/run": "r2" },
    });
    port.finishTerminal(first.address, { exitCode: 0 });

    await expect(port.listTerminals()).resolves.toHaveLength(1);
    await expect(port.listTerminals({ all: true })).resolves.toHaveLength(2);
    await expect(port.listTerminals({ all: true, labels: { "argos/run": "r1" } })).resolves.toHaveLength(
      1,
    );
    expect(port.lists.at(-1)).toEqual({ all: true, labels: { "argos/run": "r1" } });
  });
});
