/**
 * `ArgosHost` — the one process-wide owner of `$ARGOS_HOME/argos.sqlite` (FR2, FR4, FR13, FR29).
 *
 * Responsibilities:
 * - open (or create) the home directory and the SQLite storage, with `0700`/`0600` modes;
 * - enforce the single-writer rule through `$ARGOS_HOME/serve.pid`, refusing a second live owner
 *   with `storage_locked` and replacing a stale pid file left by a dead process;
 * - install one `argos` extension containing the `argos.run` / `argos.step` / `argos.script` /
 *   `argos.gate` tasks in a fresh registry, with a **stub** `models` (D6) that throws on any use,
 *   because the engine never consults a model for control flow;
 * - create the run's private worktree when `isolation.mode: worktree` asks for one (FR23, D9),
 *   refusing a dirty source checkout *before* any task exists;
 * - expose `startRun`, `resume`, `close`, `getRun`, `getHistory`, `getTaskRecord`, `inspect`, and
 *   the manual worktree cleanup of FR4 (`removeWorktree`, `gcWorktrees`).
 *
 * This module — and the rest of `src/durable/` — is the only place that imports
 * `@earendil-works/*`. Everything above it speaks RPC/CLI types.
 */

import { existsSync } from "node:fs";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  Harness,
  createRegistry,
  defineExtension,
  type HarnessInspection,
  type Storage,
  type TaskId,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { ArgosError } from "../errors.js";
import type { GitRunner } from "../git/exec.js";
import { createRunWorktree, assertRunBaseClean, reattachRunWorktree } from "../git/worktree.js";
import type { TargetCatalog } from "../paseo/model-catalog.js";
import type { IsolationIR, PlaybookIR } from "../playbook/ir.js";
import { argosHome, dbPath } from "../paths.js";
import {
  createRunRecord,
  decideGate,
  isTerminalRunStatus,
  type GateRecord,
  type RunRecord,
  type WorktreeRecord,
} from "../engine/index.js";
import { cloneRecord, downstreamClosure, hydrateRunRecord } from "../engine/index.js";
import type { Clock, StepExecutor } from "./context.js";
import { systemClock } from "./context.js";
import { createStubModels } from "./host-models.js";
import type {
  AddScheduleInput,
  ArgosHostOptions,
  CancelRunResult,
  CommitRunOptions,
  DecideGateOptions,
  EditScheduleInput,
  GateDecisionReceipt,
  PreparedRun,
  PrepareRunOutcome,
  RemoveRunResult,
  RunChangeListener,
  RunOwnerConversation,
  RunScheduleOptions,
  RunStartPort,
  ScheduleFireEvent,
  ScheduleFireListener,
  ScheduleFireStatus,
  ScheduleRunStartInput,
  ScheduleView,
  StartedAfterTask,
  StartedRun,
  StartRunInput,
} from "./host-types.js";
import {
  ARGOS_RUN_DOC_KIND,
  EMPTY_IDEMPOTENCY_DOC,
  GateDocFamily,
  HistoryDocFamily,
  IDEMPOTENCY_TTL_MS,
  IdempotencyDocFamily,
  RunDocFamily,
  RunsIndexDoc,
  appendRunHistory,
  gateDocSeed,
  gateKey,
  registerRun,
  toGateDoc,
  toRunDoc,
  writeGateDecision,
  writeRunState,
  type GateDoc,
  type HistoryDocValue,
  type RunDoc,
  type RunDocValue,
} from "./mirror.js";
import { acquirePidFile, enforceStorageModes, releasePidFile } from "./pid.js";
import { ScheduleRunner } from "./schedules.js";
import {
  gcRunWorktrees,
  recordRunWorktree,
  removeWorktreeForRun,
  type GcWorktreesOptions,
  type GcWorktreesResult,
  type RemoveWorktreeOptions,
  type WorktreeRemovalResult,
} from "./worktrees.js";
import { planAfterRun } from "./tasks/after.js";
import { createGateTaskDefinition } from "./tasks/gate.js";
import { createAfterRunTask, createRunTaskDefinition, type RunCheckpoint } from "./tasks/run.js";
import { pinRunScripts, pinScript, type ScriptPins } from "./tasks/script-pin.js";
import { createScriptTaskDefinition } from "./tasks/script.js";
import { createStepTaskDefinition } from "./tasks/step.js";
import { ulid } from "./ulid.js";

/** D4 extension name that groups the Argos tasks. */
export const ARGOS_EXTENSION_NAME = "argos";

// ------------------------------------------------------------------ host

export class ArgosHost {
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #executor: StepExecutor;
  readonly #clock: Clock;
  readonly #models: Models;
  readonly #modelCatalog: TargetCatalog | undefined;
  readonly #runTask: ReturnType<typeof createRunTaskDefinition>;
  readonly #stepTask: ReturnType<typeof createStepTaskDefinition>;
  readonly #gateTask: ReturnType<typeof createGateTaskDefinition>;
  readonly #scriptTask: ReturnType<typeof createScriptTaskDefinition>;
  readonly #git: GitRunner | undefined;
  readonly #home: string | undefined;
  readonly #ownsPid: boolean;
  /** FR4.1: the prepare/commit halves exposed to `durable/schedules.ts` (internal, never exported). */
  readonly #startPort: RunStartPort;
  /** FR1/FR7: the schedule registry, owned by this host and never exported from the subpath. */
  readonly #schedules: ScheduleRunner;
  #closed = false;

  private constructor(init: {
    harness: Harness;
    context: Context;
    executor: StepExecutor;
    clock: Clock;
    models: Models;
    modelCatalog?: TargetCatalog;
    runTask: ReturnType<typeof createRunTaskDefinition>;
    stepTask: ReturnType<typeof createStepTaskDefinition>;
    gateTask: ReturnType<typeof createGateTaskDefinition>;
    scriptTask: ReturnType<typeof createScriptTaskDefinition>;
    git?: GitRunner;
    home: string | undefined;
    ownsPid: boolean;
  }) {
    this.#harness = init.harness;
    this.#context = init.context;
    this.#executor = init.executor;
    this.#clock = init.clock;
    this.#models = init.models;
    this.#modelCatalog = init.modelCatalog;
    this.#runTask = init.runTask;
    this.#stepTask = init.stepTask;
    this.#gateTask = init.gateTask;
    this.#scriptTask = init.scriptTask;
    this.#git = init.git;
    this.#home = init.home;
    this.#ownsPid = init.ownsPid;
    // FR4.1/FR2.4: `durable/schedules.ts` reaches the private prepare/commit halves **only** through
    // this port, so the fire and `POST /runs` cannot drift apart. Built here, not in `open`, so the
    // binding exists before any caller (and before `close()` flips `#closed`).
    this.#startPort = {
      prepare: (input) => this.#prepareRun(input, { dryRun: false }),
      commitInTx: (tx, prepared, root, options) =>
        this.#commitRun(tx, prepared, root, options),
      dryCheck: (input) => this.checkRunStart(input),
      resume: () => this.#harness.resume(),
      root: () => this.#harness.root(this.#context),
    };
    // FR1/FR7: the registry shares the host's harness, clock, home, and start port, so a schedule
    // add/edit validates exactly what a start would and Phase 5's fire commits in the same writer.
    this.#schedules = new ScheduleRunner({
      harness: this.#harness,
      context: this.#context,
      clock: this.#clock,
      ...(this.#home === undefined ? {} : { home: this.#home }),
      port: this.#startPort,
      ...(this.#git === undefined ? {} : { git: this.#git }),
      // FR9.3: retention reads and removes runs through the host's own methods, so `schedules.ts`
      // never imports `host.ts` and `removeRun` stays the only path that retires a run.
      runs: {
        get: (runId) => this.getRun(runId),
        remove: (runId) => this.removeRun(runId),
      },
    });
  }

  /**
   * Open the durable host. With no `storage`, creates `$ARGOS_HOME` (mode `0700`), takes the
   * single-writer pid file, opens `argos.sqlite` (mode `0600`), installs the Argos extension, and
   * resumes any work the previous process left behind (FR29).
   */
  static async open(options: ArgosHostOptions): Promise<ArgosHost> {
    const clock: Clock = options.clock ?? systemClock;
    const context = BACKGROUND_CONTEXT;
    const models = options.models ?? createStubModels();

    // `$ARGOS_HOME` is known before any task exists: the run task threads it to script children,
    // so a global script under `<home>/scripts` resolves without touching the run record.
    const home =
      options.storage !== undefined ? options.home : (options.home ?? argosHome());
    let ownsPid = false;

    const stepTask = createStepTaskDefinition({
      executor: options.executor,
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    const gateTask = createGateTaskDefinition();
    const scriptTask = createScriptTaskDefinition({
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    const runTask = createRunTaskDefinition({
      stepTask,
      scriptTask,
      gateTask,
      ...(home === undefined ? {} : { home }),
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: ARGOS_EXTENSION_NAME,
        tasks: [runTask, stepTask, scriptTask, gateTask],
      }),
    );

    let storage: Storage;

    if (options.storage !== undefined) {
      storage = options.storage;
      if (home !== undefined) {
        acquirePidFile(home);
        ownsPid = true;
      }
    } else {
      // No injected storage, so `home` was resolved above.
      const ownedHome = home ?? argosHome();
      acquirePidFile(ownedHome);
      ownsPid = true;
      try {
        storage = await openNodeSqliteStorage(dbPath(ownedHome));
        enforceStorageModes(ownedHome);
      } catch (error) {
        if (ownsPid) releasePidFile(ownedHome);
        throw error;
      }
    }

    const harnessOptions = {
      models,
      registry,
      now: () => clock.now(),
      ...(clock.setTimer === undefined ? {} : { setTimer: clock.setTimer.bind(clock) }),
    };

    let harness: Harness;
    try {
      harness = await Harness.open(storage, harnessOptions, context);
      await harness.root(context);
    } catch (error) {
      if (home !== undefined && ownsPid) releasePidFile(home);
      throw error;
    }

    const host = new ArgosHost({
      harness,
      context,
      executor: options.executor,
      clock,
      models,
      ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
      runTask,
      stepTask,
      gateTask,
      scriptTask,
      ...(options.git === undefined ? {} : { git: options.git }),
      home,
      ownsPid,
    });
    // FR29: a host always resumes what the last process left; `startRun` resumes again for new work.
    harness.resume();
    // FR10.4: subscribe **before** the first tick is queued, so a catch-up fire that `start()` runs
    // on the next microtask is announced like any other (a listener attached after `open()` would
    // miss it). The runner contains a throwing listener, so this cannot break opening.
    if (options.onScheduleFire !== undefined) {
      host.#schedules.observeScheduleFires(options.onScheduleFire);
    }
    // FR3.1/FR3.2: load the schedule cache and queue the first tick. `start()` awaits the cache read
    // but never the tick, so a catch-up fire runs on the next microtask and `open()` stays fast.
    await host.#schedules.start();
    return host;
  }

  /** The host conversation that owns every run task (D5). */
  get context(): Context {
    return this.#context;
  }

  /** Injected executor, exposed for assertions in tests. */
  get executor(): StepExecutor {
    return this.#executor;
  }

  /** The D6 stub (or the injected override). */
  get models(): Models {
    return this.#models;
  }

  /** The injected provider/model catalog (FR24), when the host was opened with one. */
  get modelCatalog(): TargetCatalog | undefined {
    return this.#modelCatalog;
  }

  /** `$ARGOS_HOME`, when this host owns one. */
  get home(): string | undefined {
    return this.#home;
  }

  /** The clock every durable decision used. */
  get clock(): Clock {
    return this.#clock;
  }

  /** The live harness, for tests that need `observeCommits`/`waitForTask`. */
  get harness(): Harness {
    return this.#harness;
  }

  /**
   * The start path's two halves, for the scheduler only (`durable/schedules.ts`).
   *
   * Internal: `schedules.ts` prepares outside its commit, then calls `commitInTx` inside the commit
   * that also writes the schedule document. Nothing here is exported from `argos-core/durable`.
   */
  get startPort(): RunStartPort {
    return this.#startPort;
  }

  /**
   * Create the run task and its mirror in one commit, then enable scheduling. Returns
   * immediately: the run progresses inside the harness, never on the caller's stack.
   *
   * This is the public front of `#prepareRun` + `#commitRun` (FR4.1): same order, same codes, and
   * the same single commit as before the split.
   */
  async startRun(input: StartRunInput): Promise<StartedRun> {
    const outcome = await this.#prepareRun(input, { dryRun: false });
    // D15: a retried write that already landed never creates a second task (or worktree).
    if (outcome.kind === "started") return outcome.started;
    const root = await this.#harness.root(this.#context);
    const started = await this.#harness.commit(
      (tx) => this.#commitRun(tx, outcome.prepared, root, { historyDetail: input.ir.id }),
      this.#context,
    );
    this.#harness.resume();
    return started;
  }

  /**
   * FR2.4: the dry start check `argos schedule add/edit` runs. It performs every prepare step —
   * model check, script resolution and hashing, the worktree dirtiness check, and the run-record
   * shape — and creates **no** task, run index entry, worktree, or run.
   *
   * It is `#prepareRun` with `dryRun`, so the codes are the same ones `POST /runs` would answer for
   * the same values. The idempotency fast path is part of prepare (and can only short-circuit a
   * real start); the dry check never carries a `clientRequestId`, so it always runs every check.
   */
  async checkRunStart(input: ScheduleRunStartInput): Promise<void> {
    await this.#prepareRun(input, { dryRun: true });
  }

  // ------------------------------------------------------------------ schedules (FR1, FR2, FR7)

  /**
   * FR1/FR2/FR7.1: register one schedule. The id defaults to the playbook id, the zone to the
   * server's, and `enabled: false` is `--paused`. Every value is validated as `POST /runs` would
   * (FR2.4) and, like every host method, a closed host is `storage_locked`.
   */
  async addSchedule(input: AddScheduleInput): Promise<ScheduleView> {
    this.#assertOpen();
    return this.#schedules.add(input);
  }

  /**
   * FR7.2: change the stored values of one schedule. `inputs` replaces the whole map, all merged
   * values are validated again, and `generation` advances so a fire in progress aborts in its
   * commit. An unknown id is `schedule_unknown` (FR1.7).
   */
  async editSchedule(id: string, input: EditScheduleInput): Promise<ScheduleView> {
    this.#assertOpen();
    return this.#schedules.edit(id, input);
  }

  /** FR7.3: pause — `enabled: false`, `nextFireAt: null`, `generation + 1`. */
  async pauseSchedule(id: string): Promise<ScheduleView> {
    this.#assertOpen();
    return this.#schedules.pause(id);
  }

  /** FR7.4: resume — `nextFireAt` computed from now, so a pause is never caught up. */
  async resumeSchedule(id: string): Promise<ScheduleView> {
    this.#assertOpen();
    return this.#schedules.resume(id);
  }

  /** FR7.5: retire the document and drop the id from the index in one commit. */
  async removeSchedule(id: string): Promise<void> {
    this.#assertOpen();
    await this.#schedules.remove(id);
  }

  /** One schedule, or `undefined` when the id is not in the index (the route answers 404). */
  async getSchedule(id: string): Promise<ScheduleView | undefined> {
    this.#assertOpen();
    return this.#schedules.get(id);
  }

  /** Every schedule, sorted by id (FR10.1). */
  async listSchedules(): Promise<ScheduleView[]> {
    this.#assertOpen();
    return this.#schedules.list();
  }

  /**
   * FR7.6: `argos schedule run` / `POST /schedules/:id/run`. It serializes behind any tick or fire
   * that is already in flight (FR3.9), never changes `nextFireAt`, and applies the same overlap rule
   * as a timer fire — `run_active` naming the live run when `overlap: skip` holds. A refusal for any
   * other reason is recorded in the fire log (FR6.1) and rethrown to the caller.
   */
  async runSchedule(id: string, options: RunScheduleOptions = {}): Promise<StartedRun> {
    this.#assertOpen();
    return this.#schedules.runNow(id, options);
  }

  /**
   * FR10.4: subscribe to fire outcomes. One event per fire-log entry written, after its commit
   * landed. The returned function detaches the listener; a listener that throws is contained by the
   * runner, so `argos serve`'s stderr line can never stop a schedule.
   */
  observeScheduleFires(listener: ScheduleFireListener): () => void {
    return this.#schedules.observeScheduleFires(listener);
  }

  /** Every host entry point refuses once `close()` ran, with the existing `storage_locked` code. */
  #assertOpen(): void {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
  }

  /**
   * The read-only front half of a start (FR4.1), in this exact order:
   *
   * 1. the model-catalog check (FR24), before any task exists;
   * 2. the D15 idempotency fast path, which may return the original receipt instead;
   * 3. the run id (`input.id`, else a fresh ULID);
   * 4. the FR3 script pins, before the worktree exists;
   * 5. the worktree (FR23/D9), or — for `dryRun` — the same dirtiness refusal without creating it;
   * 6. the run record, with the optional schedule `trigger` (FR8.1).
   *
   * It never writes. A refusal therefore leaves no task, no index entry, and no checkout behind.
   */
  async #prepareRun(
    input: ScheduleRunStartInput,
    options: { readonly dryRun: boolean },
  ): Promise<PrepareRunOutcome> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    // FR24: refuse an off-catalog run before any task exists, naming every unknown target.
    if (this.#modelCatalog !== undefined) {
      const missing = this.#modelCatalog.missingTargets(input.ir, input.inputs);
      if (missing.length > 0) {
        throw new ArgosError(
          "model_unavailable",
          `playbook ${input.ir.id}: unknown provider/model target(s): ${missing.join(", ")}; check providers.snapshot()`,
        );
      }
    }
    const now = this.#clock.now();
    const clientRequestId = input.clientRequestId;
    // D15 fast path: a retried write that already landed never creates a second task (or worktree).
    if (clientRequestId !== undefined) {
      const existing = await this.#idempotentRun(clientRequestId, now);
      if (existing !== undefined) return { kind: "started", started: existing };
    }
    const runId = input.id ?? ulid(this.#clock.now());
    // FR3.1/FR3.2: every script the frozen IR can dispatch is pinned **before** the worktree
    // exists. A missing or non-executable script is `playbook_invalid` naming the step, so the
    // caller gets the error with no task and no checkout (and a script an earlier step would have
    // created is refused here — the documented compat divergence).
    const scripts = pinRunScripts(input.ir, input.cwd, this.#home);
    // FR23/D9: an isolated run works in its own worktree from a freshly fetched base. The worktree
    // is created **before** the run task exists, so a dirty base or a missing ref refuses the run
    // with `worktree_base_dirty` / `worktree_failed` and no agent is ever launched. The dry check
    // gets the same refusals from the same implementation, without creating anything (FR2.4).
    const worktree =
      input.worktree ??
      (options.dryRun
        ? await this.#checkWorktree(input.ir, input.cwd, input.isolation)
        : await this.#prepareWorktree(input.ir, input.cwd, runId, input.isolation));
    const record = createRunRecord({
      id: runId,
      ir: input.ir,
      inputs: input.inputs,
      cwd: input.cwd,
      now,
      ...(worktree === undefined ? {} : { worktree }),
      ...(scripts === undefined ? {} : { scripts }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    });
    return {
      kind: "prepared",
      prepared: {
        runId,
        record,
        now,
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      },
    };
  }

  /**
   * The write half of a start (FR4.1): the D15 re-check, the run task (D4/D5), the mirror plus its
   * `run_started` history event, the run index entry, and the idempotency receipt — all inside the
   * caller's single commit. A schedule fire calls this from the commit that also writes the
   * schedule document, so the run and its fire marker can never disagree.
   */
  async #commitRun(
    tx: Tx,
    prepared: PreparedRun,
    root: RunOwnerConversation,
    options: CommitRunOptions,
  ): Promise<StartedRun> {
    const { runId, record, now, clientRequestId } = prepared;
    // Re-check inside the commit: two concurrent requests with one clientRequestId serialize here.
    if (clientRequestId !== undefined) {
      const doc = await tx.doc(IdempotencyDocFamily, clientRequestId, EMPTY_IDEMPOTENCY_DOC);
      if (doc.runId !== "" && now - doc.createdAt < IDEMPOTENCY_TTL_MS) {
        return { runId: doc.runId, taskId: doc.taskId };
      }
    }
    // D4/D5: the run task is conversation-owned by the host's root conversation.
    const id = await tx.createTask(
      this.#runTask,
      {
        runId,
        record,
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      },
      { ownership: { kind: "conversation" }, conversationId: root.id },
    );
    await writeRunState(tx, id, record, {
      type: "run_started",
      detail: options.historyDetail,
    });
    await registerRun(tx, runId);
    if (clientRequestId !== undefined) {
      const doc = await tx.doc(IdempotencyDocFamily, clientRequestId, EMPTY_IDEMPOTENCY_DOC);
      doc.runId = runId;
      doc.taskId = String(id);
      doc.createdAt = now;
    }
    return { runId, taskId: String(id) };
  }

  /** D15: the receipt of a fresh `clientRequestId`, or `undefined` when absent/expired. */
  async #idempotentRun(clientRequestId: string, now: number): Promise<StartedRun | undefined> {
    const value = await this.#harness.snapshot(
      IdempotencyDocFamily,
      clientRequestId,
      this.#context,
    );
    if (value === undefined) return undefined;
    if (value.runId === "" || now - value.createdAt >= IDEMPOTENCY_TTL_MS) return undefined;
    return { runId: value.runId, taskId: value.taskId };
  }

  /** Continue every unfinished task (FR29). Idempotent. */
  resume(): void {
    this.#harness.resume();
  }

  /**
   * The dry counterpart of {@link #prepareWorktree} (FR2.4): report the same
   * `worktree_failed`/`worktree_base_dirty` refusals without creating the checkout. `undefined` in
   * the return type keeps the caller's expression identical to the real prepare (`??`).
   */
  async #checkWorktree(
    ir: PlaybookIR,
    cwd: string,
    override: IsolationIR | undefined,
  ): Promise<undefined> {
    const isolation = override ?? ir.isolation;
    if (isolation === undefined || isolation.mode !== "worktree") return undefined;
    this.#assertWorktreeHome(ir);
    // One implementation with `createRunWorktree`: the dry check only inspects the base working
    // tree, so no branch, directory, or fetch result is produced.
    await assertRunBaseClean({
      repo: cwd,
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
    return undefined;
  }

  /** The shared "isolation needs a home" refusal, so the dry and the real prepare agree. */
  #assertWorktreeHome(ir: PlaybookIR): string {
    if (this.#home === undefined) {
      throw new ArgosError(
        "worktree_failed",
        `playbook ${ir.id}: isolation.mode "worktree" needs an ARGOS_HOME for <home>/worktrees/<runId>; open the host with one`,
      );
    }
    return this.#home;
  }

  /**
   * Create the run's worktree when isolation asks for one. `undefined` means "work in `cwd`"
   * (`isolation.mode: none`, the default). Errors are the D9 codes and are thrown before the run
   * task exists: the caller (CLI/RPC) gets `worktree_base_dirty` or `worktree_failed` and no agent
   * is ever created.
   */
  async #prepareWorktree(
    ir: PlaybookIR,
    cwd: string,
    runId: string,
    override: IsolationIR | undefined,
  ): Promise<WorktreeRecord | undefined> {
    const isolation = override ?? ir.isolation;
    if (isolation === undefined || isolation.mode !== "worktree") return undefined;
    const home = this.#assertWorktreeHome(ir);
    return createRunWorktree({
      repo: cwd,
      home,
      runId,
      ...(isolation.base === undefined ? {} : { base: isolation.base }),
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
  }

  /**
   * FR4.7: re-attach the run's branch when its checkout directory is gone — after `argos worktree
   * rm`, or a directory deleted out of band. The path comes from the record-only guard, so a
   * tampered record is `worktree_failed` instead of a checkout somewhere unexpected. The branch is
   * **never** re-created: a deleted one refuses the retry before any task exists.
   */
  async #reattachWorktreeIfMissing(record: RunRecord): Promise<void> {
    const worktree = record.worktree;
    if (worktree === undefined || existsSync(worktree.path)) return;
    if (this.#home === undefined) {
      throw new ArgosError(
        "worktree_failed",
        `run ${record.id}: worktree ${worktree.path} is gone and re-attaching it needs an ARGOS_HOME`,
      );
    }
    recordRunWorktree(record.id, record, this.#home);
    await reattachRunWorktree({
      repo: record.cwd,
      home: this.#home,
      runId: record.id,
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
  }

  /**
   * Close the schedule runner, then the harness (and with it SQLite), then release the pid file.
   * Idempotent. A fire already inside `prepare` settles before the harness closes (FR3.2).
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#schedules.close();
      await this.#harness.close(this.#context);
    } finally {
      if (this.#home !== undefined && this.#ownsPid) releasePidFile(this.#home);
    }
  }

  /**
   * FR3.2: wait until the schedule runner has no queued or running tick/fire. This is the
   * deterministic seam the scheduler tests use instead of sleeping; nothing in production needs it.
   */
  async scheduleIdle(): Promise<void> {
    await this.#schedules.idle();
  }

  /** The mirrored run document, or `undefined` for an unknown run. */
  async getRun(runId: string): Promise<RunDoc | undefined> {
    const value = await this.#harness.snapshot(RunDocFamily, runId, this.#context);
    return value === undefined ? undefined : toRunDoc(value);
  }

  /** The decision document of one gate, or `undefined` when the gate was never opened. */
  async getGate(runId: string, gateId: string): Promise<GateDoc | undefined> {
    const value = await this.#harness.snapshot(
      GateDocFamily,
      gateKey(runId, gateId),
      this.#context,
    );
    return value === undefined ? undefined : toGateDoc(value);
  }

  /**
   * Decide one gate (FR19, FR20). The document read and the decision write happen inside **one**
   * commit, so the first writer wins: a second decision fails with `gate_already_decided` naming
   * the winning decision, an unknown gate or an out-of-choice decision fails with `gate_unknown`,
   * and a finished run fails with `run_terminal`. The run task applies the decision through the
   * engine reducer as soon as its `argos.gate` child reads it (a 2 s poll, D7).
   */
  async decideGate(
    runId: string,
    gateId: string,
    decision: string,
    options: DecideGateOptions = {},
  ): Promise<GateDecisionReceipt> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const runDoc = await this.#harness.snapshot(RunDocFamily, runId, this.#context);
    if (runDoc === undefined) {
      throw new ArgosError("gate_unknown", `unknown run "${runId}": gate ${gateId} cannot be decided`);
    }
    const runTaskId = Number(runDoc.taskId);
    const decidedAt = this.#clock.now();
    const receipt: GateDecisionReceipt = {
      runId,
      gateId,
      decision,
      decidedAt,
      ...(options.comment === undefined ? {} : { comment: options.comment }),
      ...(options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }),
      ...(options.decidedVia === undefined ? {} : { decidedVia: options.decidedVia }),
    };
    // D15 fast path: the exact same client request (same gate, decision, and request id) already
    // won the race; report the winning receipt instead of `gate_already_decided`.
    const replay = await this.#replayedDecision(runId, gateId, decision, options.clientRequestId);
    if (replay !== undefined) return replay;

    let replayed: GateDecisionReceipt | undefined;
    await this.#harness.commit(async (tx) => {
      // Re-read the live checkpoint inside the commit: it is fresher than the mirror when the run
      // task is still working (the mirror is written in the same commit, so they never diverge).
      const task = Number.isInteger(runTaskId)
        ? await tx.task(runTaskId as TaskId)
        : undefined;
      const state = task?.state;
      const record =
        state !== undefined && "checkpoint" in state && state.checkpoint !== undefined
          ? (state.checkpoint as unknown as RunCheckpoint).record
          : (runDoc.record as unknown as RunRecord);
      // Same re-check inside the single-writer commit: concurrent identical decisions serialize.
      const gateRecord = record.gates.find((candidate) => candidate.id === gateId);
      if (gateRecord !== undefined && options.clientRequestId !== undefined) {
        const doc = await tx.doc(
          GateDocFamily,
          gateKey(runId, gateId),
          gateDocSeed(runId, gateRecord),
        );
        if (
          doc.status === "decided" &&
          doc.decision === decision &&
          doc.clientRequestId === options.clientRequestId
        ) {
          replayed = {
            runId,
            gateId,
            decision,
            decidedAt: doc.decidedAt ?? decidedAt,
            ...(doc.comment === null ? {} : { comment: doc.comment }),
            ...(doc.decidedBy === null ? {} : { decidedBy: doc.decidedBy }),
            ...(doc.decidedVia === null ? {} : { decidedVia: doc.decidedVia }),
          };
          return;
        }
      }
      const plan = decideGate(record, {
        gateId,
        decision,
        decidedAt,
        ...(options.comment === undefined ? {} : { comment: options.comment }),
        ...(options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }),
        ...(options.decidedVia === undefined ? {} : { decidedVia: options.decidedVia }),
      });
      if (plan.rejection !== undefined) {
        throw new ArgosError(plan.rejection.code, plan.rejection.message);
      }
      const gate = plan.gate as GateRecord;
      const written = await writeGateDecision(tx, runId, gate, {
        decision,
        decidedAt,
        ...(options.comment === undefined ? {} : { comment: options.comment }),
        ...(options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }),
        ...(options.decidedVia === undefined ? {} : { decidedVia: options.decidedVia }),
        ...(options.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      });
      if (!written.written) {
        throw new ArgosError(
          "gate_already_decided",
          `gate ${gateId} was already decided "${written.decision ?? "unknown"}" at ${written.decidedAt ?? 0}`,
        );
      }
    }, this.#context);

    this.#harness.resume();
    return replayed ?? receipt;
  }

  /** D15: an already-decided gate whose stored request id matches this exact request. */
  async #replayedDecision(
    runId: string,
    gateId: string,
    decision: string,
    clientRequestId: string | undefined,
  ): Promise<GateDecisionReceipt | undefined> {
    if (clientRequestId === undefined) return undefined;
    const doc = await this.getGate(runId, gateId);
    if (doc === undefined || doc.status !== "decided") return undefined;
    if (doc.decision !== decision || doc.clientRequestId !== clientRequestId) return undefined;
    return {
      runId,
      gateId,
      decision,
      decidedAt: doc.decidedAt ?? this.#clock.now(),
      ...(doc.comment === undefined ? {} : { comment: doc.comment }),
      ...(doc.decidedBy === undefined ? {} : { decidedBy: doc.decidedBy }),
      ...(doc.decidedVia === undefined ? {} : { decidedVia: doc.decidedVia }),
    };
  }

  /**
   * Start a `manual` after-task (FR11). The run must have reached a terminal status, the entry
   * must exist, and it starts at most once: an entry that is already running/settled returns
   * `started: false`. The child is conversation-owned (pi-durable refuses a child of a terminal
   * owner) and carries the parent link, so it reports its own completion into the parent mirror's
   * `after[id]` state.
   */
  async startAfterTask(runId: string, afterId: string): Promise<StartedAfterTask> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const runDoc = await this.#harness.snapshot(RunDocFamily, runId, this.#context);
    if (runDoc === undefined) {
      throw new ArgosError("playbook_missing", `unknown run "${runId}": no after-task ${afterId}`);
    }
    const record = runDoc.record as unknown as RunRecord;
    const after = record.ir.after.find((candidate) => candidate.id === afterId);
    if (after === undefined) {
      throw new ArgosError(
        "playbook_missing",
        `run ${runId}: after-task "${afterId}" is not part of playbook ${record.playbookId}`,
      );
    }
    if (!isTerminalRunStatus(record.status)) {
      throw new ArgosError(
        "run_terminal",
        `run ${runId} is ${record.status}; after-tasks start once the main graph is terminal`,
      );
    }
    const state = record.after[afterId];
    if (state === undefined || state.status !== "pending") {
      return { runId, afterId, started: false };
    }

    const now = this.#clock.now();
    const planned = planAfterRun(record, after, now);
    const root = await this.#harness.root(this.#context);
    const taskId = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(RunDocFamily, runId, {
        taskId: runDoc.taskId,
        record: runDoc.record,
      });
      const current = doc.record as unknown as RunRecord;
      const entry = current.after[afterId];
      if (entry === undefined || entry.status !== "pending") return undefined;
      const patched: RunRecord = {
        ...current,
        after: { ...current.after, [afterId]: { status: "running", startedAt: now } },
        updatedAt: Math.max(current.updatedAt, now),
        seq: current.seq + 1,
      };
      doc.record = patched as unknown as RunDocValue["record"];
      const id = await createAfterRunTask(tx, this.#runTask, planned, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
        history: { type: "run_started", detail: `${runId}/${afterId}` },
      });
      await appendRunHistory(tx, runId, patched, { type: "after_start", detail: afterId });
      return id;
    }, this.#context);

    this.#harness.resume();
    if (taskId === undefined) return { runId, afterId, started: false };
    return { runId, afterId, started: true, taskId: String(taskId) };
  }

  /**
   * Cancel a live run (FR25 `argos cancel`). The abort handler routes the cancellation through the
   * reducer, so the mirrored record becomes `cancelled`; the caller waits for that terminal state.
   * A finished run is refused with `run_terminal`, an unknown one with `run_unknown`.
   */
  async cancelRun(runId: string): Promise<CancelRunResult> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const doc = await this.getRun(runId);
    if (doc === undefined) {
      throw new ArgosError("run_unknown", `unknown run "${runId}"`);
    }
    if (isTerminalRunStatus(doc.record.status)) {
      throw new ArgosError(
        "run_terminal",
        `run ${runId} is already ${doc.record.status}; nothing to cancel`,
      );
    }
    const taskId = Number(doc.taskId);
    if (!Number.isInteger(taskId)) {
      throw new ArgosError("run_unknown", `run ${runId}: task ${doc.taskId} is not numeric`);
    }
    const outcome = await this.#harness.abortTask(taskId as TaskId, this.#context);
    if (outcome !== "terminal") {
      await this.#harness.waitForTask(taskId as TaskId, this.#context);
    }
    const after = await this.getRun(runId);
    return { runId, status: after?.record.status ?? "cancelled" };
  }

  /**
   * Remove a finished run (`argos rm`). Retires the run, history, gate, and idempotency documents
   * and drops the id from the runs index in **one** commit, so a reader sees the whole run or none
   * of it. A live run (or one with a running after-task) is refused with `run_terminal`: cancel it
   * first. The terminal task records stay in storage (pi-durable keeps them); nothing reads them
   * once the mirror is gone. The worktree is **not** removed and is reported back instead.
   */
  async removeRun(runId: string): Promise<RemoveRunResult> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const doc = await this.getRun(runId);
    if (doc === undefined) {
      throw new ArgosError("run_unknown", `unknown run "${runId}"`);
    }
    assertRemovable(runId, doc.record);
    const clientRequestId = await this.#runClientRequestId(doc.taskId);

    const removed = await this.#harness.commit(async (tx) => {
      // Re-check inside the single-writer commit: a retry or after-task may have started since.
      const current = await tx.doc(RunDocFamily, runId, {
        taskId: doc.taskId,
        record: doc.record as unknown as RunDocValue["record"],
      });
      const record = current.record as unknown as RunRecord;
      assertRemovable(runId, record);
      for (const gate of record.gates) {
        await tx.retireDoc(GateDocFamily, gateKey(runId, gate.id));
      }
      await tx.retireDoc(HistoryDocFamily, runId);
      await tx.retireDoc(RunDocFamily, runId);
      if (clientRequestId !== undefined) {
        const receipt = await tx.doc(IdempotencyDocFamily, clientRequestId, EMPTY_IDEMPOTENCY_DOC);
        // Only drop a receipt that still names this run: the key may have been reused after expiry.
        if (receipt.runId === runId) await tx.retireDoc(IdempotencyDocFamily, clientRequestId);
      }
      const index = await tx.doc(RunsIndexDoc);
      const at = index.ids.indexOf(runId);
      if (at >= 0) index.ids.splice(at, 1);
      // Copy plain values out: the draft cannot be read once the commit has settled.
      const worktree = record.worktree?.path;
      const result: RemoveRunResult = {
        runId,
        status: record.status,
        ...(worktree === undefined ? {} : { worktree }),
      };
      return result;
    }, this.#context);
    return removed;
  }

  /**
   * Remove one run's worktree (`argos worktree rm`, FR4.1–FR4.4). The path and branch come from the
   * mirrored record only, never from the caller: an unknown run is `run_unknown`, a run that has not
   * finished is `run_active`, and a run that never had a worktree is a `removed: false` receipt.
   * Without `force` a dirty checkout is refused with `worktree_failed`; the branch is kept unless
   * `deleteBranch` is asked for.
   */
  async removeWorktree(
    runId: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<WorktreeRemovalResult> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const doc = await this.getRun(runId);
    return removeWorktreeForRun({
      runId,
      record: doc?.record,
      home: this.#home,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
  }

  /**
   * Remove the worktrees of terminal runs older than `olderThanMs` (`argos worktree gc`, FR4.5).
   * Selection is by the mirrored `updatedAt`; a run that is still live is skipped as `active`
   * rather than racing it, per-run failures are reported as `skipped` reasons, and directories under
   * `<home>/worktrees` that no run index entry claims are returned as `orphans` (never deleted).
   */
  async gcWorktrees(options: GcWorktreesOptions): Promise<GcWorktreesResult> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    if (this.#home === undefined) {
      throw new ArgosError(
        "worktree_failed",
        "worktree gc needs an ARGOS_HOME for <home>/worktrees/<runId>; open the host with one",
      );
    }
    const docs = await this.listRuns();
    return gcRunWorktrees({
      home: this.#home,
      runs: docs.map((doc) => ({ runId: doc.record.id, record: doc.record })),
      now: this.#clock.now(),
      olderThanMs: options.olderThanMs,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
  }

  /** The `clientRequestId` the run's task was created with, if any (D15 receipt to retire). */
  async #runClientRequestId(taskId: string): Promise<string | undefined> {
    const task = await this.getTaskRecord(taskId);
    const input = task?.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = (input as Record<string, unknown>)["clientRequestId"];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /**
   * Retry a terminal run from one step (FR25 `argos retry`).
   *
   * A **new** `argos.run` task is created from the mirrored record with the given step and every
   * transitively downstream step reset to `pending` (outputs and attempt history are kept, loop
   * counters and quota exhaustion stay), and the same `runId` — the old checkpoint is never
   * mutated. The retried run then goes through the normal `select → … → done` machine, so gates,
   * loops, and `when` behave exactly like a first run. A `retry` history event records the step.
   */
  async retryStep(runId: string, stepId: string): Promise<StartedRun> {
    if (this.#closed) throw new ArgosError("storage_locked", "argos host is closed");
    const doc = await this.getRun(runId);
    if (doc === undefined) {
      throw new ArgosError("run_unknown", `unknown run "${runId}"`);
    }
    if (!isTerminalRunStatus(doc.record.status)) {
      throw new ArgosError(
        "run_terminal",
        `run ${runId} is ${doc.record.status}; cancel it before retrying a step`,
      );
    }
    const record = doc.record;
    if (record.ir.steps.every((step) => step.id !== stepId)) {
      throw new ArgosError(
        "step_unknown",
        `run ${runId}: step "${stepId}" is not part of playbook ${record.playbookId}`,
      );
    }
    // FR4.7: `argos worktree rm` keeps the branch, so a retry re-attaches it instead of re-cutting
    // the checkout from the base. A branch that is gone refuses the retry before any task exists.
    await this.#reattachWorktreeIfMissing(record);

    const now = this.#clock.now();
    const draft = cloneRecord(record);
    const closure = downstreamClosure(record.ir, [stepId]);
    // FR3.4/D2: a retry is the operator's re-pin. Every script step in the reset closure is hashed
    // again; a script that is gone refuses the retry before any task exists, and each changed
    // digest is reported as a `script_repinned` history event (old → new) in the retry commit.
    const repinned =
      record.scripts === undefined
        ? { pins: undefined as ScriptPins | undefined, events: [] as readonly RepinnedScript[] }
        : this.#repinClosure(record, closure);
    if (repinned.pins !== undefined) draft.scripts = repinned.pins;
    for (const id of closure) {
      const step = draft.steps[id];
      if (step === undefined) continue;
      step.status = "pending";
      delete step.notBefore;
      delete step.outcome;
      delete step.errorCode;
      delete step.feedback;
    }
    draft.status = "pending";
    delete draft.outcome;
    delete draft.errorCode;
    draft.updatedAt = Math.max(record.updatedAt, now);
    draft.seq = record.seq + 1;
    const retried = hydrateRunRecord(draft);

    const root = await this.#harness.root(this.#context);
    const taskId = await this.#harness.commit(async (tx) => {
      const id = await tx.createTask(
        this.#runTask,
        { runId, record: retried },
        { ownership: { kind: "conversation" }, conversationId: root.id },
      );
      await writeRunState(tx, id, retried, {
        type: "retry",
        stepId,
        detail: `retry from ${stepId}`,
      });
      for (const event of repinned.events) {
        await appendRunHistory(tx, runId, retried, {
          type: "script_repinned",
          stepId: event.stepId,
          detail: event.detail,
        });
      }
      await registerRun(tx, runId);
      return id;
    }, this.#context);

    this.#harness.resume();
    return { runId, taskId: String(taskId) };
  }

  /**
   * Re-pin every script step in `closure` (FR3.4). Returns the updated pin map (undefined when the
   * record has none) plus one history line per script whose digest changed. A script that cannot be
   * resolved or read is `playbook_invalid` naming the step: the retry is refused before any write.
   */
  #repinClosure(
    record: RunRecord,
    closure: readonly string[],
  ): { readonly pins: ScriptPins; readonly events: readonly RepinnedScript[] } {
    const pins: Record<string, { path: string; sha256: string }> = { ...record.scripts };
    const events: { stepId: string; detail: string }[] = [];
    const seen = new Set<string>();
    for (const id of closure) {
      const definition = record.ir.steps.find((candidate) => candidate.id === id);
      const name = definition?.script?.run;
      if (definition === undefined || name === undefined || seen.has(name)) continue;
      seen.add(name);
      let pin;
      try {
        pin = pinScript(record.cwd, name, this.#home);
      } catch (error) {
        throw new ArgosError(
          "playbook_invalid",
          `run ${record.id}: step ${definition.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
          { stepId: definition.id, cause: error },
        );
      }
      const previous = record.scripts?.[name];
      pins[name] = pin;
      if (previous === undefined || previous.sha256 !== pin.sha256 || previous.path !== pin.path) {
        events.push({
          stepId: definition.id,
          detail: `${name}: ${previous?.sha256 ?? "unpinned"} -> ${pin.sha256}`,
        });
      }
    }
    return { pins, events };
  }

  /**
   * Every run mirror (FR25 `argos ls`, FR26 `GET /runs`). Reads the session document family only:
   * prompts, transcripts, and task checkpoints never cross this boundary.
   */
  async listRuns(): Promise<RunDoc[]> {
    const index = await this.#harness.snapshot(RunsIndexDoc, this.#context);
    if (index === undefined) return [];
    const runs: RunDoc[] = [];
    for (const value of index.ids) {
      if (typeof value !== "string") continue;
      const doc = await this.getRun(value);
      if (doc !== undefined) runs.push(doc);
    }
    return runs;
  }

  /**
   * Observe run-mirror commits (FR26 SSE). `listener` runs inside the commit publication and must
   * only record the id, never call the host back: the server schedules its own read (`setTimeout`)
   * and then serves the summary. The returned function detaches the observer.
   */
  observeRuns(listener: RunChangeListener): () => void {
    const observation = this.#harness.observeCommits({
      advance: (publication) => {
        const seen = new Set<string>();
        for (const change of publication.changes) {
          if (change.type !== "document") continue;
          if (change.record.kind !== ARGOS_RUN_DOC_KIND) continue;
          const key = change.record.key;
          if (key === undefined || seen.has(key)) continue;
          seen.add(key);
          listener(key);
        }
      },
      end: () => undefined,
    });
    return () => {
      observation.detach();
    };
  }

  /** The bounded history document of one run. */
  async getHistory(runId: string): Promise<Readonly<HistoryDocValue> | undefined> {
    return this.#harness.snapshot(HistoryDocFamily, runId, this.#context);
  }

  /** The durable task record (checkpoint included while it is live). */
  getTaskRecord<R = unknown>(
    taskId: string,
  ): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
    const numeric = Number(taskId);
    if (!Number.isInteger(numeric)) return Promise.resolve(undefined);
    return this.#harness.getTask<R>(numeric as TaskId<R>, this.#context);
  }

  /** Live tasks and unsettled submissions; the D6 guard test reads this. */
  inspect(): Promise<HarnessInspection> {
    return this.#harness.inspect(this.#context);
  }
}

// ------------------------------------------------------------------ re-exports

// FR5.2 is a pure move: the D6 stub and the public option/result types still come from this
// module, by name, so `argos-core/durable` keeps exactly the same surface.
export { createStubModels };
export type {
  AddScheduleInput,
  ArgosHostOptions,
  CancelRunResult,
  DecideGateOptions,
  EditScheduleInput,
  GateDecisionReceipt,
  RemoveRunResult,
  RunChangeListener,
  RunScheduleOptions,
  ScheduleFireEvent,
  ScheduleFireListener,
  ScheduleFireStatus,
  ScheduleView,
  StartedAfterTask,
  StartedRun,
  StartRunInput,
};
// FR4 cleanup types, by name: the host methods are the only way to reach them.
export type {
  GcRemovedWorktree,
  GcSkippedWorktree,
  GcWorktreesOptions,
  GcWorktreesResult,
  RemoveWorktreeOptions,
  WorktreeRemovalResult,
} from "./worktrees.js";

/** One `script_repinned` history line (FR3.4): which step, and `<name>: <from> -> <to>`. */
interface RepinnedScript {
  readonly stepId: string;
  readonly detail: string;
}

/** `removeRun` refuses a run whose main graph or any after-task is still going. */
function assertRemovable(runId: string, record: RunRecord): void {
  if (!isTerminalRunStatus(record.status)) {
    throw new ArgosError(
      "run_terminal",
      `run ${runId} is ${record.status}; cancel it before removing it`,
    );
  }
  const running = Object.entries(record.after).find(([, state]) => state.status === "running");
  if (running !== undefined) {
    throw new ArgosError(
      "run_terminal",
      `run ${runId}: after-task "${running[0]}" is still running; wait for it before removing the run`,
    );
  }
}
