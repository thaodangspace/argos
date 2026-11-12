/**
 * `argos.script` v1 — one child task per script step (FR22, D10).
 *
 * A script step is a normal step whose work is an executable from the repository instead of an
 * agent: the engine sees the same events (`stepSettled` with an outcome, outputs, or an error
 * code), and the run task waits on it exactly like an `argos.step` child.
 *
 * Phases: `prepare → run → collect`.
 *
 * - `prepare` resolves the executable (or takes the pinned path from its input) and snapshots the
 *   read-only tree (D8) **before** the first execution, then commits the absolute path and the
 *   absolute `deadlineAt`. Nothing is executed by a phase that has not yet written its intent.
 * - `run` checks the pin (FR3) and executes the script once with the filtered environment (D10),
 *   bounded output tails, and `cwd` = the run worktree when isolation is on. Exit `75`
 *   (`SCRIPT_NOT_YET`) commits `sleeping(until: now + pollMs)` (D3: 5000 ms) and re-runs on wake;
 *   any other non-zero exit is terminal. The phase is re-entered after the sleep, so every design
 *   point is durable.
 * - `collect` compares the read-only snapshot and commits a **terminal completed** task whose
 *   result is a {@link StepTaskResult}. A failing script is still a completed task carrying an
 *   `errorCode` (`step_failed`, `script_timeout`, `script_changed`, `readonly_violation`): task
 *   failure stays reserved for broken task code.
 *
 * Resolution: `<script>` must be a bare file name (no `/`, no `..`, not absolute). It is looked up
 * in `.argos/scripts/` and then in the paseo-compatible `.paseo/plugins/playbooks/scripts/` of the
 * run's repository root, and last in `<ARGOS_HOME>/scripts` when the host was opened with a home.
 * It must be an executable regular file. Resolution uses the repository root so an isolated run can
 * still run a local, uncommitted helper; *execution* uses the worktree, so the script sees the
 * run's private checkout (a global script never runs inside `$ARGOS_HOME`).
 *
 * Pinning (FR3, `script-pin.ts`): the host resolves and hashes every script when the run starts, so
 * `prepare` normally just takes `input.pin.path`. Every `run` entry hashes the file again; a
 * changed, moved, or deleted file settles the step as `script_changed` instead of spawning. Only a
 * record written before pinning (no `input.pin`) resolves at `prepare` (FR3.6).
 *
 * Outputs a script can expose, and only when the IR declares them: `stdout` and `stderr` (bounded
 * tails of the last run), `exitCode` / `exit_code` (number), and `runs` (number of executions, so
 * an exit-75 poll loop is observable). Any other declared name is simply not produced; the step's
 * declared output type is not coerced, so `stdout` stays a string.
 *
 * The child is killed on `runtime.signal` abort (run cancelled, `abortTask`, harness close) and
 * when the step timeout elapses; a phase never returns while a child it started is still alive.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { defineTask } from "@earendil-works/pi-durable";

import { ArgosError, type ArgosErrorCode } from "../../errors.js";
import { filterScriptEnv } from "../../engine/env.js";
import type { ScriptPinRecord } from "../../engine/index.js";
import {
  describeSnapshotChange,
  snapshotChanged,
  takeSnapshot,
  type GitSnapshot,
  type SnapshotComparison,
} from "../../git/snapshot.js";
import { tail, type GitRunner } from "../../git/exec.js";
import type { Scalar } from "../../playbook/ir.js";
import type { StepTaskResult } from "../context.js";
import { checkPin, resolveScriptPath } from "./script-pin.js";

// FR3 pinning lives in its own module; the resolution helper keeps its historical export here.
export { resolveScriptPath } from "./script-pin.js";

// ------------------------------------------------------------------ shape

export type ScriptPhase = "prepare" | "run" | "collect";

/** `SCRIPT_NOT_YET` — the script asks to be polled again (the description's exit code, FR22). */
export const SCRIPT_NOT_YET = 75;

/** How much of each stream a checkpoint keeps: the *tail*, which is where the failure is. */
export const SCRIPT_OUTPUT_LIMIT = 8 * 1024;

export interface ScriptTaskInput {
  readonly runId: string;
  readonly stepId: string;
  /** Engine dispatch attempt (D14: the request id's last segment). */
  readonly attempt: number;
  readonly requestId: string;
  /** Execution directory: the run worktree when isolation is on, otherwise the run cwd. */
  readonly cwd: string;
  /** Repository root the `.argos/scripts` directory is resolved from. */
  readonly scriptRoot: string;
  /** `$ARGOS_HOME`; `<home>/scripts` is the last place a script name is looked in. */
  readonly scriptHome?: string;
  /** Script name from the frozen IR (`script: <name>`). */
  readonly script: string;
  /**
   * FR3: the path and sha256 pinned when the run started. Absent on a record created before
   * pinning (FR3.6), in which case `prepare` resolves as before and no hash is checked.
   */
  readonly pin?: ScriptPinRecord;
  /** Env keys the playbook declares in `env: [...]` (D10 allowlist). */
  readonly env: readonly string[];
  /** D3 script poll default 5000 ms (resolved by the run task from the frozen IR). */
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly outputs: readonly string[];
  readonly outcomes: readonly string[];
  /** True when `role.readonly` asked the engine to enforce a read-only turn (D8). */
  readonly readonly?: boolean;
}

export interface ScriptCheckpointFields {
  /** Current local execution number, mirroring the engine's dispatch attempt. */
  readonly attempt: number;
  /** Executions so far, including exit-75 re-runs. */
  readonly runs: number;
  /** Absolute epoch ms after which the script may not run again (`script_timeout`). */
  readonly deadlineAt: number;
  /** Absolute path of the executable, committed by `prepare`. */
  readonly scriptPath?: string;
  /** Exit code of the last execution; absent when it was killed or never started. */
  readonly exitCode?: number;
  /** Signal that ended the last execution (a timeout kill, an operator abort). */
  readonly signal?: string;
  /** Bounded tail of the last execution's stdout. */
  readonly stdout?: string;
  /** Bounded tail of the last execution's stderr. */
  readonly stderr?: string;
  /** When the last execution ended (`runtime.now()`). */
  readonly lastRunAt?: number;
  /** Why the step is failing; the run record only carries the stable code. */
  readonly detail?: string;
  readonly errorCode?: ArgosErrorCode;
  /** D8: the working-tree snapshot taken before the first execution. */
  readonly snapshotBefore?: GitSnapshot;
  /** D8: what the comparison found, committed before the terminal `readonly_violation`. */
  readonly readonlyViolation?: SnapshotComparison;
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type ScriptCheckpoint =
  | (ScriptCheckpointFields & { readonly phase: "prepare" })
  | (ScriptCheckpointFields & { readonly phase: "run" })
  | (ScriptCheckpointFields & { readonly phase: "collect" });

/** The task instance type the run task creates children from. */
export type ScriptTaskDefinition = ReturnType<typeof createScriptTaskDefinition>;

// ------------------------------------------------------------------ helpers

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > SCRIPT_OUTPUT_LIMIT ? next.slice(next.length - SCRIPT_OUTPUT_LIMIT) : next;
}

/** The outcome a successful script reports: `success` when declared, else the first outcome. */
export function scriptOutcome(outcomes: readonly string[]): string {
  return outcomes.includes("success") ? "success" : (outcomes[0] ?? "success");
}

/** Declared outputs a script can fill (see the module comment for the exact set). */
export function scriptOutputs(
  declared: readonly string[],
  checkpoint: ScriptCheckpointFields,
): Readonly<Record<string, Scalar>> | undefined {
  const outputs: Record<string, Scalar> = {};
  for (const name of declared) {
    if (name === "stdout") outputs["stdout"] = checkpoint.stdout ?? "";
    else if (name === "stderr") outputs["stderr"] = checkpoint.stderr ?? "";
    else if (name === "exitCode" || name === "exit_code") {
      if (checkpoint.exitCode !== undefined) outputs[name] = checkpoint.exitCode;
    } else if (name === "runs") outputs["runs"] = checkpoint.runs;
  }
  return Object.keys(outputs).length === 0 ? undefined : outputs;
}

interface ChildRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** We killed it because the step deadline elapsed. */
  readonly timedOut: boolean;
  /** The executable could not be started at all. */
  readonly spawnError?: string;
}

/** Kill a child and, on POSIX, the process group it leads (a script's own children included). */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      // `detached: true` puts the child in its own group, so `-pid` reaches its descendants.
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the single-process kill below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

const ABORTED_MESSAGE = "argos: script invocation aborted";

function abortError(): Error {
  return new Error(ABORTED_MESSAGE);
}

/**
 * Execute the script once. Resolves with the exit status and bounded tails; rejects only when the
 * invocation is aborted, because an abort must not commit anything.
 */
function runChild(options: {
  readonly file: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly track: (child: ChildProcess | undefined) => void;
}): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(options.file, [], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // Own process group on POSIX so a kill reaches a script's own children.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: messageOf(error),
        timedOut: false,
        spawnError: messageOf(error),
      });
      return;
    }
    options.track(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      options.track(undefined);
    };
    const finish = (result: ChildRun): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      reject(abortError());
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendTail(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendTail(stderr, String(chunk));
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr: appendTail(stderr, messageOf(error)),
        timedOut,
        spawnError: messageOf(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, stdout, stderr, timedOut });
    });

    options.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => {
        timedOut = true;
        killTree(child);
      },
      Math.max(0, options.timeoutMs),
    );
  });
}

// ------------------------------------------------------------------ definition

export interface ScriptTaskOptions {
  /** Injected git port for the D8 snapshots (tests); defaults to the `execFile` runner. */
  readonly git?: GitRunner;
}

export function createScriptTaskDefinition(options: ScriptTaskOptions = {}) {
  /** Children currently running, per task id, so the abort handler can kill a leaked process. */
  const active = new Map<number, ChildProcess>();

  return defineTask<ScriptTaskInput, ScriptCheckpoint, StepTaskResult>({
    name: "argos.script",
    version: 1,

    initial: (input): ScriptCheckpoint => ({
      phase: "prepare",
      attempt: input.attempt,
      runs: 0,
      deadlineAt: 0,
    }),

    phases: {
      prepare: async (task, runtime, context) => {
        const now = runtime.now();
        const base = task.state.checkpoint;
        const deadlineAt = now + task.input.timeoutMs;
        const fail = (detail: string): ScriptCheckpoint => ({
          ...base,
          phase: "collect",
          deadlineAt,
          detail,
          errorCode: "step_failed",
        });

        let scriptPath: string;
        if (task.input.pin !== undefined) {
          // FR3: the path was resolved before the run started; `run` hashes it before every spawn,
          // so a file that vanished or changed here is `script_changed`, not a resolution failure.
          scriptPath = task.input.pin.path;
        } else {
          try {
            scriptPath = resolveScriptPath(
              task.input.scriptRoot,
              task.input.script,
              task.input.scriptHome,
            );
          } catch (error) {
            await runtime.commit(
              () => ({ status: "running", checkpoint: fail(messageOf(error)) }),
              context,
            );
            return;
          }
        }

        // D8: the snapshot has to be taken before the script's first execution, and it has to be
        // committed so a restart does not take a second "before" snapshot of a modified tree.
        let snapshotBefore: GitSnapshot | undefined;
        if (task.input.readonly === true) {
          try {
            snapshotBefore = await takeSnapshot(task.input.cwd, {
              ...(options.git === undefined ? {} : { git: options.git }),
            });
          } catch (error) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: fail(`cannot verify a read-only step in ${task.input.cwd}: ${messageOf(error)}`),
              }),
              context,
            );
            return;
          }
        }

        const checkpoint: ScriptCheckpoint = {
          ...base,
          phase: "run",
          deadlineAt,
          scriptPath,
          ...(snapshotBefore === undefined ? {} : { snapshotBefore }),
        };
        await runtime.commit(() => ({ status: "running", checkpoint }), context);
      },

      run: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const settle = (patch: Partial<ScriptCheckpointFields>): ScriptCheckpoint => ({
          ...checkpoint,
          ...patch,
          phase: "collect",
        });

        if (checkpoint.scriptPath === undefined) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: settle({ errorCode: "step_failed", detail: "the script was never resolved" }),
            }),
            context,
          );
          return;
        }

        // FR22: exit 75 forever is bounded by the step timeout, never by a run count.
        if (now >= checkpoint.deadlineAt) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: settle({
                errorCode: "script_timeout",
                detail: `the script did not succeed within ${task.input.timeoutMs} ms`,
              }),
            }),
            context,
          );
          return;
        }

        let run: ChildRun;
        // FR3: every spawn — first run, an exit-75 re-run, a local retry, or a resumed task — sees
        // the pinned digest. A changed or deleted script is terminal and never retried by the
        // engine; an operator re-pins with `argos retry`.
        if (task.input.pin !== undefined) {
          const check = checkPin(task.input.pin);
          if (!check.ok) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: settle({ errorCode: "script_changed", detail: check.detail }),
              }),
              context,
            );
            return;
          }
        }
        try {
          run = await runChild({
            file: checkpoint.scriptPath,
            cwd: task.input.cwd,
            env: filterScriptEnv(process.env, task.input.env),
            timeoutMs: checkpoint.deadlineAt - now,
            signal: runtime.signal,
            track: (child) => {
              if (child === undefined) active.delete(task.id);
              else active.set(task.id, child);
            },
          });
        } catch (error) {
          if (runtime.signal.aborted) throw error; // the harness is closing: commit nothing
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: settle({ errorCode: "step_failed", detail: messageOf(error) }),
            }),
            context,
          );
          return;
        }

        const endedAt = runtime.now();
        const runs = checkpoint.runs + 1;
        const execution: ScriptCheckpointFields = {
          attempt: checkpoint.attempt,
          runs,
          deadlineAt: checkpoint.deadlineAt,
          ...(checkpoint.scriptPath === undefined ? {} : { scriptPath: checkpoint.scriptPath }),
          ...(checkpoint.snapshotBefore === undefined ? {} : { snapshotBefore: checkpoint.snapshotBefore }),
          lastRunAt: endedAt,
          ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
          ...(run.signal === null ? {} : { signal: run.signal }),
          ...(run.stdout === "" ? {} : { stdout: run.stdout }),
          ...(run.stderr === "" ? {} : { stderr: run.stderr }),
        };

        if (run.timedOut) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: settle({
                ...execution,
                errorCode: "script_timeout",
                detail: `the script was still running when the step timeout elapsed (${task.input.timeoutMs} ms)`,
              }),
            }),
            context,
          );
          return;
        }

        const spawnError = run.spawnError;
        if (spawnError !== undefined) {
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: settle({ ...execution, errorCode: "step_failed", detail: spawnError }),
            }),
            context,
          );
          return;
        }

        if (run.exitCode === SCRIPT_NOT_YET) {
          if (endedAt >= checkpoint.deadlineAt) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: settle({
                  ...execution,
                  errorCode: "script_timeout",
                  detail: `the script kept exiting ${SCRIPT_NOT_YET} until ${task.input.timeoutMs} ms elapsed`,
                }),
              }),
              context,
            );
            return;
          }
          const sleeping: ScriptCheckpoint = { ...execution, phase: "run" };
          await runtime.commit(
            () => ({
              status: "sleeping",
              until: endedAt + Math.max(1, task.input.pollMs),
              checkpoint: sleeping,
            }),
            context,
          );
          return;
        }

        if (run.exitCode === 0) {
          await runtime.commit(
            () => ({ status: "running", checkpoint: settle(execution) }),
            context,
          );
          return;
        }

        const detail =
          run.exitCode === null
            ? `the script was killed by ${run.signal ?? "an unknown signal"}: ${run.stderr}`
            : `the script exited ${run.exitCode}${run.stderr === "" ? "" : `: ${run.stderr}`}`;
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: settle({ ...execution, errorCode: "step_failed", detail }),
          }),
          context,
        );
      },

      collect: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        let errorCode = checkpoint.errorCode;
        let detail = checkpoint.detail;
        let outputs = errorCode === undefined ? scriptOutputs(task.input.outputs, checkpoint) : undefined;

        // D8: a read-only script that changed the tree never completes, even when it exited 0.
        if (errorCode === undefined && task.input.readonly === true) {
          try {
            const after = await takeSnapshot(task.input.cwd, {
              ...(options.git === undefined ? {} : { git: options.git }),
            });
            const comparison =
              checkpoint.snapshotBefore === undefined
                ? { changed: true, headChanged: false, files: [] }
                : snapshotChanged(checkpoint.snapshotBefore, after);
            if (comparison.changed) {
              const reason = `read-only step changed its working tree: ${describeSnapshotChange(comparison)}`;
              errorCode = "readonly_violation";
              detail = reason;
              outputs = undefined;
              // Persist the evidence before the terminal outcome (a terminal commit cannot carry a
              // checkpoint), so a crash between the two keeps the changed paths inspectable.
              const flagged: ScriptCheckpoint = {
                ...checkpoint,
                phase: "collect",
                readonlyViolation: comparison,
                detail: reason,
              };
              await runtime.commit(() => ({ status: "running", checkpoint: flagged }), context);
            }
          } catch (error) {
            const reason = `cannot verify the read-only guard afterwards: ${messageOf(error)}`;
            errorCode = "step_failed";
            detail = reason;
            outputs = undefined;
            const flagged: ScriptCheckpoint = { ...checkpoint, phase: "collect", detail: reason };
            await runtime.commit(() => ({ status: "running", checkpoint: flagged }), context);
          }
        }

        const result: Record<string, unknown> = {
          stepId: task.input.stepId,
          attempt: checkpoint.attempt,
          requestId: task.input.requestId,
          runs: checkpoint.runs,
        };
        if (errorCode !== undefined) result["errorCode"] = errorCode;
        else result["outcome"] = scriptOutcome(task.input.outcomes);
        if (outputs !== undefined) result["outputs"] = outputs;
        if (checkpoint.exitCode !== undefined) result["exitCode"] = checkpoint.exitCode;
        if (checkpoint.signal !== undefined) result["signal"] = checkpoint.signal;
        if (detail !== undefined) result["detail"] = tail(detail, 500);

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: result as unknown as StepTaskResult },
          }),
          context,
        );
      },
    },

    abort: async (task, runtime, context) => {
      // The signal listener in `runChild` already killed it; this is the belt-and-braces path for
      // an abort that arrives between phases.
      const child = active.get(task.id);
      if (child !== undefined) {
        killTree(child);
        active.delete(task.id);
      }
      const checkpoint = task.state.checkpoint;
      const result: StepTaskResult = {
        stepId: task.input.stepId,
        attempt: checkpoint.attempt,
        requestId: task.input.requestId,
        errorCode: "step_failed",
      };
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result } }),
        context,
      );
    },
  });
}
