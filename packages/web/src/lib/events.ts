/**
 * `GET /events` for the browser (spec FR11).
 *
 * The server sends one `snapshot` frame (a full list) and then one `run` frame per changed run.
 * Frames are payload-validated with the contract schema: a malformed frame is ignored rather than
 * killing the stream, and a reconnect asks the caller to re-read (the server may have advanced while
 * we were away).
 *
 * `EventSource` reconnects on its own with a fixed delay and no cap; we close it on error and run
 * our own capped, jittered backoff, which is why the status surface has a `reconnecting` state.
 */

import {
  SSE_RUN_EVENT,
  SSE_SNAPSHOT_EVENT,
  RunSummarySchema,
  type RunSummary,
} from "@thaodangspace/argos-core/rpc/contracts";
import { z } from "zod";

export type EventStatus = "connecting" | "open" | "reconnecting" | "closed";

/** The slice of `EventSource` this module needs (a test passes a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { readonly data: string }) => void): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SubscribeEventsOptions {
  readonly url?: string;
  readonly sourceFactory?: EventSourceFactory;
  readonly onSnapshot: (runs: RunSummary[]) => void;
  readonly onRun: (run: RunSummary) => void;
  /** Called on every status change, not only on errors. */
  readonly onStatus?: (status: EventStatus) => void;
  /** Called after a stream that had dropped is open again: re-read the list. */
  readonly onReconnect?: () => void;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly random?: () => number;
}

export interface EventSubscription {
  close(): void;
  readonly status: EventStatus;
}

const SnapshotSchema = z.object({ runs: z.array(RunSummarySchema) });

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

export function subscribeEvents(options: SubscribeEventsOptions): EventSubscription {
  const url = options.url ?? "/events";
  const factory: EventSourceFactory =
    options.sourceFactory ?? ((target) => new EventSource(target) as unknown as EventSourceLike);
  const baseDelay = options.baseDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 8_000;
  const schedule = options.schedule ?? defaultSchedule;
  const random = options.random ?? Math.random;

  let source: EventSourceLike | undefined;
  let timer: (() => void) | undefined;
  let attempts = 0;
  let closed = false;
  let status: EventStatus = "connecting";

  const setStatus = (next: EventStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const drop = (): void => {
    source?.close();
    source = undefined;
    if (closed) return;
    setStatus("reconnecting");
    const exponent = Math.min(attempts, 10);
    const ceiling = Math.min(maxDelay, baseDelay * 2 ** exponent);
    // Full jitter keeps several tabs from reconnecting in lockstep.
    const delay = Math.max(250, Math.round(ceiling * (0.5 + random() * 0.5)));
    attempts += 1;
    timer = schedule(() => {
      timer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (closed) return;
    const reconnected = attempts > 0;
    const opened = factory(url);
    source = opened;
    opened.onopen = () => {
      attempts = 0;
      setStatus("open");
      if (reconnected) options.onReconnect?.();
    };
    opened.addEventListener(SSE_SNAPSHOT_EVENT, (event) => {
      try {
        const parsed = SnapshotSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) options.onSnapshot(parsed.data.runs);
      } catch {
        // A malformed frame is ignored: the next snapshot/run frame self-heals.
      }
    });
    opened.addEventListener(SSE_RUN_EVENT, (event) => {
      try {
        const parsed = RunSummarySchema.safeParse(JSON.parse(event.data));
        if (parsed.success) options.onRun(parsed.data);
      } catch {
        // ignored, as above
      }
    });
    opened.onerror = () => {
      drop();
    };
  };

  connect();

  return {
    get status(): EventStatus {
      return status;
    },
    close: () => {
      if (closed) return;
      closed = true;
      source?.close();
      source = undefined;
      timer?.();
      timer = undefined;
      setStatus("closed");
    },
  };
}
