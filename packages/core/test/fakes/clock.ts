/**
 * Deterministic clock for the durable tests.
 *
 * Implements both halves of the host {@link Clock}: `now()` is what every durable decision reads,
 * and `setTimer()` is what pi-durable's scheduler arms. `advance()` moves time forward, fires every
 * due timer in order, and flushes the microtask/macrotask queue between timers so phases that a
 * timer wakes actually run before the next one fires.
 */

import type { Clock } from "../../src/durable/context.js";

interface PendingTimer {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

/** Let already-queued promise/macrotask continuations run. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** A fixed, plausible epoch so ids/deadlines read naturally in failures. */
export const FAKE_EPOCH = 1_760_000_000_000;

export class FakeClock implements Clock {
  #now: number;
  #timers: PendingTimer[] = [];

  constructor(start: number = FAKE_EPOCH) {
    this.#now = start;
  }

  now = (): number => this.#now;

  setTimer = (
    callback: () => void,
    delayMs: number,
  ): (() => void) => {
    const timer: PendingTimer = {
      at: this.#now + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  /** Number of armed, not-cancelled timers (useful for "nothing is polling" assertions). */
  get armed(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  /** Move time forward by `ms`, running every timer that becomes due. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + Math.max(0, ms);
    await this.#runDue(target);
    if (this.#now < target) this.#now = target;
    // A callback may have scheduled a zero-delay timer; run what is due now.
    await this.#runDue(this.#now);
    // Always give queued scheduler work a chance, even when no timer was armed.
    await flushMicrotasks();
  }

  /** Move time to an absolute instant (never backwards). */
  async advanceTo(at: number): Promise<void> {
    if (at <= this.#now) {
      await this.#runDue(this.#now);
      return;
    }
    await this.advance(at - this.#now);
  }

  async #runDue(limit: number): Promise<void> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= limit)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) return;
      this.#timers = this.#timers.filter((timer) => timer !== due);
      if (due.at > this.#now) this.#now = due.at;
      due.callback();
      await flushMicrotasks();
    }
    throw new Error("FakeClock: timer storm (more than 10000 timers in one advance)");
  }
}

/**
 * Run turns of scheduling until `predicate` holds or the budget is spent, advancing the clock by
 * `stepMs` each round. Returns the number of rounds actually consumed.
 */
export async function advanceUntil(
  clock: FakeClock,
  predicate: () => boolean | Promise<boolean>,
  options: { readonly stepMs?: number; readonly maxRounds?: number } = {},
): Promise<number> {
  const stepMs = options.stepMs ?? 1_000;
  const maxRounds = options.maxRounds ?? 50;
  for (let round = 0; round <= maxRounds; round += 1) {
    if (await predicate()) return round;
    if (round === maxRounds) break;
    await clock.advance(stepMs);
  }
  throw new Error(`advanceUntil: predicate still false after ${maxRounds} rounds`);
}
