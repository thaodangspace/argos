/**
 * The run page's mutations (spec FR8/FR9/FR12): cancel, retry, fork, and gate decisions.
 *
 * Extracted from the page so each path is testable without a router or a browser: every action
 * takes the id it acts on, calls the API **once**, reports through the shared toast store, and then
 * re-reads the run. A gate decision is deduplicated per gate, `gate_already_decided` is a refresh
 * rather than a retry, and cancel asks for a second click before it fires.
 */

import type { GateView } from "@thaodangspace/argos-core/view";

import { toApiError, type ArgosApi } from "./api.js";
import { newClientRequestId } from "./start-form.js";
import type { ToastStore } from "./state/toasts.svelte.js";

/** The step shape an action needs; a full `StepView` satisfies it. */
export interface StepRef {
  readonly id: string;
  readonly title: string;
}

export interface RunActionsDeps {
  readonly api: ArgosApi;
  readonly toasts: ToastStore;
  /** Re-read the list and the open detail after a mutation. */
  readonly refresh: () => Promise<void>;
  /** In-app navigation; a fork lands on a new run. */
  readonly navigate: (path: string) => void | Promise<void>;
  /** The path to navigate to after a fork (`runHref`, which includes the deployment base). */
  readonly runPath: (runId: string) => string;
  /** Injectable idempotency key; the default is a fresh one per action. */
  readonly clientRequestId?: () => string;
}

export class RunActions {
  /** A cancel/retry/fork is in flight: the header buttons disable. */
  busy = $state(false);
  /** The first Cancel click only arms the second one (no `window.confirm` on a mobile webview). */
  confirmingCancel = $state(false);
  /** Gate keys with a decision in flight. */
  deciding = $state<string[]>([]);

  readonly #deps: RunActionsDeps;

  constructor(deps: RunActionsDeps) {
    this.#deps = deps;
  }

  #fail(error: unknown): void {
    const failure = toApiError(error);
    this.#deps.toasts.push(failure.message, { tone: "error", code: failure.code });
  }

  #newId(): string {
    return this.#deps.clientRequestId?.() ?? newClientRequestId();
  }

  /** Decide one gate exactly once; `gate_already_decided` refreshes instead of retrying. */
  async decide(runId: string, gate: GateView, decision: string, comment?: string): Promise<void> {
    if (this.deciding.includes(gate.key)) return;
    this.deciding = [...this.deciding, gate.key];
    try {
      await this.#deps.api.decideGate(runId, gate.gateId, {
        decision,
        ...(comment === undefined ? {} : { comment }),
        clientRequestId: this.#newId(),
      });
      this.#deps.toasts.push(`Gate ${gate.gateId} decided: ${decision}`, { tone: "success" });
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === "gate_already_decided") {
        // Someone else won: refreshing is the correct response, a second POST is not.
        this.#deps.toasts.push("This gate was already decided; refreshing.", {
          tone: "info",
          code: failure.code,
        });
      } else {
        this.#deps.toasts.push(failure.message, { tone: "error", code: failure.code });
      }
    } finally {
      this.deciding = this.deciding.filter((key) => key !== gate.key);
      await this.#deps.refresh();
    }
  }

  /** First click arms, second click cancels; a completed run is refused by the server, not here. */
  async cancel(runId: string): Promise<void> {
    if (!this.confirmingCancel) {
      this.confirmingCancel = true;
      return;
    }
    this.busy = true;
    try {
      await this.#deps.api.cancelRun(runId);
      this.#deps.toasts.push("Run cancelled.", { tone: "success" });
    } catch (error) {
      this.#fail(error);
    } finally {
      this.confirmingCancel = false;
      this.busy = false;
      await this.#deps.refresh();
    }
  }

  /** Retry one failed step; the server re-queues it and its downstream steps. */
  async retry(runId: string, step: StepRef | null): Promise<void> {
    if (step === null) return;
    this.busy = true;
    try {
      await this.#deps.api.retryStep(runId, step.id);
      this.#deps.toasts.push(`Retrying ${step.title}…`, { tone: "info" });
    } catch (error) {
      this.#fail(error);
    } finally {
      this.busy = false;
      await this.#deps.refresh();
    }
  }

  /** Fork at one step: a **new** run, so the page navigates instead of refreshing in place. */
  async fork(runId: string, step: StepRef | null): Promise<void> {
    if (step === null) return;
    this.busy = true;
    try {
      const started = await this.#deps.api.forkRun(runId, step.id);
      await this.#deps.navigate(this.#deps.runPath(started.runId));
    } catch (error) {
      this.#fail(error);
    } finally {
      this.busy = false;
    }
  }
}
