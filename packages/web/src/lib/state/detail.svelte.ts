/**
 * One run's detail page state (spec FR10/FR11).
 *
 * The summary stream is the trigger, not the payload: `open` reads `GET /runs/:id`, and
 * `refreshIfMoved` re-reads only when the summary's `seq` moved, so a 2 s frame cadence cannot
 * multiply requests. An out-of-order response for a run the user already left is dropped.
 */

import type { RunDetail } from "@thaodangspace/argos-core/rpc/contracts";
import type { PanelError } from "@thaodangspace/argos-core/view";

import { toApiError, type ArgosApi } from "../api.js";
import { shouldRefetchDetail } from "./reducers.js";

export class DetailStore {
  runId = $state<string | null>(null);
  detail = $state<RunDetail | null>(null);
  loading = $state(false);
  error = $state<PanelError | null>(null);

  #token = 0;

  async open(api: ArgosApi, runId: string): Promise<void> {
    const token = ++this.#token;
    this.runId = runId;
    this.loading = true;
    // Keep the previous detail for the same run while refreshing: no flicker on a poll.
    if (this.detail?.id !== runId) this.detail = null;
    this.error = null;
    try {
      const detail = await api.getRun(runId);
      if (token !== this.#token) return;
      this.detail = detail;
    } catch (error) {
      if (token !== this.#token) return;
      const failure = toApiError(error);
      this.error = { code: failure.code, message: failure.message };
      if (failure.code === "run_unknown") {
        this.detail = null;
      }
    } finally {
      if (token === this.#token) this.loading = false;
    }
  }

  /** Re-read only when the stream says the run moved (and never for another run). */
  async refreshIfMoved(api: ArgosApi, runId: string, seq: number): Promise<void> {
    if (this.runId !== runId) return;
    if (this.loading) return;
    if (!shouldRefetchDetail(this.detail, seq)) return;
    await this.open(api, runId);
  }

  close(): void {
    this.#token += 1;
    this.runId = null;
    this.detail = null;
    this.loading = false;
    this.error = null;
  }
}
