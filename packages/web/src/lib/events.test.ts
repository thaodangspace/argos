/**
 * The SSE client (spec FR11): frame handling, validation, reconnect backoff, and status reporting.
 * No real EventSource is opened — the factory is injectable.
 */

import { describe, expect, it, vi } from "vitest";

import { subscribeEvents, type EventSourceLike } from "./events.js";

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, (event: { readonly data: string }) => void>();
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  addEventListener(type: string, listener: (event: { readonly data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }

  emitRaw(type: string, data: string): void {
    this.listeners.get(type)?.({ data });
  }

  close(): void {
    this.closed = true;
  }
}

const run = {
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

describe("subscribeEvents", () => {
  it("delivers snapshot and run frames", () => {
    const sources: FakeSource[] = [];
    const snapshot = vi.fn();
    const changed = vi.fn();
    subscribeEvents({
      sourceFactory: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      onSnapshot: snapshot,
      onRun: changed,
    });
    const source = sources[0];
    expect(source).toBeDefined();
    source?.onopen?.({});
    source?.emit("snapshot", { runs: [run] });
    source?.emit("run", run);
    expect(snapshot).toHaveBeenCalledWith([run]);
    expect(changed).toHaveBeenCalledWith(run);
  });

  it("ignores malformed and unknown frames without dropping the stream", () => {
    const sources: FakeSource[] = [];
    const snapshot = vi.fn();
    subscribeEvents({
      sourceFactory: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      onSnapshot: snapshot,
      onRun: () => undefined,
    });
    const source = sources[0];
    source?.emitRaw("snapshot", "{not json");
    source?.emitRaw("snapshot", JSON.stringify({ runs: [{ id: 1 }] }));
    source?.emitRaw("other", JSON.stringify({ runs: [run] }));
    expect(snapshot).not.toHaveBeenCalled();
    expect(source?.closed).toBe(false);
  });

  it("reports open/reconnecting and reconnects with capped backoff, then reports open again", () => {
    const sources: FakeSource[] = [];
    const timers: { callback: () => void; delayMs: number }[] = [];
    const statuses: string[] = [];
    const reconnected = vi.fn();
    const subscription = subscribeEvents({
      sourceFactory: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      onSnapshot: () => undefined,
      onRun: () => undefined,
      onStatus: (status) => statuses.push(status),
      onReconnect: reconnected,
      schedule: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return () => undefined;
      },
      random: () => 1,
      baseDelayMs: 100,
      maxDelayMs: 400,
    });

    sources[0]?.onopen?.({});
    expect(statuses).toEqual(["open"]);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      sources.at(-1)?.onerror?.(undefined);
      const timer = timers.shift();
      expect(timer).toBeDefined();
      expect(timer?.delayMs).toBeLessThanOrEqual(400);
      timer?.callback();
    }
    expect(statuses).toEqual(["open", "reconnecting"]);
    expect(sources).toHaveLength(5);
    expect(timers.length).toBe(0);

    sources.at(-1)?.onopen?.({});
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(subscription.status).toBe("open");

    subscription.close();
    expect(subscription.status).toBe("closed");
    expect(sources.at(-1)?.closed).toBe(true);
  });

  it("uses a floor of 250 ms so a flapping server is not hammered", () => {
    const source = new FakeSource();
    const delays: number[] = [];
    subscribeEvents({
      sourceFactory: () => source,
      onSnapshot: () => undefined,
      onRun: () => undefined,
      schedule: (_callback, delayMs) => {
        delays.push(delayMs);
        return () => undefined;
      },
      random: () => 0,
      baseDelayMs: 10,
    });
    source.onerror?.(undefined);
    expect(delays).toEqual([250]);
  });
});
