/**
 * The live run list (spec FR8/FR11): a thin runes store over the pure reducers plus the SSE
 * subscription. There is no second state machine: a snapshot replaces, a run frame upserts, and a
 * reconnect re-reads.
 */

import type { RunSummary } from "@thaodangspace/argos-core/rpc/contracts";
import type { PanelError } from "@thaodangspace/argos-core/view";

import { toApiError, type ArgosApi } from "../api.js";
import { subscribeEvents, type EventStatus, type EventSubscription } from "../events.js";
import { mergeRun, replaceRuns } from "./reducers.js";

export class RunsStore {
  runs = $state<RunSummary[]>([]);
  status = $state<EventStatus>("connecting");
  error = $state<PanelError | null>(null);
  loading = $state(false);
  /** The first successful read happened: the empty state is real, not "not loaded yet". */
  loaded = $state(false);

  #subscription: EventSubscription | undefined;
  #api: ArgosApi | undefined;

  applySnapshot(runs: readonly RunSummary[]): void {
    this.runs = replaceRuns(runs);
    this.loaded = true;
    this.error = null;
  }

  applyRun(run: RunSummary): void {
    this.runs = mergeRun(this.runs, run);
  }

  async load(api: ArgosApi): Promise<void> {
    this.loading = true;
    try {
      this.applySnapshot(await api.listRuns());
    } catch (error) {
      const failure = toApiError(error);
      this.error = { code: failure.code, message: failure.message };
    } finally {
      this.loading = false;
    }
  }

  /** Start the list: one read, then the live stream. Idempotent. */
  start(api: ArgosApi): void {
    if (this.#subscription !== undefined) return;
    this.#api = api;
    void this.load(api);
    this.#subscription = subscribeEvents({
      onSnapshot: (runs) => {
        this.applySnapshot(runs);
      },
      onRun: (run) => {
        this.applyRun(run);
      },
      onStatus: (status) => {
        this.status = status;
      },
      onReconnect: () => {
        if (this.#api !== undefined) void this.load(this.#api);
      },
    });
  }

  stop(): void {
    this.#subscription?.close();
    this.#subscription = undefined;
  }
}
