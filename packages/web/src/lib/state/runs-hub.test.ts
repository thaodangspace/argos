/**
 * The reference-counted runs hub (inbox FR6 / Q1a): one stream, leased by the layout and by every
 * route. The store is injected here, so no test opens a real `EventSource` or `fetch`.
 */

import { describe, expect, it } from "vitest";

import type { ArgosApi } from "#lib/api";
import { RunsHub, runsHub } from "#lib/state/runs-hub.svelte";
import { RunsStore } from "#lib/state/runs.svelte";

/** The real store with its three lifecycle calls replaced by a ledger. */
class RecordingStore extends RunsStore {
  readonly calls: string[] = [];
  readonly started: ArgosApi[] = [];
  readonly loads: ArgosApi[] = [];

  override start(api: ArgosApi): void {
    this.calls.push("start");
    this.started.push(api);
  }

  override stop(): void {
    this.calls.push("stop");
  }

  override async load(api: ArgosApi): Promise<void> {
    this.calls.push("load");
    this.loads.push(api);
  }
}

/** A full `ArgosApi` stub; only identity matters, every call is unused. */
function api(): ArgosApi {
  return {
    listRuns: async () => [],
    getRun: async () => {
      throw new Error("unused");
    },
    startRun: async () => ({ runId: "unused", taskId: "unused" }),
    cancelRun: async (runId) => ({ runId, status: "cancelled" }),
    retryStep: async (runId) => ({ runId, taskId: "unused" }),
    forkRun: async () => ({ runId: "unused", taskId: "unused" }),
    decideGate: async (runId, gateId, body) => ({
      runId,
      gateId,
      decision: body.decision,
      decidedAt: 0,
    }),
    listPlaybooks: async (cwd) => ({ cwd, playbooks: [], errors: [] }),
    listSchedules: async () => [],
    info: async () => {
      throw new Error("unused");
    },
  };
}

function harness(): { store: RecordingStore; hub: RunsHub } {
  const store = new RecordingStore();
  return { store, hub: new RunsHub({ createStore: () => store }) };
}

describe("RunsHub", () => {
  it("starts the shared stream once for two leases", () => {
    const { store, hub } = harness();
    const first = hub.acquire(api());
    const second = hub.acquire(api());
    expect(first.store).toBe(store);
    expect(second.store).toBe(store);
    expect(store.calls).toEqual(["start"]);
    expect(hub.refs).toBe(2);
  });

  it("keeps the stream open until the last release", () => {
    const { store, hub } = harness();
    const first = hub.acquire(api());
    const second = hub.acquire(api());
    first.release();
    expect(hub.refs).toBe(1);
    expect(store.calls).toEqual(["start"]);
    second.release();
    expect(hub.refs).toBe(0);
    expect(store.calls).toEqual(["start", "stop"]);
  });

  it("ignores a second release of the same lease and never goes below zero", () => {
    const { store, hub } = harness();
    const first = hub.acquire(api());
    const second = hub.acquire(api());
    first.release();
    first.release();
    expect(hub.refs).toBe(1);
    expect(store.calls).toEqual(["start"]);
    second.release();
    second.release();
    expect(hub.refs).toBe(0);
    expect(store.calls).toEqual(["start", "stop"]);
  });

  it("starts the store again on an acquire after zero", () => {
    const { store, hub } = harness();
    hub.acquire(api()).release();
    expect(store.calls).toEqual(["start", "stop"]);
    const lease = hub.acquire(api());
    expect(lease.store).toBe(store);
    expect(hub.refs).toBe(1);
    expect(store.calls).toEqual(["start", "stop", "start"]);
  });

  it("dispose ends every lease and stops the store", () => {
    const { store, hub } = harness();
    const first = hub.acquire(api());
    const second = hub.acquire(api());
    hub.dispose();
    expect(hub.refs).toBe(0);
    expect(store.calls).toEqual(["start", "stop"]);
    // The leases `dispose()` ended are inert: they cannot re-count or re-close the stream.
    first.release();
    second.release();
    expect(hub.refs).toBe(0);
    expect(store.calls).toEqual(["start", "stop"]);
  });

  it("load reads through the api of the first acquire and is a no-op with no lease", async () => {
    const { store, hub } = harness();
    const firstApi = api();
    const secondApi = api();
    const first = hub.acquire(firstApi);
    const second = hub.acquire(secondApi);
    await hub.load();
    expect(store.loads).toHaveLength(1);
    expect(store.loads[0]).toBe(firstApi);
    await hub.load();
    expect(store.loads).toHaveLength(2);
    first.release();
    second.release();
    await hub.load();
    expect(store.loads).toHaveLength(2);
    expect(store.calls.filter((call) => call !== "load")).toEqual(["start", "stop"]);
  });

  it("exports one shared hub, while a test creates its own instance", async () => {
    const again = await import("#lib/state/runs-hub.svelte");
    expect(again.runsHub).toBe(runsHub);
    expect(runsHub.store).toBeInstanceOf(RunsStore);
    // Nothing holds the app's anchor lease until the layout mounts, so the module import is quiet.
    expect(runsHub.refs).toBe(0);
    const own = new RunsHub({ createStore: () => new RecordingStore() });
    expect(own).not.toBe(runsHub);
    expect(own.store).not.toBe(runsHub.store);
  });
});
