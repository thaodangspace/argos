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
 * - expose `startRun`, `resume`, `close`, `getRun`, `getHistory`, `getTaskRecord`, `inspect`.
 *
 * This module — and the rest of `src/durable/` — is the only place that imports
 * `@earendil-works/*`. Everything above it speaks RPC/CLI types.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { ArgosError } from "../errors.js";
import type { GitRunner } from "../git/exec.js";
import { createRunWorktree } from "../git/worktree.js";
import type { TargetCatalog } from "../paseo/model-catalog.js";
import type { IsolationIR, PlaybookIR, Scalar } from "../playbook/ir.js";
import { argosHome, dbPath, ensureHome, pidPath } from "../paths.js";
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
import { planAfterRun } from "./tasks/after.js";
import { createGateTaskDefinition } from "./tasks/gate.js";
import { createAfterRunTask, createRunTaskDefinition, type RunCheckpoint } from "./tasks/run.js";
import { createScriptTaskDefinition } from "./tasks/script.js";
import { createStepTaskDefinition } from "./tasks/step.js";
import { ulid } from "./ulid.js";

/** D4 extension name that groups the Argos tasks. */
export const ARGOS_EXTENSION_NAME = "argos";

/** Messages used by the D6 guard: the stub must fail loudly, never silently. */
const STUB_MODELS_MESSAGE =
  "argos: the durable host has no model access; control flow is decided by the engine (FR21)";

/**
 * D6: a `Models` stand-in that throws on any use. `Harness.open` reads `getAuth` once (to bind
 * it into its identity wrapper), so the property must exist — calling it throws like everything
 * else. No `pi.generation` task can be scheduled because nothing ever obtains a model.
 */
export function createStubModels(): Models {
  const touched = (): never => {
    throw new Error(STUB_MODELS_MESSAGE);
  };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || property === "then" || property === "toJSON") {
          return undefined;
        }
        // `Harness.open` binds `getAuth` once into its identity wrapper; that binding is the only
        // eager read. Calling it (or reading any other member) fails loudly.
        if (property === "getAuth") return touched;
        throw new Error(STUB_MODELS_MESSAGE);
      },
      // `withClientIdentity` checks `"setProvider" in models`; a false answer keeps the wrapper
      // read-only, which is all the stub needs to be.
      has: () => false,
    },
  ) as unknown as Models;
}

// ------------------------------------------------------------------ pid file

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: alive but owned by another user; still a live writer.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(home: string): number | undefined {
  try {
    const raw = readFileSync(pidPath(home), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Take the single-writer pid file. A live owner refuses the open with `storage_locked`; a stale
 * file (dead process, unreadable content) is replaced.
 */
function acquirePidFile(home: string): void {
  ensureHome(home);
  const file = pidPath(home);
  const owner = readPid(home);
  if (owner !== undefined && owner !== process.pid && processIsAlive(owner)) {
    throw new ArgosError(
      "storage_locked",
      `${file}: another argos process (pid ${owner}) owns this home; stop it first`,
    );
  }
  if (owner === process.pid) {
    throw new ArgosError(
      "storage_locked",
      `${file}: this process already owns this home (pid ${owner}); close the other ArgosHost`,
    );
  }
  writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
}

/** Remove the pid file only when it still names this process. */
function releasePidFile(home: string): void {
  if (readPid(home) !== process.pid) return;
  rmSync(pidPath(home), { force: true });
}

// ------------------------------------------------------------------ host

export interface ArgosHostOptions {
  /** `$ARGOS_HOME`; default {@link argosHome}. Ignored when `storage` is supplied. */
  readonly home?: string;
  /** Injected storage (MemoryStorage in fast unit tests). Skips the home/pid setup. */
  readonly storage?: Storage;
  readonly executor: StepExecutor;
  /** Injected clock; default wall time. The harness clock and every timeout use it. */
  readonly clock?: Clock;
  /** Override the D6 stub (tests only; production leaves it unset). */
  readonly models?: Models;
  /**
   * Provider/model catalog (FR24). When supplied, `startRun` refuses a run whose resolved
   * `provider/model` is missing with `model_unavailable` **before** creating any task. Phase 4
   * tests leave it unset, so the durable host stays independent of Paseo.
   */
  readonly modelCatalog?: TargetCatalog;
  /**
   * Injected git port for worktree creation and read-only snapshots (D9). Production leaves it
   * unset: `execFile("git", [...])` is the only implementation that ships.
   */
  readonly git?: GitRunner;
}

export interface StartRunInput {
  readonly ir: PlaybookIR;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly cwd: string;
  readonly worktree?: WorktreeRecord;
  readonly deadline?: number;
  /** Explicit run id (tests / idempotent callers); default `ulid()`. */
  readonly id?: string;
  /**
   * Isolation override for this run (Phase 8's `argos run --isolation`). Default: the frozen IR's
   * `isolation` block, which the loader already resolved from playbook/defaults.
   */
  readonly isolation?: IsolationIR;
  /**
   * D15: idempotency key for `POST /runs`. A repeated request with the same id returns the run the
   * first request created instead of starting a second one.
   */
  readonly clientRequestId?: string;
}

export interface StartedRun {
  readonly runId: string;
  readonly taskId: string;
}

/** Result of `cancelRun`: the status the mirrored record reached. */
export interface CancelRunResult {
  readonly runId: string;
  readonly status: RunRecord["status"];
}

/** A run document changed (after-tasks included). Returned by {@link ArgosHost.observeRuns}. */
export type RunChangeListener = (runId: string) => void;

/** What `decideGate` wrote; idempotent by `gateId` (the first writer wins). */
export interface GateDecisionReceipt {
  readonly runId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt: number;
}

export interface DecideGateOptions {
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  /** D15: makes a retried `POST /runs/:id/gates/:gateId` a no-op success. */
  readonly clientRequestId?: string;
}

/** Result of `startAfterTask` (FR11). `started: false` means it was already started/settled. */
export interface StartedAfterTask {
  readonly runId: string;
  readonly afterId: string;
  readonly started: boolean;
  readonly taskId?: string;
}

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

    const stepTask = createStepTaskDefinition({
      executor: options.executor,
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    const gateTask = createGateTaskDefinition();
    const scriptTask = createScriptTaskDefinition({
      ...(options.git === undefined ? {} : { git: options.git }),
    });
    const runTask = createRunTaskDefinition({ stepTask, scriptTask, gateTask });
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: ARGOS_EXTENSION_NAME,
        tasks: [runTask, stepTask, scriptTask, gateTask],
      }),
    );

    let home: string | undefined;
    let ownsPid = false;
    let storage: Storage;

    if (options.storage !== undefined) {
      storage = options.storage;
      if (options.home !== undefined) {
        home = options.home;
        acquirePidFile(home);
        ownsPid = true;
      }
    } else {
      home = options.home ?? argosHome();
      acquirePidFile(home);
      ownsPid = true;
      try {
        storage = await openNodeSqliteStorage(dbPath(home));
        enforceStorageModes(home);
      } catch (error) {
        if (ownsPid) releasePidFile(home);
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
   * Create the run task and its mirror in one commit, then enable scheduling. Returns
   * immediately: the run progresses inside the harness, never on the caller's stack.
   */
  async startRun(input: StartRunInput): Promise<StartedRun> {
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
      if (existing !== undefined) return existing;
    }
    const runId = input.id ?? ulid(this.#clock.now());
    // FR23/D9: an isolated run works in its own worktree from a freshly fetched base. The worktree
    // is created **before** the run task exists, so a dirty base or a missing ref refuses the run
    // with `worktree_base_dirty` / `worktree_failed` and no agent is ever launched.
    const worktree =
      input.worktree ??
      (await this.#prepareWorktree(input.ir, input.cwd, runId, input.isolation));
    const record = createRunRecord({
      id: runId,
      ir: input.ir,
      inputs: input.inputs,
      cwd: input.cwd,
      now,
      ...(worktree === undefined ? {} : { worktree }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    });

    const root = await this.#harness.root(this.#context);
    const started = await this.#harness.commit(async (tx) => {
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
      await writeRunState(tx, id, record, { type: "run_started", detail: input.ir.id });
      await registerRun(tx, runId);
      if (clientRequestId !== undefined) {
        const doc = await tx.doc(IdempotencyDocFamily, clientRequestId, EMPTY_IDEMPOTENCY_DOC);
        doc.runId = runId;
        doc.taskId = String(id);
        doc.createdAt = now;
      }
      return { runId, taskId: String(id) };
    }, this.#context);

    this.#harness.resume();
    return started;
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
    if (this.#home === undefined) {
      throw new ArgosError(
        "worktree_failed",
        `playbook ${ir.id}: isolation.mode "worktree" needs an ARGOS_HOME for <home>/worktrees/<runId>; open the host with one`,
      );
    }
    return createRunWorktree({
      repo: cwd,
      home: this.#home,
      runId,
      ...(isolation.base === undefined ? {} : { base: isolation.base }),
      ...(this.#git === undefined ? {} : { git: this.#git }),
    });
  }

  /** Close the harness (and with it SQLite), then release the pid file. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#harness.close(this.#context);
    } finally {
      if (this.#home !== undefined && this.#ownsPid) releasePidFile(this.#home);
    }
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

    const now = this.#clock.now();
    const draft = cloneRecord(record);
    for (const id of downstreamClosure(record.ir, [stepId])) {
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
      await registerRun(tx, runId);
      return id;
    }, this.#context);

    this.#harness.resume();
    return { runId, taskId: String(taskId) };
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

/** FR4: the database file is private to the user. */
function enforceStorageModes(home: string): void {
  const file = dbPath(home);
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
