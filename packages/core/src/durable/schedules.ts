/**
 * FR1, FR2, FR3, FR4, FR5, FR7: the schedule registry and the runner that `argos serve` owns.
 *
 * Phase 4 added CRUD over the documents in `schedule-docs.ts`. Phase 5 adds the two paths that make
 * a schedule fire, and they are the whole durability story (G3, G4):
 *
 * - **One timer.** `#arm()` is the only place Argos arms a timer, at
 *   `min(earliest enabled nextFireAt, now + TIMER_MAX_MS)`, so a laptop waking from sleep notices a
 *   missed fire within a minute and an idle host writes nothing (FR3.1). `croner` is only a
 *   calculator (`schedule/next.ts`) and never arms anything.
 * - **One chain.** Every tick and every fire of every schedule runs on one serialized promise
 *   chain, so two fires never overlap (FR3.9) and `close()` can wait for the fire that is in
 *   `prepare` (FR3.2). A failure on the chain is caught there: a tick never dies and never leaves
 *   an unhandled rejection.
 * - **One commit.** A fire prepares outside any commit (load the playbook, pin scripts, cut the
 *   worktree), then writes the run **and** the schedule document in a single commit, inside which
 *   the document is re-read and every guard re-checked (FR4.5). A crash therefore either leaves no
 *   run (and the next tick fires the same deterministic run id) or leaves a run whose
 *   `lastFire.fireAt` is already the fire time, so the same fire time can never start twice (G3).
 *
 * Phase 6 completes the fire path in three places:
 *
 * - **A refusal is a fire outcome (FR6).** A failure *before* the fire commit — the playbook load,
 *   input coercion, a script pin, the worktree, the model check — costs one document-only commit
 *   that records `refused`, bumps `consecutiveFailures`, and moves `nextFireAt` on. No run, no
 *   retry before the next fire time, and the schedule is never paused or deleted by itself.
 * - **Run now is the same fire (FR7.6, FR3.9).** It goes through one serialized chain with the
 *   timer, so it waits for an active fire and then applies the same overlap rule; it uses a fresh
 *   run id and never touches `nextFireAt`.
 * - **Every written entry is announced (FR10.4).** `#announce` emits one event per fire-log entry
 *   a commit actually wrote, after that commit landed, so `argos serve` can print one line per
 *   outcome without the runner depending on it.
 *
 * Phase 7 adds retention (FR9, G7): after a fire that started a run, `#prune` removes the runs
 * beyond the newest `keep` **outside** the fire's commit, and every failure there is swallowed, so
 * retention can never change a fire's outcome, block the chain, or lose an id it could not remove —
 * a skipped run simply stays in `runIds` and is tried again after the next fire.
 *
 * Two design rules the later phases depend on:
 *
 * - **The index decides existence.** Every mutation and every fire commit re-checks
 *   `argos.schedules` before it reads or writes a document, so a `remove` that lands mid-fire is
 *   not undone by a stale read seeding the document back to life (FR7.5, FR4.5). The
 *   `schedule_unknown` refusal is therefore decided by the index, never by a missing document.
 * - **The cache mirrors the documents.** `#cache` holds `{enabled, nextFireAt}` for every schedule
 *   in memory and is refreshed by every mutation and by every tick's outcome; a tick compares
 *   numbers and writes nothing when nothing is due (FR3.1, NFR). A fire reads the document itself,
 *   so the cache being one step stale can only cause an extra read, never a wrong fire.
 */

import { existsSync } from "node:fs";

import type { Context } from "@earendil-works/chord/context";
import type { Harness, Tx } from "@earendil-works/pi-durable";

import { isTerminalRunStatus, type RunRecord } from "../engine/index.js";
import { ArgosError, isArgosError } from "../errors.js";
import type { GitRunner } from "../git/exec.js";
import type { Scalar } from "../playbook/ir.js";
import {
  KEEP_DEFAULT,
  LATE_TOLERANCE_MS,
  MISSED_COUNT_LIMIT,
  MISSED_COUNT_OVERFLOW,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_LIMIT,
  TIMER_MAX_MS,
  normalizeCatchUp,
  normalizeKeep,
  type CatchUp,
  type FireReason,
  type Keep,
  type Overlap,
} from "../schedule/model.js";
import { dueFireTimes, nextFireAfter, parseScheduleSpec } from "../schedule/next.js";
import type { Clock } from "./context.js";
import type {
  AddScheduleInput,
  EditScheduleInput,
  PreparedRun,
  RunOwnerConversation,
  RunScheduleOptions,
  RunStartPort,
  ScheduleFireEvent,
  ScheduleFireListener,
  ScheduleRunPort,
  StartedRun,
} from "./host-types.js";
import { RunDocFamily, RunsIndexDoc, type RunDocValue } from "./mirror.js";
import { resolveRunRequest } from "./run-request.js";
import {
  ScheduleDocFamily,
  SchedulesIndexDoc,
  boundMessage,
  hydrateScheduleDoc,
  pushFire,
  pushRunId,
  readScheduleDoc,
  registerSchedule,
  scheduleIds,
  scheduleRunId,
  unregisterSchedule,
  writeScheduleDoc,
  type FireEntry,
  type ScheduleDoc,
} from "./schedule-docs.js";
import { ulid } from "./ulid.js";

/** What the runner needs: the host's harness/clock/home and the shared start path. */
export interface ScheduleRunnerOptions {
  readonly harness: Harness;
  readonly context: Context;
  readonly clock: Clock;
  /** `$ARGOS_HOME`; global playbooks (`<home>/playbooks`) resolve through it (FR2.5). */
  readonly home?: string;
  /** The prepare/commit half of the start path (FR4.1); Phase 5 fires through it. */
  readonly port: RunStartPort;
  /**
   * Injected git port, shared with the host. A fire's isolation (worktree creation and reuse, D9)
   * runs through `port.prepare`, so this is plumbing for the phases after Phase 5.
   */
  readonly git?: GitRunner;
  /**
   * FR9.3 (G7): the run read/remove pair retention uses. It comes from the host, so this module never
   * imports `host.ts`; absent means "no retention" (a runner built without a host, as in the tests
   * that drive one fire directly).
   */
  readonly runs?: ScheduleRunPort;
}

/** The in-memory view of one schedule that a tick reads (FR3.1). */
interface ScheduleCacheEntry {
  readonly enabled: boolean;
  readonly nextFireAt: number | null;
}

/** What one fire/outcome write changes on the document (FR3.6, FR4.5, FR5.2). */
interface FireRewrite {
  /** Entries written **under** the outcome, newest first (the single `missed` summary, FR3.6). */
  readonly entries: readonly FireEntry[];
  /** The outcome: `started`, `skipped_overlap`, `refused`, or `missed`. Becomes `lastFire`. */
  readonly outcome: FireEntry;
  readonly nextFireAt: number | null;
  readonly now: number;
  /** FR4.5/FR5.4: the newest run, set only by a fire that started one (and its `runIds` entry). */
  readonly liveRunId?: string;
  /** FR4.5: a fire that started a run resets the refusal streak. */
  readonly resetFailures?: boolean;
  /** FR6.1: a refusal increments `consecutiveFailures`. Exactly one of the two is ever set. */
  readonly bumpFailures?: boolean;
}

/**
 * What a refused fire writes (FR6.1, FR7.6).
 *
 * `nextFireAt: "keep"` is run now's rule: a refusal there is recorded against the document but the
 * schedule's own timing is none of the caller's business (FR7.6). `requireEnabled` is the same
 * distinction from the other side — run now works on a paused schedule, a timer fire does not.
 */
interface RefusalPlan {
  readonly fireAt: number;
  readonly reason: FireReason;
  readonly now: number;
  /** The `missed` summary written under the refusal, when the tick counted earlier due times. */
  readonly missed?: FireEntry;
  readonly nextFireAt: number | null | "keep";
  readonly requireEnabled: boolean;
}

/**
 * The decided fire a tick hands to the start half (FR3.7, FR3.8, FR3.6, FR4).
 *
 * The tick has already chosen the one fire time, why it fires, the next fire time, and the `missed`
 * summary for every earlier due time — so the start half can fail and still record all of it.
 */
interface TimerFirePlan {
  readonly fireAt: number;
  readonly reason: FireReason;
  readonly nextFireAt: number | null;
  readonly now: number;
  /** The `missed` summary for earlier due times: written under the fire's own outcome. */
  readonly missed?: FireEntry;
}

/** The decided instant of a run now: always "now", and it never touches the schedule's timing. */
interface RunNowPlan {
  readonly fireAt: number;
  readonly reason: FireReason;
  readonly now: number;
}

/**
 * What run now's single commit produced (FR7.6).
 *
 * `active` and `changed` are decisions, not errors: they write nothing at all, so they never reach
 * the refusal path (which would otherwise log them as one).
 */
type RunNowCommit =
  | {
      readonly kind: "started";
      readonly doc: ScheduleDoc;
      readonly entries: readonly FireEntry[];
      readonly started: StartedRun;
    }
  | { readonly kind: "active"; readonly runId: string }
  | { readonly kind: "changed" };

/** Every stored field except the identity, `uid`, and the bookkeeping (FR7.2). */
interface ScheduleValues {
  readonly playbookId: string;
  readonly cwd: string;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly isolation?: "none" | "worktree";
  readonly cron: string;
  readonly tz: string;
  readonly overlap: Overlap;
  readonly catchUp: CatchUp;
  readonly keep: Keep;
}

/** The validated, normalized timing of one schedule. */
interface ScheduleTiming {
  readonly cron: string;
  readonly tz: string;
  readonly nextFireAt: number;
}

export class ScheduleRunner {
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #clock: Clock;
  readonly #home: string | undefined;
  readonly #port: RunStartPort;
  /**
   * The injected git port. The fire path does its worktree work inside `port.prepare` (the host
   * owns the same port), so the runner itself needs no git call; the field is kept so a later phase
   * (retention/repair) can reuse the host's port without a new option.
   */
  readonly #git: GitRunner | undefined;
  /** FR9.3: the host's run read/remove pair; `undefined` means this runner does no retention. */
  readonly #runs: ScheduleRunPort | undefined;
  /** `id → {enabled, nextFireAt}`; the timer and the tick read only this (FR3.1). */
  readonly #cache = new Map<string, ScheduleCacheEntry>();
  /**
   * FR10.4: the listeners `argos serve` subscribes with. A plain set, like `ArgosHost.observeRuns`:
   * the runner owns the loop, the listener only records — and a listener that throws is contained.
   */
  readonly #fireListeners = new Set<ScheduleFireListener>();
  /** FR3.1: the cancel handle of the one timer Argos arms; `undefined` when no fire is pending. */
  #timer: (() => void) | undefined;
  /**
   * FR3.3/FR3.9: every tick and every fire, one after another. The chain never rejects: a failing
   * tick is caught where it failed, so one broken schedule cannot stop the others or the host.
   */
  #chain: Promise<void> = Promise.resolve();
  #started = false;
  #closing = false;

  constructor(options: ScheduleRunnerOptions) {
    this.#harness = options.harness;
    this.#context = options.context;
    this.#clock = options.clock;
    this.#home = options.home;
    this.#port = options.port;
    this.#git = options.git;
    this.#runs = options.runs;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * FR3.2: load the cache from the documents and run one tick.
   *
   * The first tick is **enqueued**, never awaited and never armed by a timer: `open()` returns as
   * soon as the cache is loaded, and a host that is opened and never advanced still applies its
   * catch-up rule on the next microtask (which is what the deterministic tests rely on).
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      for (const doc of await this.list()) this.#remember(doc);
    } catch {
      // `open()` must not fail after the host owns the pid file and the database, so an unreadable
      // document leaves the cache as far as it loaded; the CRUD read path still reports it.
    }
    this.#enqueue(() => this.#tick());
    this.#arm();
  }

  /**
   * FR3.2: stop firing. The timer is disarmed first, then the chain is awaited, so a fire already
   * inside `prepare` finishes (and commits) before the caller may close the harness. Idempotent.
   */
  async close(): Promise<void> {
    this.#closing = true;
    this.#disarm();
    await this.#chain;
    // `#arm()` refuses once `#closing` is set, so nothing can have re-armed the timer meanwhile.
    this.#disarm();
  }

  /** The deterministic test seam (FR3.2): settle every queued tick and fire, without sleeping. */
  async idle(): Promise<void> {
    await this.#chain;
  }

  // ---------------------------------------------------------------- create

  /**
   * Add one schedule (FR1, FR2, FR7.1).
   *
   * The id is settled first (FR1.2), then the index is checked outside the commit so a duplicate or
   * the 100th schedule is refused before the dry check does any work. The dry check is the same
   * one `POST /runs` performs (FR2.4) and creates no task, run, or worktree. The commit re-checks
   * the index, so two concurrent adds cannot both win.
   */
  async add(input: AddScheduleInput): Promise<ScheduleDoc> {
    const now = this.#clock.now();
    const id = scheduleId(input.id, input.playbookId);
    const enabled = input.enabled ?? true;
    assertRoomFor(id, await this.#indexedIds());
    const values: ScheduleValues = {
      playbookId: input.playbookId,
      cwd: input.cwd,
      inputs: input.inputs ?? {},
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
      cron: input.cron,
      tz: input.tz ?? serverZone(),
      overlap: input.overlap ?? "skip",
      catchUp: normalizeCatchUp(input.catchUp ?? "all"),
      keep: normalizeKeep(input.keep ?? KEEP_DEFAULT),
    };
    const timing = await this.#validate(values, now);

    const doc: ScheduleDoc = {
      id,
      // FR1.3: a fresh ULID per creation, so a deleted and re-added id is a different schedule.
      uid: ulid(now),
      playbookId: values.playbookId,
      cwd: values.cwd,
      inputs: values.inputs,
      ...(values.isolation === undefined ? {} : { isolation: values.isolation }),
      cron: timing.cron,
      tz: timing.tz,
      overlap: values.overlap,
      catchUp: values.catchUp,
      keep: values.keep,
      enabled,
      generation: 0,
      createdAt: now,
      updatedAt: now,
      // FR7.1/FR7.3: a paused schedule has no next fire time until it is resumed.
      nextFireAt: enabled ? timing.nextFireAt : null,
      runIds: [],
      fires: [],
      consecutiveFailures: 0,
    };

    await this.#harness.commit(async (tx) => {
      assertRoomFor(id, await this.#idsInTx(tx));
      await writeScheduleDoc(tx, doc);
      await registerSchedule(tx, id);
    }, this.#context);

    this.#remember(doc);
    // FR7.1: re-arm, so a new schedule fires without waiting for the previous timer's max delay.
    this.#arm();
    return doc;
  }

  // ---------------------------------------------------------------- update

  /**
   * Edit the stored values (FR7.2). The given fields are merged over the stored ones — `inputs`
   * replaces the whole map, so an edit can remove an input — and every merged value goes through the
   * add-time validation again. `generation + 1` makes a fire that started against the old values
   * abort in its commit, and `nextFireAt` is recomputed from `now`, never from the old value.
   */
  async edit(id: string, input: EditScheduleInput): Promise<ScheduleDoc> {
    if (!hasEditableField(input)) {
      throw new ArgosError(
        "invalid_request",
        `schedule ${id}: an edit needs at least one of cwd, inputs, isolation, cron, tz, overlap, catchUp, keep`,
      );
    }
    const now = this.#clock.now();
    const current = await this.#require(id);
    const isolation = input.isolation ?? current.isolation;
    const values: ScheduleValues = {
      playbookId: current.playbookId,
      cwd: input.cwd ?? current.cwd,
      inputs: input.inputs ?? current.inputs,
      ...(isolation === undefined ? {} : { isolation }),
      cron: input.cron ?? current.cron,
      tz: input.tz ?? current.tz,
      overlap: input.overlap ?? current.overlap,
      catchUp: input.catchUp === undefined ? current.catchUp : normalizeCatchUp(input.catchUp),
      keep: input.keep === undefined ? current.keep : normalizeKeep(input.keep),
    };
    const timing = await this.#validate(values, now);

    const written = await this.#harness.commit(async (tx) => {
      // FR7.5: the index decides existence. A schedule removed while the dry check ran stays gone.
      const stored = await readScheduleDoc(tx, id);
      if (stored === undefined) throw unknownSchedule(id);
      const doc: ScheduleDoc = {
        id: stored.id,
        uid: stored.uid,
        playbookId: stored.playbookId,
        cwd: values.cwd,
        inputs: values.inputs,
        ...(values.isolation === undefined ? {} : { isolation: values.isolation }),
        cron: timing.cron,
        tz: timing.tz,
        overlap: values.overlap,
        catchUp: values.catchUp,
        keep: values.keep,
        enabled: stored.enabled,
        generation: stored.generation + 1,
        createdAt: stored.createdAt,
        updatedAt: now,
        nextFireAt: stored.enabled ? timing.nextFireAt : null,
        ...(stored.lastFire === undefined ? {} : { lastFire: stored.lastFire }),
        ...(stored.liveRunId === undefined ? {} : { liveRunId: stored.liveRunId }),
        runIds: stored.runIds,
        fires: stored.fires,
        consecutiveFailures: stored.consecutiveFailures,
      };
      await writeScheduleDoc(tx, doc);
      return doc;
    }, this.#context);

    this.#remember(written);
    // FR7.2: the new `nextFireAt` may be sooner than the armed timer.
    this.#arm();
    return written;
  }

  /**
   * FR7.3: pause. A live run continues; a fire that is already preparing aborts in its commit
   * because `generation` changed and `enabled` is false. `nextFireAt` becomes `null`.
   */
  async pause(id: string): Promise<ScheduleDoc> {
    return this.#rewrite(id, (stored, now) => ({
      ...stored,
      enabled: false,
      generation: stored.generation + 1,
      updatedAt: now,
      nextFireAt: null,
    }));
  }

  /**
   * FR7.4: resume. `nextFireAt` is computed from **now**, so fire times inside the pause are never
   * caught up: a schedule paused for a week resumes at its next real fire time, not with a burst.
   */
  async resume(id: string): Promise<ScheduleDoc> {
    const now = this.#clock.now();
    return this.#rewrite(id, (stored) => {
      const spec = parseScheduleSpec(stored.cron, stored.tz);
      const next = nextFireAfter(spec, now);
      if (next === null) {
        throw new ArgosError(
          "invalid_request",
          `schedule ${id}: cron expression ${JSON.stringify(stored.cron)} in ${stored.tz} never produces a fire time`,
        );
      }
      return {
        ...stored,
        enabled: true,
        generation: stored.generation + 1,
        updatedAt: now,
        nextFireAt: next,
      };
    }, now);
  }

  // ---------------------------------------------------------------- delete

  /**
   * FR7.5: retire the document and drop the id from the index in one commit. Live runs continue and
   * keep their `trigger`; an in-flight fire aborts in its commit (its index guard fails).
   */
  async remove(id: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const stored = await readScheduleDoc(tx, id);
      if (stored === undefined) throw unknownSchedule(id);
      await tx.retireDoc(ScheduleDocFamily, id);
      await unregisterSchedule(tx, id);
    }, this.#context);
    this.#cache.delete(id);
    // FR7.5: a removed schedule must not keep the timer awake.
    this.#arm();
  }

  // ---------------------------------------------------------------- read

  /** One schedule, or `undefined` for an unknown id (the RPC layer's `schedule_unknown`). */
  async get(id: string): Promise<ScheduleDoc | undefined> {
    const ids = await this.#indexedIds();
    if (!ids.includes(id)) return undefined;
    const value = await this.#harness.snapshot(ScheduleDocFamily, id, this.#context);
    return value === undefined ? undefined : hydrateScheduleDoc(value);
  }

  /** Every schedule, sorted by id (FR10.1: the index first, never a scan of task records). */
  async list(): Promise<ScheduleDoc[]> {
    const docs: ScheduleDoc[] = [];
    for (const id of await this.#indexedIds()) {
      const doc = await this.get(id);
      if (doc !== undefined) docs.push(doc);
    }
    return docs.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  // ---------------------------------------------------------------- run now (FR7.6)

  /**
   * FR10.4: subscribe to fire outcomes. Returns the detach function.
   *
   * One event per fire-log entry the runner **wrote** — the outcome, plus the separate `missed`
   * summary when a late tick writes one — and never anything for an aborted write. No event carries
   * an input value: the event is the fire line `argos serve` prints.
   */
  observeScheduleFires(listener: ScheduleFireListener): () => void {
    this.#fireListeners.add(listener);
    return () => {
      this.#fireListeners.delete(listener);
    };
  }

  /**
   * FR7.6/FR3.9: fire one schedule at once, without touching its timing.
   *
   * It runs on the **same serialized chain** as the timer, so a run now issued while a tick or
   * another fire is in flight waits for it and then applies the overlap rule to whatever that fire
   * started: two fires of one schedule never overlap. `#enqueueWithResult` is what lets the caller
   * see its own outcome (and its own error) while the chain itself stays unbreakable.
   */
  async runNow(id: string, options: RunScheduleOptions = {}): Promise<StartedRun> {
    if (this.#closing) throw new ArgosError("storage_locked", "argos host is closed");
    return this.#enqueueWithResult(() => this.#runNow(id, options));
  }

  async #runNow(id: string, options: RunScheduleOptions): Promise<StartedRun> {
    const now = this.#clock.now();
    // FR1.7: the index decides existence, exactly as every other entry point does.
    const doc = await this.#require(id);

    // FR7.6/FR5.2: `skip` with a live run is refused **before any write**, and the message names the
    // live run so the operator knows what to wait for (or cancel).
    const live = doc.liveRunId;
    if (doc.overlap === "skip" && live !== undefined && (await this.#runIsLive(live))) {
      throw runActive(id, live, "is still live and overlap is \"skip\"");
    }

    // FR7.6: `fireAt = now` and a **fresh** id — the instant is not a cron fire time, so there is
    // nothing to be deterministic about, and FR4.3 gives run now the existing idempotency key.
    const fireAt = now;
    const reason: FireReason = "run_now";
    const runId = ulid(now);
    const plan: RunNowPlan = { fireAt, reason, now };

    let prepared: PreparedRun;
    try {
      const resolved = resolveRunRequest({
        playbookId: doc.playbookId,
        cwd: doc.cwd,
        inputs: doc.inputs,
        ...(this.#home === undefined ? {} : { home: this.#home }),
      });
      const outcome = await this.#port.prepare({
        ir: resolved.ir,
        inputs: resolved.inputs,
        cwd: resolved.cwd,
        id: runId,
        ...(doc.isolation === undefined ? {} : { isolation: { mode: doc.isolation } }),
        trigger: { kind: "schedule", scheduleId: doc.id, fireAt, reason },
        ...(options.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      });
      // FR7.6/D15: a replayed `clientRequestId` returns the receipt the first request issued and
      // writes **nothing** — no run, no fire-log entry, no event.
      if (outcome.kind === "started") return outcome.started;
      prepared = outcome.prepared;
    } catch (error) {
      // FR7.6: any other refusal is recorded exactly like a timer refusal (same `errorCode` and
      // `message` rules), `nextFireAt` is left alone, and the caller still gets the error.
      await this.#recordRefusal(
        doc,
        { fireAt, reason, now, nextFireAt: "keep", requireEnabled: false },
        error,
      );
      throw error;
    }

    const root = await this.#port.root();
    const result = await this.#commitRunNow(doc, prepared, root, plan);
    if (result.kind === "active") {
      throw runActive(id, result.runId, "became live while run now was preparing");
    }
    if (result.kind === "changed") {
      // The schedule was removed or edited between the read and the commit. Nothing was created,
      // so the honest answer is that this request no longer names a schedule to run.
      await this.#refresh(id);
      const current = await this.get(id);
      if (current === undefined) throw unknownSchedule(id);
      throw new ArgosError(
        "invalid_request",
        `schedule ${JSON.stringify(id)} changed while run now was preparing; retry the request`,
      );
    }

    // FR4.5: the run and its mirror are durable; only now may the harness start the run's tasks.
    this.#port.resume();
    this.#remember(result.doc);
    this.#arm();
    this.#announce(id, result.entries);
    // FR9.3: retention runs after the fire's commit, outside it, and can never change its outcome.
    await this.#prune(id);
    return result.started;
  }

  /**
   * The one commit of a run now (FR7.6).
   *
   * The guards are deliberately narrower than a timer fire's: **no `enabled`** (a paused schedule
   * may be run now) and **no `lastFire`** (a repeated instant is a second run by design). The
   * index, `uid`, and `generation` guards stay, because a concurrent delete or edit must still undo
   * this operation instead of being overwritten with a stale document.
   */
  async #commitRunNow(
    doc: ScheduleDoc,
    prepared: PreparedRun,
    root: RunOwnerConversation,
    plan: RunNowPlan,
  ): Promise<RunNowCommit> {
    try {
      return await this.#harness.commit(async (tx) => {
        const stored = await readScheduleDoc(tx, doc.id);
        if (!sameIdentity(stored, doc)) return { kind: "changed" as const };
        // FR7.6/FR4.5: the overlap re-check, because a run may have started since the pre-check.
        const live = stored.liveRunId;
        if (stored.overlap === "skip" && live !== undefined && (await runIsLiveInTx(tx, live))) {
          return { kind: "active" as const, runId: live };
        }
        const started = await this.#port.commitInTx(tx, prepared, root, {
          historyDetail: `${stored.playbookId} (schedule ${stored.id})`,
        });
        const outcome: FireEntry = {
          fireAt: plan.fireAt,
          at: plan.now,
          reason: plan.reason,
          status: "started",
          runId: started.runId,
        };
        const updated = rewriteAfterFire(stored, {
          entries: [],
          outcome,
          // FR7.6: run now never changes the timing, so the stored `nextFireAt` is carried over.
          nextFireAt: stored.nextFireAt,
          now: plan.now,
          liveRunId: started.runId,
          resetFailures: true,
        });
        await writeScheduleDoc(tx, updated);
        return { kind: "started" as const, doc: updated, entries: [outcome], started };
      }, this.#context);
    } catch (error) {
      // A failure inside the commit rolled the whole write back, so recording the refusal is
      // honest and the caller still sees the original error (FR7.6).
      await this.#recordRefusal(
        doc,
        { fireAt: plan.fireAt, reason: plan.reason, now: plan.now, nextFireAt: "keep", requireEnabled: false },
        error,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------- timer and tick

  /**
   * FR3.1: arm exactly one timer, at the earliest enabled `nextFireAt` but never more than
   * {@link TIMER_MAX_MS} away.
   *
   * The cap is what makes a host that slept (or a laptop that was closed) notice a missed fire
   * within a minute, and it bounds how long a schedule edit has to wait for the previous timer.
   * `croner` never arms anything; this is the only timer in the scheduler.
   */
  #arm(): void {
    this.#disarm();
    if (this.#closing) return;
    const now = this.#clock.now();
    let earliest: number | undefined;
    for (const entry of this.#cache.values()) {
      if (!entry.enabled || entry.nextFireAt === null) continue;
      if (earliest === undefined || entry.nextFireAt < earliest) earliest = entry.nextFireAt;
    }
    // FR3.1: no enabled schedule with a next fire time means no timer at all (an idle host writes
    // nothing and holds nothing).
    if (earliest === undefined) return;
    // `#arm` runs right after a tick (which handled everything due) or after a mutation (which
    // stores a future fire time), so an enabled `nextFireAt` in the past means that tick could not
    // make progress (a corrupt document, or an overlapping run that appeared mid-fire). Waiting the
    // normal cap instead of firing again immediately keeps such a state from spinning the process.
    const delay = earliest <= now ? TIMER_MAX_MS : Math.min(earliest - now, TIMER_MAX_MS);
    this.#timer = this.#armTimer(() => {
      // The timer only wakes the chain; the tick decides what (if anything) is due.
      this.#enqueue(() => this.#tick());
    }, delay);
  }

  #disarm(): void {
    this.#timer?.();
    this.#timer = undefined;
  }

  /**
   * FR3.1: the injected clock's `setTimer` when it has one (the durable tests' `FakeClock`), else an
   * unref'd `setTimeout` so an idle `argos serve` can still exit when nothing else keeps it alive.
   */
  #armTimer(callback: () => void, delayMs: number): (() => void) | undefined {
    const setTimer = this.#clock.setTimer;
    if (setTimer !== undefined) {
      return setTimer.call(this.#clock, callback, delayMs, { background: true });
    }
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  }

  /**
   * Append `work` to the one chain (FR3.3/FR3.9).
   *
   * The chain never rejects: the tick catches per schedule and close awaits the tail, so an
   * unhandled rejection can never escape into the host process.
   */
  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work).catch(() => undefined);
  }

  /**
   * Append `work` to the same chain and hand its own outcome back to the caller (FR3.9, FR7.6).
   *
   * The returned promise is **not** the chain: the chain receives the settled-and-swallowed
   * version, so one failing run now can never stop the ticks behind it, while its caller still sees
   * its own error (a refused run now rethrows, FR7.6).
   */
  #enqueueWithResult<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(work);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * FR3.3: handle every enabled schedule whose `nextFireAt` has passed, one at a time, in
   * `nextFireAt` order and then id order.
   *
   * The cache is the only thing read when nothing is due, so an idle tick writes nothing (NFR).
   */
  async #tick(): Promise<void> {
    const now = this.#clock.now();
    for (const id of this.#dueIds(now)) {
      await this.#fireSafely(id);
    }
    // FR3.1: re-arm from the new cache (a fired schedule advanced its `nextFireAt`).
    this.#arm();
  }

  /** The ids that are due at `now`, in fire order (FR3.3). */
  #dueIds(now: number): string[] {
    const due: { id: string; nextFireAt: number }[] = [];
    for (const [id, entry] of this.#cache) {
      if (!entry.enabled || entry.nextFireAt === null || entry.nextFireAt > now) continue;
      due.push({ id, nextFireAt: entry.nextFireAt });
    }
    return due
      .sort(
        (left, right) =>
          left.nextFireAt - right.nextFireAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map((entry) => entry.id);
  }

  /**
   * One schedule's fire attempt, with the tick protected from anything that escapes it.
   *
   * FR6.1's refusal is recorded where the fire time is known (see {@link #startFiredRun}), because a
   * refusal must name `fireAt` and carry the missed summary. What can still reach this catch is a
   * **structural** failure with no fire time to record — an unreadable document, or a stored cron
   * expression `croner` refuses — so the cache entry is refreshed and the operator sees the corrupt
   * document on the CRUD read path. Either way the tick lives on and the next tick is at most
   * {@link TIMER_MAX_MS} away (FR3.1).
   */
  async #fireSafely(id: string): Promise<void> {
    try {
      await this.#fireDue(id);
    } catch {
      await this.#refresh(id);
    }
  }

  /**
   * FR3.4–FR3.8, FR4, FR5: the whole decision and action for one due schedule.
   *
   * Everything is read from the document (never only from the cache), and the decision is taken
   * from its `nextFireAt`, so an edit, pause, or delete that lands later is caught again inside the
   * commit by {@link stillCurrent}.
   */
  async #fireDue(id: string): Promise<void> {
    const now = this.#clock.now();
    const doc = await this.get(id);
    // The index no longer lists it: stop waking up for it (FR7.5).
    if (doc === undefined) {
      this.#cache.delete(id);
      return;
    }
    if (!doc.enabled || doc.nextFireAt === null) {
      this.#remember(doc);
      return;
    }
    const spec = parseScheduleSpec(doc.cron, doc.tz);
    // FR3.4: one candidate beyond the count limit is what tells "exactly the limit" from "more".
    const due = dueFireTimes(spec, doc.nextFireAt - 1, now, MISSED_COUNT_LIMIT + 1);
    if (due === undefined) {
      this.#remember(doc);
      return;
    }

    const fireAt = due.latest;
    // FR3.4: `M` is the number of earlier due fire times, or the overflow marker past the limit.
    const earlier = due.capped ? MISSED_COUNT_OVERFLOW : due.count - 1;
    const lateMs = now - fireAt;
    // FR3.7: a fire the tick is on time for is `cron`; anything later is a `catch_up`.
    const reason: FireReason = lateMs <= LATE_TOLERANCE_MS ? "cron" : "catch_up";
    // FR3.8: the next fire time is computed from now, never from the old one.
    const nextFireAt = nextFireAfter(spec, now);
    // FR3.6/FR4.6: a fire time at or before `lastFire` already landed (a restart after the commit,
    // or a wall clock that moved back). It is recorded as missed and never starts a run.
    const alreadyFired = fireAt <= (doc.lastFire?.fireAt ?? Number.NEGATIVE_INFINITY);

    if (alreadyFired || !dueStillRuns(doc.catchUp, lateMs)) {
      // One `missed` entry per tick, counting every due fire time including this one (FR3.6).
      await this.#writeOutcome(
        doc,
        {
          fireAt,
          at: now,
          reason,
          status: "missed",
          count: due.capped ? MISSED_COUNT_OVERFLOW : due.count,
          from: due.first,
          to: fireAt,
        },
        undefined,
        nextFireAt,
        now,
      );
      return;
    }

    // FR3.6: the earlier due fire times are summarised in one `missed` entry under the fire's own
    // outcome. `to` stops before the fired time so the two entries never claim the same instant.
    const missed: FireEntry | undefined =
      earlier === 0
        ? undefined
        : {
            fireAt,
            at: now,
            reason: "catch_up",
            status: "missed",
            count: earlier,
            from: due.first,
            to: due.beforeLatest ?? due.first,
          };

    // FR4.4/FR5.2: the overlap pre-check is one document read plus, at most, one run document. A
    // skip therefore does **no** prepare I/O (no playbook load, no script pins, no worktree).
    const liveRunId = doc.liveRunId;
    if (doc.overlap === "skip" && liveRunId !== undefined && (await this.#runIsLive(liveRunId))) {
      await this.#writeOutcome(
        doc,
        { fireAt, at: now, reason, status: "skipped_overlap", runId: liveRunId },
        missed,
        nextFireAt,
        now,
      );
      return;
    }

    await this.#startFiredRun(doc, {
      fireAt,
      reason,
      nextFireAt,
      now,
      ...(missed === undefined ? {} : { missed }),
    });
  }

  /**
   * FR6.1–FR6.5: start the run for one decided fire time, or record why it was refused.
   *
   * Everything from here to the commit is the fallible half — the playbook load and the input
   * coercion, the script pins, the worktree, the model check — and FR6 says a failure there is a
   * fire **outcome**, not a silent miss: {@link #recordRefusal} writes one document-only commit with
   * `status: "refused"`, the error code and message, `consecutiveFailures + 1`, and the next fire
   * time. Nothing is retried before that next time, and the schedule is never paused or deleted by
   * itself (FR6.3, FR6.5). The error stops here, so the tick (and the other schedules) continue.
   */
  async #startFiredRun(doc: ScheduleDoc, plan: TimerFirePlan): Promise<void> {
    try {
      await this.#fireCommitted(doc, plan);
    } catch (error) {
      await this.#recordRefusal(
        doc,
        {
          fireAt: plan.fireAt,
          reason: plan.reason,
          now: plan.now,
          nextFireAt: plan.nextFireAt,
          requireEnabled: true,
          ...(plan.missed === undefined ? {} : { missed: plan.missed }),
        },
        error,
      );
    }
  }

  /** The prepared half of a timer fire: resolve, prepare, then the one guarded commit (FR4). */
  async #fireCommitted(doc: ScheduleDoc, plan: TimerFirePlan): Promise<void> {
    const { fireAt, reason, nextFireAt, now, missed } = plan;
    const entries: readonly FireEntry[] = missed === undefined ? [] : [missed];
    // FR4.2/FR4.3: the playbook is loaded at fire time, and the run id is the fire time's ULID, so a
    // crash before the commit re-fires the same fire time with the same id (FR4.6).
    const runId = scheduleRunId(doc.uid, fireAt);
    const resolved = resolveRunRequest({
      playbookId: doc.playbookId,
      cwd: doc.cwd,
      inputs: doc.inputs,
      ...(this.#home === undefined ? {} : { home: this.#home }),
    });
    const outcome = await this.#port.prepare({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
      id: runId,
      ...(doc.isolation === undefined ? {} : { isolation: { mode: doc.isolation } }),
      trigger: { kind: "schedule", scheduleId: doc.id, fireAt, reason },
    });
    // A timer fire carries no `clientRequestId`, so the D15 fast path cannot have matched. Narrow
    // anyway: committing a fire marker for a run this fire did not create would be a lie (G3).
    if (outcome.kind !== "prepared") {
      await this.#refresh(doc.id);
      return;
    }
    const prepared = outcome.prepared;
    const root = await this.#port.root();

    // FR4.5/G3: one commit writes the run task, its mirror, its history, its run-index entry **and**
    // the schedule document. Every guard is re-checked inside it, against the document as stored
    // now, so nothing that landed while `prepare` was running can be overwritten.
    const committed = await this.#harness.commit(async (tx) => {
      const stored = await readScheduleDoc(tx, doc.id);
      if (!stillCurrent(stored, doc, fireAt, true)) return undefined;
      // FR4.5/FR4.6: `tx` has no "exists" read, so the run index stands in for one.
      const runs = await tx.doc(RunsIndexDoc);
      // G3: this fire time already has its run — a previous process committed it, or an operator
      // started a run with the deterministic id. Adopt it as this fire's outcome instead of starting
      // a second run, and advance `nextFireAt`, so the tick can never retry this instant forever.
      if (runs.ids.includes(runId)) {
        const adoptedEntry: FireEntry = {
          fireAt,
          at: now,
          reason,
          status: "started",
          runId,
        };
        const adopted = rewriteAfterFire(stored, {
          entries,
          outcome: adoptedEntry,
          nextFireAt,
          now,
          liveRunId: runId,
          resetFailures: true,
        });
        await writeScheduleDoc(tx, adopted);
        return {
          doc: adopted,
          created: false as const,
          entries: [...entries, adoptedEntry],
        };
      }
      // FR4.5/FR5.2: overlap is re-checked in the writer, because a run may have started between
      // the pre-check and this commit.
      const live = stored.liveRunId;
      if (doc.overlap === "skip" && live !== undefined && (await runIsLiveInTx(tx, live))) {
        return undefined;
      }
      const started = await this.#port.commitInTx(tx, prepared, root, {
        historyDetail: `${stored.playbookId} (schedule ${stored.id})`,
      });
      const startedEntry: FireEntry = {
        fireAt,
        at: now,
        reason,
        status: "started",
        runId: started.runId,
      };
      const updated = rewriteAfterFire(stored, {
        entries,
        outcome: startedEntry,
        nextFireAt,
        now,
        liveRunId: started.runId,
        resetFailures: true,
      });
      await writeScheduleDoc(tx, updated);
      return {
        doc: updated,
        created: true as const,
        entries: [...entries, startedEntry],
      };
    }, this.#context);

    if (committed === undefined) {
      // FR4.5: an aborted fire created no run. The document wins (edited, paused, removed, or a
      // run that became live) and this fire time is not retried.
      await this.#refresh(doc.id);
      return;
    }
    // FR4.5: the run and its mirror are durable; only now may the harness start the run's tasks.
    if (committed.created) this.#port.resume();
    this.#remember(committed.doc);
    this.#arm();
    this.#announce(doc.id, committed.entries);
    // FR9.3: retention is a separate step after the fire's commit. It is awaited (so `close()` and
    // the tests see it settled) but it never rethrows, so the fire's outcome is already final.
    await this.#prune(doc.id);
  }

  /**
   * FR3.6/FR5.2: the one document-only commit a tick writes when it does not start a run (a missed
   * fire time, or an overlap skip).
   *
   * It is guarded like a fire commit — index, `uid`, `generation`, `enabled`, and (for a skip) an
   * unfired `lastFire` — so an edit, pause, or delete that landed while the tick was working wins and
   * nothing is written. A `missed` write is the exception: it must be able to record a fire time
   * `lastFire` already names, otherwise a clock that moved back could never advance past it.
   */
  async #writeOutcome(
    doc: ScheduleDoc,
    outcome: FireEntry,
    missed: FireEntry | undefined,
    nextFireAt: number | null,
    now: number,
  ): Promise<void> {
    const entries: readonly FireEntry[] = missed === undefined ? [] : [missed];
    const written = await this.#harness.commit(async (tx) => {
      const stored = await readScheduleDoc(tx, doc.id);
      // A `missed` entry is the one write that is allowed for a fire time `lastFire` already names.
      if (!stillCurrent(stored, doc, outcome.fireAt, outcome.status !== "missed")) return undefined;
      const updated = rewriteAfterFire(stored, {
        entries,
        outcome,
        nextFireAt,
        now,
      });
      await writeScheduleDoc(tx, updated);
      return updated;
    }, this.#context);
    if (written === undefined) {
      await this.#refresh(doc.id);
      return;
    }
    this.#remember(written);
    this.#announce(doc.id, [...entries, outcome]);
  }

  /**
   * FR6.1/FR6.2/FR7.6: record one refused fire, and nothing else.
   *
   * The document-only commit carries `lastFire` and the matching log entry (`status: "refused"`),
   * `consecutiveFailures + 1`, and — for a timer fire — the next `nextFireAt`, so the loop resumes at
   * the next real fire time instead of retrying (FR6.3). Run now keeps the stored `nextFireAt` and
   * records the same entry on a paused schedule (FR7.6).
   *
   * The guards are the ones every write uses — the index (a delete wins), `uid`, and `generation` (an
   * edit or pause wins) — plus `enabled` for the timer path. The fire-time guard is deliberately
   * off: recording a refusal for the current fire time is exactly what this commit does, and a clock
   * that moved back must not be able to block it forever.
   */
  async #recordRefusal(doc: ScheduleDoc, plan: RefusalPlan, error: unknown): Promise<void> {
    const failure = refusalOf(error);
    const outcome: FireEntry = {
      fireAt: plan.fireAt,
      at: plan.now,
      reason: plan.reason,
      status: "refused",
      errorCode: failure.errorCode,
      message: failure.message,
    };
    const entries: readonly FireEntry[] = plan.missed === undefined ? [] : [plan.missed];
    const written = await this.#harness.commit(async (tx) => {
      const stored = await readScheduleDoc(tx, doc.id);
      if (!stillCurrent(stored, doc, plan.fireAt, false, plan.requireEnabled)) return undefined;
      const updated = rewriteAfterFire(stored, {
        entries,
        outcome,
        nextFireAt: plan.nextFireAt === "keep" ? stored.nextFireAt : plan.nextFireAt,
        now: plan.now,
        bumpFailures: true,
      });
      await writeScheduleDoc(tx, updated);
      return updated;
    }, this.#context);
    if (written === undefined) {
      // FR4.5: the document changed under the refusal; that writer wins and this is not recorded.
      await this.#refresh(doc.id);
      return;
    }
    this.#remember(written);
    this.#announce(doc.id, [...entries, outcome]);
  }

  /**
   * FR10.4: announce the fire-log entries a commit just wrote — one event each, after the write
   * landed and never for an aborted one.
   *
   * The event is the fire line `argos serve` prints: id, fire time, status, and the run id or the
   * error code. It never carries an input value. A listener that throws is contained here, because
   * observability must not be able to stop a schedule or a tick.
   */
  #announce(scheduleId: string, entries: readonly FireEntry[]): void {
    if (this.#fireListeners.size === 0) return;
    for (const entry of entries) {
      const event: ScheduleFireEvent = {
        scheduleId,
        fireAt: entry.fireAt,
        status: entry.status,
        ...(entry.runId === undefined ? {} : { runId: entry.runId }),
        ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
        ...(entry.count === undefined ? {} : { count: entry.count }),
      };
      for (const listener of this.#fireListeners) {
        try {
          listener(event);
        } catch {
          // A listener is observability only (FR10.4).
        }
      }
    }
  }

  /**
   * FR9.1–FR9.3 (G7): remove the runs this schedule started beyond the newest `keep`.
   *
   * Three rules keep retention harmless:
   *
   * - **It is separate from the fire.** It runs after the fire's commit, outside it, and everything
   *   it can throw is swallowed below, so a slow or failing prune can neither fail a `started`
   *   outcome, change `lastFire`, nor add to the fire log.
   * - **Only what `removeRun` accepts goes.** A missing run document means the operator already
   *   removed it and only the id is stale; a live run — or one with a running after-task — is
   *   refused with `run_terminal` and stays for a later fire (FR9.3).
   * - **A worktree keeps its run.** Retention never removes a worktree or a branch (FR4/R4), and
   *   `removeRun` deliberately leaves the directory behind, so a run whose directory still exists is
   *   kept and retried after the next fire.
   */
  async #prune(id: string): Promise<void> {
    const runs = this.#runs;
    if (runs === undefined) return;
    try {
      const doc = await this.get(id);
      // FR7.5: the index no longer lists it, so there is no `runIds` list left to prune.
      if (doc === undefined) return;
      // FR9.1: `"all"` means "keep every run", so no id is ever a candidate.
      const keep = doc.keep;
      if (keep === "all") return;
      // FR9.2: the list is newest first, so everything past the newest `keep` is a candidate.
      const candidates = doc.runIds.slice(keep);
      if (candidates.length === 0) return;

      const dropped = new Set<string>();
      for (const runId of candidates) {
        const run = await runs.get(runId);
        if (run === undefined) {
          // FR9.2/FR9.3: `argos rm` (or an earlier prune) already retired it; drop the stale id.
          dropped.add(runId);
          continue;
        }
        const worktreePath = run.record.worktree?.path;
        if (worktreePath !== undefined && existsSync(worktreePath)) continue;
        try {
          await runs.remove(runId);
        } catch {
          // FR9.3: `run_terminal` (still live, or an after-task still running) and every other
          // refusal keep the id, so this run is tried again after the next fire.
          continue;
        }
        dropped.add(runId);
      }
      if (dropped.size === 0) return;

      await this.#harness.commit(async (tx) => {
        const stored = await readScheduleDoc(tx, id);
        // The guards every write uses — the index, `uid`, and `generation` — so an edit or a delete
        // that landed while the removals ran wins instead of being overwritten (FR7.5, FR4.5).
        if (!sameIdentity(stored, doc)) return undefined;
        const runIds = stored.runIds.filter((runId) => !dropped.has(runId));
        if (runIds.length === stored.runIds.length) return undefined;
        const updated: ScheduleDoc = { ...stored, runIds };
        await writeScheduleDoc(tx, updated);
        return updated;
      }, this.#context);
      // Nothing the timer reads changed (`enabled`/`nextFireAt` are untouched), no fire-log entry was
      // written, and the fire's own entries were announced by its commit — so the cache and the
      // listeners are left exactly as they are.
    } catch {
      // FR9.3: retention never blocks or fails a fire. An unreadable document, an unreadable run, or
      // a rejected commit leaves the ids in place for the next fire to try again.
    }
  }

  /**
   * FR5.5: is `runId` a live run? Exactly one run document, never a listing. A removed run (its
   * document retired) and a finished run (terminal status) both count as not live, and a running
   * after-task does not keep its terminal parent live (FR5.3).
   */
  async #runIsLive(runId: string): Promise<boolean> {
    const value = await this.#harness.snapshot(RunDocFamily, runId, this.#context);
    return value !== undefined && isLiveRunValue(value);
  }

  /** Re-read one cache entry from its document, dropping it when the schedule is gone. */
  async #refresh(id: string): Promise<void> {
    try {
      const doc = await this.get(id);
      if (doc === undefined) this.#cache.delete(id);
      else this.#remember(doc);
    } catch {
      // An unreadable document cannot fire; dropping it keeps a broken record off the timer (the
      // CRUD read path still reports it to the operator).
      this.#cache.delete(id);
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * The shared validation of add and edit (FR2.1–FR2.4): the cron expression and its zone, the first
   * fire time, then the same resolve + dry check a start performs. Every refusal happens before any
   * commit, so a refused add or edit writes nothing.
   *
   * The spec is parsed first on purpose: a bad expression is `invalid_request` even when the playbook
   * or `cwd` is also wrong, which keeps the message about the field the operator just typed.
   */
  async #validate(values: ScheduleValues, now: number): Promise<ScheduleTiming> {
    const spec = parseScheduleSpec(values.cron, values.tz);
    // FR2.3: an expression that never fires (`0 0 30 2 *`) is refused now, not at the first tick.
    const next = nextFireAfter(spec, now);
    if (next === null) {
      throw new ArgosError(
        "invalid_request",
        `cron expression ${JSON.stringify(spec.cron)} in ${spec.tz} never produces a fire time`,
      );
    }
    // FR2.4/FR4.1: the dry check is the resolve + prepare half of `POST /runs`, so every refusal code
    // an operator would see when starting the run by hand is the code they see at add and edit.
    const resolved = resolveRunRequest({
      playbookId: values.playbookId,
      cwd: values.cwd,
      inputs: values.inputs,
      ...(this.#home === undefined ? {} : { home: this.#home }),
    });
    await this.#port.dryCheck({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
      ...(values.isolation === undefined ? {} : { isolation: { mode: values.isolation } }),
    });
    return { cron: spec.cron, tz: spec.tz, nextFireAt: next };
  }

  /** Read one schedule for a mutation: `schedule_unknown` when the index does not list it. */
  async #require(id: string): Promise<ScheduleDoc> {
    const doc = await this.get(id);
    if (doc === undefined) throw unknownSchedule(id);
    return doc;
  }

  /**
   * One guarded rewrite (pause, resume): read the document inside the commit, apply `change`, write
   * it back. The index guard is {@link readScheduleDoc}'s first step, so a removed schedule is
   * `schedule_unknown` and is never resurrected.
   */
  async #rewrite(
    id: string,
    change: (stored: ScheduleDoc, now: number) => ScheduleDoc,
    now: number = this.#clock.now(),
  ): Promise<ScheduleDoc> {
    const written = await this.#harness.commit(async (tx) => {
      const stored = await readScheduleDoc(tx, id);
      if (stored === undefined) throw unknownSchedule(id);
      const doc = change(stored, now);
      await writeScheduleDoc(tx, doc);
      return doc;
    }, this.#context);
    this.#remember(written);
    // FR7.3/FR7.4: pause disarms the timer, resume arms it again from the new `nextFireAt`.
    this.#arm();
    return written;
  }

  /** The schedule ids from a committed snapshot (index first, as every read is). */
  async #indexedIds(): Promise<readonly string[]> {
    const index = await this.#harness.snapshot(SchedulesIndexDoc, this.#context);
    return index === undefined ? [] : scheduleIds(index);
  }

  /** The schedule ids inside the caller's commit. */
  async #idsInTx(tx: Tx): Promise<readonly string[]> {
    const index = await tx.doc(SchedulesIndexDoc);
    return scheduleIds(index);
  }

  /** Refresh the Phase 5 timer cache entry for one document. */
  #remember(doc: ScheduleDoc): void {
    this.#cache.set(doc.id, { enabled: doc.enabled, nextFireAt: doc.nextFireAt });
  }
}

// ------------------------------------------------------------------ helpers

/**
 * FR1.2: an explicit `id` must match the pattern; otherwise the playbook id is the id when it can
 * be one, and the caller must pass `--id` when it cannot.
 */
function scheduleId(id: string | undefined, playbookId: string): string {
  if (id !== undefined) {
    if (!SCHEDULE_ID_PATTERN.test(id)) {
      throw new ArgosError(
        "invalid_request",
        `schedule id ${JSON.stringify(id)} must match ${String(SCHEDULE_ID_PATTERN)}; pass --id with a valid id`,
      );
    }
    return id;
  }
  if (!SCHEDULE_ID_PATTERN.test(playbookId)) {
    throw new ArgosError(
      "invalid_request",
      `playbook id ${JSON.stringify(playbookId)} cannot be used as a schedule id (it must match ${String(SCHEDULE_ID_PATTERN)}); pass --id`,
    );
  }
  return playbookId;
}

/** FR1.5/FR1.6: a new id must be free, and the registry must have room for one more. */
function assertRoomFor(id: string, ids: readonly string[]): void {
  if (ids.includes(id)) {
    throw new ArgosError(
      "schedule_exists",
      `schedule ${JSON.stringify(id)} already exists; edit it or remove it first`,
    );
  }
  if (ids.length >= SCHEDULE_LIMIT) {
    throw new ArgosError(
      "invalid_request",
      `there are already ${SCHEDULE_LIMIT} schedules, the maximum; remove one before adding ${JSON.stringify(id)}`,
    );
  }
}

/** FR2.2: the zone `argos serve` runs in, stored so a later `TZ` change cannot move a schedule. */
function serverZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === "string" && zone.trim() !== "" ? zone : "UTC";
}

/** FR7.2: a payload that names no field changes nothing and is refused. */
function hasEditableField(input: EditScheduleInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}

function unknownSchedule(id: string): ArgosError {
  return new ArgosError("schedule_unknown", `unknown schedule ${JSON.stringify(id)}`);
}

/**
 * FR3.5: does a fire time that is `lateMs` old still run?
 *
 * `"all"` always does; a positive window does while the fire time is inside it; `0` runs only inside
 * the {@link LATE_TOLERANCE_MS} grace, which is what separates a `cron` fire (a tick that is a little
 * late) from a `catch_up` one.
 */
function dueStillRuns(catchUp: CatchUp, lateMs: number): boolean {
  if (catchUp === "all") return true;
  if (catchUp === 0) return lateMs <= LATE_TOLERANCE_MS;
  return lateMs <= catchUp;
}

/**
 * FR4.5/FR5.2: the guards a fire and a document-only write share.
 *
 * `stored` is the schedule as it is **inside the commit**; `expected` is the document the decision
 * was taken from. Any difference means something wrote after the decision, and that writer wins.
 *
 * `requireUnfired` is the FR4.6 guard: a **fire** (and an overlap skip) refuses a fire time that
 * `lastFire` already names, while a `missed` write and a refusal must be allowed to record exactly
 * that time — otherwise a clock that moved back would leave `nextFireAt` stuck forever.
 *
 * `requireEnabled` is what run now relaxes (FR7.6): a paused schedule may be fired by hand, so that
 * path uses {@link sameIdentity} directly instead.
 */
function stillCurrent(
  stored: ScheduleDoc | undefined,
  expected: ScheduleDoc,
  fireAt: number,
  requireUnfired: boolean,
  requireEnabled = true,
): stored is ScheduleDoc {
  if (!sameIdentity(stored, expected)) return false;
  if (requireEnabled && !stored.enabled) return false;
  // FR4.6/G3: this fire time (or a later one) already landed.
  if (requireUnfired && (stored.lastFire?.fireAt ?? Number.NEGATIVE_INFINITY) >= fireAt) return false;
  return true;
}

/**
 * FR7.6: the guards run now keeps — the index (a removed id is never resurrected by a seed read),
 * the `uid` (a deleted and re-added id is a different schedule, FR1.3), and the `generation` (an
 * edit or pause wins). It deliberately does **not** look at `enabled` or `lastFire`: run now works
 * on a paused schedule, and running the same instant twice is what the operator asked for.
 */
function sameIdentity(
  stored: ScheduleDoc | undefined,
  expected: ScheduleDoc,
): stored is ScheduleDoc {
  if (stored === undefined) return false;
  if (stored.uid !== expected.uid) return false;
  return stored.generation === expected.generation;
}

/** FR5.2: a run is live while its mirrored record exists and its status is not terminal. */
function isLiveRunValue(value: Readonly<RunDocValue>): boolean {
  const record = value.record as unknown as RunRecord | null | undefined;
  if (record === null || record === undefined) return false;
  return !isTerminalRunStatus(record.status);
}

/**
 * {@link isLiveRunValue} inside a commit (FR4.5).
 *
 * `tx` has no "exists" read, so the run index stands in for one: only a run the index still lists
 * has its document read, and a seeded draft therefore can never re-create a removed run (FR5.3).
 */
async function runIsLiveInTx(tx: Tx, runId: string): Promise<boolean> {
  const index = await tx.doc(RunsIndexDoc);
  if (!index.ids.includes(runId)) return false;
  // The index lists it, so this read finds the stored document instead of creating this seed.
  const value = await tx.doc(RunDocFamily, runId, { taskId: "", record: null });
  return isLiveRunValue(value);
}

/**
 * Apply one fire outcome to a document (FR3.6, FR4.5, FR5.2, FR5.4): the outcome becomes `lastFire`
 * and the newest `fires` entry, the missed summary goes right under it, a started run becomes the
 * newest `runId` and `liveRunId`, and `nextFireAt` moves on.
 */
function rewriteAfterFire(stored: ScheduleDoc, rewrite: FireRewrite): ScheduleDoc {
  const fires = [...stored.fires];
  // `pushFire` unshifts, so the missed summary goes in first and ends up after the outcome.
  for (const entry of rewrite.entries) pushFire(fires, entry);
  pushFire(fires, rewrite.outcome);
  const runIds = [...stored.runIds];
  if (rewrite.liveRunId !== undefined) pushRunId(runIds, rewrite.liveRunId);
  // FR5.4: `allow` keeps the newest run; `skip`/`missed` leave the last started run in place.
  const liveRunId = rewrite.liveRunId ?? stored.liveRunId;
  return {
    ...stored,
    lastFire: rewrite.outcome,
    ...(liveRunId === undefined ? {} : { liveRunId }),
    runIds,
    fires,
    nextFireAt: rewrite.nextFireAt,
    updatedAt: rewrite.now,
    // FR4.5: a started run clears the streak; FR6.1: a refusal grows it; anything else keeps it.
    consecutiveFailures:
      rewrite.resetFailures === true
        ? 0
        : rewrite.bumpFailures === true
          ? stored.consecutiveFailures + 1
          : stored.consecutiveFailures,
  };
}

/**
 * FR6.2: what a refused fire may store, and nothing more.
 *
 * An `ArgosError` contributes its stable code and its **bounded** message: the loader, the input
 * coercer, and the git helpers never put a YAML value, an input value, or a credential in one, so
 * the message is safe to keep for the operator. Any other error contributes **no** code and only its
 * `name` — a message from an unexpected source could embed a value, and a fire log is permanent.
 */
function refusalOf(error: unknown): { readonly errorCode: string | null; readonly message: string } {
  if (isArgosError(error)) {
    return { errorCode: error.code, message: boundMessage(error.message) };
  }
  if (error instanceof Error) return { errorCode: null, message: boundMessage(error.name) };
  // A non-`Error` throw has no safe text at all, so nothing of it is stored.
  return { errorCode: null, message: "Error" };
}

/** FR7.6: `run_active` names the live run, so the operator knows what holds the schedule back. */
function runActive(id: string, runId: string, detail: string): ArgosError {
  return new ArgosError(
    "run_active",
    `schedule ${JSON.stringify(id)}: run ${runId} ${detail}; nothing was started`,
  );
}
