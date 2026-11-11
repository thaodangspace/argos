/**
 * `ArgosHost` — the one process-wide owner of `$ARGOS_HOME/argos.sqlite` (FR2, FR4, FR13, FR29).
 *
 * Responsibilities:
 * - open (or create) the home directory and the SQLite storage, with `0700`/`0600` modes;
 * - enforce the single-writer rule through `$ARGOS_HOME/serve.pid`, refusing a second live owner
 *   with `storage_locked` and replacing a stale pid file left by a dead process;
 * - install one `argos` extension containing the `argos.run` / `argos.step` tasks in a fresh
 *   registry, with a **stub** `models` (D6) that throws on any use, because the engine never
 *   consults a model for control flow;
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
import type { PlaybookIR, Scalar } from "../playbook/ir.js";
import { argosHome, dbPath, ensureHome, pidPath } from "../paths.js";
import {
  createRunRecord,
  decideGate,
  isTerminalRunStatus,
  type GateRecord,
  type RunRecord,
  type WorktreeRecord,
} from "../engine/index.js";
import type { Clock, StepExecutor } from "./context.js";
import { systemClock } from "./context.js";
import {
  GateDocFamily,
  HistoryDocFamily,
  RunDocFamily,
  appendRunHistory,
  gateKey,
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
}

export interface StartRunInput {
  readonly ir: PlaybookIR;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly cwd: string;
  readonly worktree?: WorktreeRecord;
  readonly deadline?: number;
  /** Explicit run id (tests / idempotent callers); default `ulid()`. */
  readonly id?: string;
}

export interface StartedRun {
  readonly runId: string;
  readonly taskId: string;
}

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
  readonly #runTask: ReturnType<typeof createRunTaskDefinition>;
  readonly #stepTask: ReturnType<typeof createStepTaskDefinition>;
  readonly #gateTask: ReturnType<typeof createGateTaskDefinition>;
  readonly #home: string | undefined;
  readonly #ownsPid: boolean;
  #closed = false;

  private constructor(init: {
    harness: Harness;
    context: Context;
    executor: StepExecutor;
    clock: Clock;
    models: Models;
    runTask: ReturnType<typeof createRunTaskDefinition>;
    stepTask: ReturnType<typeof createStepTaskDefinition>;
    gateTask: ReturnType<typeof createGateTaskDefinition>;
    home: string | undefined;
    ownsPid: boolean;
  }) {
    this.#harness = init.harness;
    this.#context = init.context;
    this.#executor = init.executor;
    this.#clock = init.clock;
    this.#models = init.models;
    this.#runTask = init.runTask;
    this.#stepTask = init.stepTask;
    this.#gateTask = init.gateTask;
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

    const stepTask = createStepTaskDefinition({ executor: options.executor });
    const gateTask = createGateTaskDefinition();
    const runTask = createRunTaskDefinition({ stepTask, gateTask });
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: ARGOS_EXTENSION_NAME, tasks: [runTask, stepTask, gateTask] }),
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
      runTask,
      stepTask,
      gateTask,
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
    const runId = input.id ?? ulid(this.#clock.now());
    const record = createRunRecord({
      id: runId,
      ir: input.ir,
      inputs: input.inputs,
      cwd: input.cwd,
      now: this.#clock.now(),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    });

    const root = await this.#harness.root(this.#context);
    const taskId = await this.#harness.commit(async (tx) => {
      // D4/D5: the run task is conversation-owned by the host's root conversation.
      const id = await tx.createTask(
        this.#runTask,
        { runId, record },
        { ownership: { kind: "conversation" }, conversationId: root.id },
      );
      await writeRunState(tx, id, record, { type: "run_started", detail: input.ir.id });
      return id;
    }, this.#context);

    this.#harness.resume();
    return { runId, taskId: String(taskId) };
  }

  /** Continue every unfinished task (FR29). Idempotent. */
  resume(): void {
    this.#harness.resume();
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
      });
      if (!written.written) {
        throw new ArgosError(
          "gate_already_decided",
          `gate ${gateId} was already decided "${written.decision ?? "unknown"}" at ${written.decidedAt ?? 0}`,
        );
      }
    }, this.#context);

    this.#harness.resume();
    return receipt;
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
