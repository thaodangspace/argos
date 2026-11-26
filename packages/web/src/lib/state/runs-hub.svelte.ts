/**
 * One runs stream for the whole app (inbox FR6 / Q1a).
 *
 * `RunsStore` owns the SSE subscription, so a store per page would open one connection per page and
 * the header badge, the list, and the gate inbox would each hold a different value. This hub hands
 * out one shared store behind reference-counted leases:
 *
 * - the layout holds the *anchor* lease for the life of the app (the pending-gate badge);
 * - a route re-acquires the hub while it is mounted and releases on teardown;
 * - the stream closes only when no route and no layout holds a lease. `start()` is already
 *   idempotent, so a re-acquire cannot open a second stream.
 *
 * No `import.meta.hot` guard: `start()` is idempotent per instance, and a module that does not
 * accept HMR reloads the page, which closes the stream.
 *
 * This is a `.svelte.ts` module because it constructs the rune-backed store. It is Node-safe — the
 * store only touches `EventSource` inside `start()` — and the tests inject a recording store through
 * `createStore` instead of ever starting a real stream.
 */

import type { ArgosApi } from "#lib/api";
import { RunsStore } from "#lib/state/runs.svelte";

/** One route's or component's hold on the shared stream. Every `acquire` needs one `release`. */
export interface RunsLease {
  readonly store: RunsStore;
  /** Idempotent: a cleanup path that fires twice cannot corrupt the count. */
  release(): void;
}

export interface RunsHubOptions {
  /** Test seam: a recording store instead of the real one. */
  createStore?: () => RunsStore;
}

export class RunsHub {
  readonly store: RunsStore;
  #api: ArgosApi | undefined;
  /** One token per live lease; its size is `refs`, so the count can neither drift nor go negative. */
  #leases = new Set<symbol>();

  constructor(options: RunsHubOptions = {}) {
    this.store = options.createStore?.() ?? new RunsStore();
  }

  get refs(): number {
    return this.#leases.size;
  }

  /** Take a lease. The first one starts the stream; a later one joins the one already running. */
  acquire(api: ArgosApi): RunsLease {
    const token = Symbol("runs-lease");
    this.#leases.add(token);
    if (this.#api === undefined) {
      // The store's stream keeps the api it started with, so a later lease must not pass another.
      this.#api = api;
      this.store.start(api);
    }
    let released = false;
    return {
      store: this.store,
      release: () => {
        if (released) return;
        released = true;
        // `dispose()` empties the set, so a lease it already ended is inert here.
        if (!this.#leases.delete(token)) return;
        if (this.#leases.size > 0) return;
        this.#api = undefined;
        this.store.stop();
      },
    };
  }

  /** Re-read the run list through the api the stream started with. A no-op with no lease. */
  async load(): Promise<void> {
    const api = this.#api;
    if (api === undefined) return;
    await this.store.load(api);
  }

  /** End every lease and close the stream (app teardown, or a test's cleanup). */
  dispose(): void {
    this.#leases.clear();
    this.#api = undefined;
    this.store.stop();
  }
}

/** One hub per browser session: the layout, the list, the run page, and the inbox share it. */
export const runsHub = new RunsHub();
