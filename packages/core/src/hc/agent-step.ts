/**
 * The herdr-core (`hc`) `StepExecutor` (FR18–FR26).
 *
 * `argos.step` consumes this through the Phase 1 `StepExecutor` port (`durable/context.ts`), so the
 * durable layer never imports an hc client and every test uses the in-memory fake from
 * `test/fakes/hc.ts`. hc is a **terminal host**, not an agent API: a step is one terminal running a
 * template, and everything the adapter does is derive Argos' vocabulary from what hc reports.
 *
 * Behaviour, in the order a step experiences it:
 *
 * 1. **launch** (FR19) — resolve the step's `hc/<template>` target, adopt a terminal an earlier
 *    lifetime created for this `requestId` (`terminal.list { all: true, labels }`), otherwise
 *    create one with a deterministic name (`argos-<16 hex of requestId>`). A `name_taken` reply is
 *    an adoption too, never a second terminal. `rm` is never passed (FR26): the crash window needs
 *    the record to adopt, and settle removes the terminal itself.
 * 2. **prompt delivery** (FR20) — `terminal.run` reports whether the template's first message went
 *    in. While hc says "not sent, `turn === 0`", the prompt is typed in with `terminal.send { if:
 *    "idle" }`; afterwards hc's own record says it went in, so this is exactly-once with no
 *    checkpoint state, and a restart re-derives the fact from the core.
 * 3. **status** (FR21/FR22/FR23) — one `terminal.get` per poll on the task's existing `pollMs`
 *    cadence. `blocked` is `running` with a `blocked: <msg>` detail (a human can answer in the
 *    terminal; the deadline still governs); every other live word (`working`, `idle`, `error`,
 *    nothing reported) keeps polling. The **terminal poll** decides the attempt: a finished terminal
 *    or a `done` status word settles, reading the screen exactly once when the step declares
 *    `outputs` and parsing it with the shared fenced-JSON parser, so a schema-invalid result comes
 *    back as `invalid_output` and `argos.step`'s existing retry/backoff runs. A lost terminal gets
 *    exactly one handover relaunch (FR24).
 * 4. **collect** (FR23/FR26) — cleanup plus diagnostics: the exit code and signal for the receipt,
 *    the default outcome for a step that declares none, and one removal. It never re-reads or
 *    re-parses: the polled status already carries a settled result, and keeping the text out of the
 *    adapter's return values is what keeps it out of the checkpoint (NFR Privacy).
 * 5. **settle cleanup** (FR26) — remove the terminal once, killing it first when hc still reports it
 *    live (`terminal.rm` refuses a live terminal with `kind: "live"`). Best effort: cleanup never
 *    fails a step.
 *
 * Privacy: no prompt, terminal text, or transcript is ever put in a `detail`, an `ArgosError`
 * message, or a checkpoint. Only the target, the exit code, and hc's own status message travel.
 * No LLM decides anything here: outcomes are validated against the step's declared enum and the
 * pure engine routes them.
 */

import type {
  AgentLaunch,
  AgentStatusInput,
  CollectInput,
  CollectResult,
  LaunchInput,
  StepAgentContext,
  StepAgentStatus,
  StepExecutor,
} from "../durable/context.js";
import { ArgosError, isArgosError } from "../errors.js";
import {
  buildStepOutputSchema,
  parseStepResult,
  type StepOutputSchema,
} from "../executor/output.js";
import { HC_PROVIDER, hcTargetOf } from "./catalog.js";
import {
  hcFailureCode,
  isHcKindError,
  type HcErrorKind,
  type HcPort,
  type HcRunInput,
  type HcRunResult,
  type HcTerminal,
} from "./port.js";

/** Longest detail one status/collect may carry (a checkpoint note, never terminal text). */
const DETAIL_TEXT_LIMIT = 500;

/** The bounded detail of a finished terminal whose screen could not be read (FR23). */
const COULD_NOT_READ_DETAIL = "could not read the terminal result";

/**
 * hc's ending reasons that mean the work did not finish on its own: the program was killed, lost
 * its holder, or the core was restarted under it (FR23). A zero exit code always wins over these.
 */
const FAILED_END_REASONS: ReadonlySet<string> = new Set<string>([
  "killed",
  "signaled",
  "holder_lost",
  "stopped_by_restart",
]);

/** A missing terminal (or its machine) is the handover path, not a failure (FR24). */
const LOST_TERMINAL_KINDS: ReadonlySet<HcErrorKind> = new Set<HcErrorKind>([
  "not_found",
  "machine_unknown",
]);

/**
 * `terminal.send` replies that mean "not now", never "this attempt failed": the program is still
 * booting, already working on a turn, waiting for a human, or just exited. The next poll decides,
 * and the step deadline still bounds the wait (FR20/FR22).
 */
const SEND_DEFERRED_KINDS: ReadonlySet<HcErrorKind> = new Set<HcErrorKind>([
  "status_mismatch",
  "blocked",
  "finished",
]);

const DEFAULT_HANDOVER_NOTE =
  "Your previous terminal was lost. A new terminal has been started for you in the same working " +
  "directory. Continue the same task from the current workspace state; do not restart work that is " +
  "already done.";

/** The catalog subset the adapter needs. `HcCatalog` implements it. */
export interface HcTargetCatalog {
  has(target: string): boolean;
}

/**
 * The Herdr app's adoption labels (`herdr.space`, `herdr.tab`).
 *
 * hc never interprets a label, and no other client looks at these: they are the app's convention for
 * "this terminal belongs in a space", so a terminal Argos starts shows up as a pane there instead of
 * living only in `hc ls`. A space or tab id the app does not know becomes a new, unnamed space (named
 * after the terminal's folder) or a new tab, so Argos needs no knowledge of the app's model.
 */
export interface HcHerdrLabels {
  /** The space to join; the id is local to the core (machine) the terminal runs on. */
  readonly space: string;
  /** The tab to join; defaults to the run id, so one run's steps share a tab. */
  readonly tab?: string;
}

export interface HcStepExecutorOptions {
  readonly port: HcPort;
  /** Optional catalog: a template absent from `templates.list` is never launched. */
  readonly catalog?: HcTargetCatalog;
  /** `$ARGOS_HOME`, published as the `argos/home` label (FR19). Omitted when unknown. */
  readonly home?: string;
  /** Extra instruction appended to the prompt of a handover relaunch (FR24). */
  readonly handoverNote?: string;
  /** The Herdr app's adoption labels. Omitted: the terminal stays out of the app (any other client). */
  readonly herdr?: HcHerdrLabels;
}

// ------------------------------------------------------------------ pure helpers

/** Bound one note so a checkpoint field cannot grow with a program's output. */
function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= DETAIL_TEXT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, DETAIL_TEXT_LIMIT - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stable Argos code for a port-level throw (hc's kind/hint never reach the message, FR25). */
function toArgosError(error: unknown, target: string | undefined): ArgosError {
  if (isArgosError(error)) return error;
  const code = hcFailureCode(error, "step_failed");
  const scope = target === undefined ? "hc terminal" : `hc target ${target}`;
  return new ArgosError(
    code,
    `${scope}: ${errorMessage(error)}`,
    error instanceof Error ? { cause: error } : {},
  );
}

/**
 * Two FNV-1a 32-bit passes with different offset bases: 64 bits over the UTF-16 code units of a
 * `requestId`, rendered as 16 lowercase hex characters.
 *
 * Written here rather than imported from `node:crypto` on purpose: the adapter imports no `node:`
 * module (only `client.ts` owns the socket), and a name must be reproducible from the request id
 * alone — that is what lets a re-entered `launch` adopt instead of create (FR19).
 */
function fnv1a32(text: string, basis: number): string {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x0100_0193) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * FR19: the deterministic terminal name, `argos-<first 16 hex of the request id's digest>`. hc
 * names are 1–32 characters of `[a-z0-9-_]`, so `argos-` plus 16 hex fits. A handover relaunch gets
 * its own name (`…:handover`) so it never collides with the terminal it replaces (FR24).
 */
export function hcTerminalName(requestId: string, handover = false): string {
  const seed = handover ? `${requestId}:handover` : requestId;
  return `argos-${fnv1a32(seed, 0x811c_9dc5)}${fnv1a32(seed, 0x7f4a_7c15)}`;
}

/**
 * Strip ANSI/OSC escape sequences from terminal text before parsing (FR23): a screen carries
 * colours, cursor moves, and — on hc — the program's own OSC 7501 status reports, none of which
 * belong in the JSON block.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()#][0-9A-Za-z]/g, "");
}

/** FR21: hc's own word for "the program is done", or a terminal that already finished. */
function isDone(terminal: HcTerminal): boolean {
  return terminal.state === "finished" || terminal.status?.state === "done";
}

/** How the program ended, as a bounded detail (`exit code 3`, `signal 15`, `terminal killed`). */
function endingDetail(terminal: HcTerminal): string | undefined {
  if (terminal.signal !== null) return `signal ${terminal.signal}`;
  if (terminal.exit_code !== null) return `exit code ${terminal.exit_code}`;
  if (terminal.reason !== null) return `terminal ${terminal.reason}`;
  return undefined;
}

/** FR23: a non-zero exit, a signal, or a killed/lost program is a step failure. */
function endedBadly(terminal: HcTerminal): boolean {
  if (terminal.signal !== null) return true;
  if (terminal.exit_code !== null) return terminal.exit_code !== 0;
  return terminal.reason !== null && FAILED_END_REASONS.has(terminal.reason);
}

/** The address hc accepts everywhere, falling back to the name for a terminal without one. */
function terminalKey(terminal: HcTerminal): string {
  return terminal.name !== null && terminal.name.length > 0 ? terminal.name : terminal.address;
}

// ------------------------------------------------------------------ executor

export function createHcStepExecutor(options: HcStepExecutorOptions): StepExecutor {
  const { port, catalog } = options;
  const home = options.home;
  const herdr = options.herdr;
  const handoverNote = options.handoverNote ?? DEFAULT_HANDOVER_NOTE;

  // ---------------------------------------------------------------- prompts

  /**
   * FR23: hc has no `outputSchema` channel, so a step that declares `outputs` gets the one
   * instruction the fenced-JSON fallback needs — and nothing else. Without it every
   * schema-declaring playbook would fail `invalid_output` by construction. A step that declares
   * `outcomes` without `outputs` gets no instruction: `parseStepResult` refuses plain text in that
   * case (the same rule Paseo applies to a text-only provider), so it settles on the exit code.
   */
  function outputInstruction(compiled: StepOutputSchema): string | undefined {
    if (!compiled.hasOutputs) return undefined;
    const keys = compiled.outputs.map((output) => `"${output.name}"`);
    if (compiled.outcomes.length > 0) keys.push('"outcome"');
    const outcomeRule =
      compiled.outcomes.length > 0
        ? ` The "outcome" value must be one of ${compiled.outcomes.map((name) => `"${name}"`).join(", ")}.`
        : "";
    return (
      "When you are finished, end your reply with exactly one fenced ```json block containing a " +
      `JSON object with the keys ${keys.join(", ")} and no others.${outcomeRule} ` +
      "Do not add a second fenced block."
    );
  }

  /** The only template variable the adapter owns, then the handover note, then the JSON rule. */
  function promptFor(input: StepAgentContext, handover: boolean): string {
    const parts: string[] = [];
    const base =
      input.feedback === undefined
        ? (input.prompt ?? "")
        : (input.prompt ?? "").replace(/\{\{\s*feedback\s*\}\}/g, input.feedback);
    if (base.trim().length > 0) parts.push(base);
    if (handover) parts.push(handoverNote);
    const instruction = outputInstruction(
      buildStepOutputSchema({ outputs: input.outputDefs, outcomes: input.outcomes }),
    );
    if (instruction !== undefined) parts.push(instruction);
    return parts.join("\n\n");
  }

  // ---------------------------------------------------------------- launch (FR19)

  /** Canonical template candidates of the step, in preference order (aliases normalized). */
  function templatesOf(input: StepAgentContext): string[] {
    const ordered = [
      ...(input.target === undefined ? [] : [input.target]),
      ...(input.targets ?? []),
    ];
    const templates: string[] = [];
    for (const target of ordered) {
      const canonical = hcTargetOf(target);
      if (canonical === undefined) continue;
      const template = canonical.slice(HC_PROVIDER.length + 1);
      if (!templates.includes(template)) templates.push(template);
    }
    return templates;
  }

  /** FR18: the first candidate the core's `templates.list` actually offers. */
  function resolveTemplate(input: StepAgentContext): string {
    const candidates = templatesOf(input);
    const chosen = candidates.find(
      (template) => catalog === undefined || catalog.has(`${HC_PROVIDER}/${template}`),
    );
    if (chosen !== undefined) return chosen;
    throw new ArgosError(
      "model_unavailable",
      candidates.length === 0
        ? `step ${input.stepId}: hc needs an agent target of the form { provider: hc, model: <template> }`
        : `step ${input.stepId}: none of ${candidates
            .map((template) => `${HC_PROVIDER}/${template}`)
            .join(", ")} is present in templates.list`,
    );
  }

  /**
   * FR19: the labels every terminal carries (plus `argos/handover` on a relaunch).
   *
   * `herdr.space`/`herdr.tab` ride along on a create so the Herdr app adopts the terminal the moment
   * the core announces it — the app is not running in every install, and without it the two labels
   * are just data hc keeps.
   */
  function labelsFor(input: StepAgentContext, handover: boolean): Record<string, string> {
    const labels: Record<string, string> = {
      "argos/launch": input.requestId,
      "argos/run": input.runId,
      "argos/step": input.stepId,
      "argos/attempt": String(input.attempt),
    };
    if (home !== undefined && home.length > 0) labels["argos/home"] = home;
    if (herdr !== undefined && herdr.space.length > 0) {
      labels["herdr.space"] = herdr.space;
      labels["herdr.tab"] =
        herdr.tab !== undefined && herdr.tab.length > 0 ? herdr.tab : input.runId;
    }
    if (handover) labels["argos/handover"] = "1";
    return labels;
  }

  function launchOf(terminal: HcTerminal, fallbackTemplate: string): AgentLaunch {
    const template = terminal.template ?? fallbackTemplate;
    return { agentId: terminalKey(terminal), target: `${HC_PROVIDER}/${template}` };
  }

  /**
   * FR19: adopt before creating. The label filter finds a terminal an earlier lifetime created for
   * this `requestId`, so a re-entered `launch` can never make a second one. `all: true` matters: the
   * terminal may have finished while Argos was down, and adopting it lets `collect` report the real
   * result instead of leaking a duplicate.
   */
  async function adoptByLabel(
    input: StepAgentContext,
    template: string,
  ): Promise<AgentLaunch | undefined> {
    let terminals: HcTerminal[];
    try {
      terminals = await port.listTerminals({
        all: true,
        labels: { "argos/launch": input.requestId },
      });
    } catch (error) {
      throw toArgosError(error, input.target);
    }
    const found = terminals.find((terminal) => terminal.state === "live") ?? terminals[0];
    return found === undefined ? undefined : launchOf(found, template);
  }

  /**
   * FR19/FR24: a taken name is an adoption, never a second terminal. The name is derived from the
   * request id, so a terminal carrying it is *this attempt's* terminal (created by a lifetime that
   * crashed before the `agentId` commit). If it cannot be read back the launch is
   * `launch_uncertain` — never a blind relaunch.
   */
  async function adoptByName(
    input: StepAgentContext,
    name: string,
    template: string,
  ): Promise<AgentLaunch> {
    try {
      const terminal = await port.getTerminal(name);
      return launchOf(terminal, template);
    } catch (error) {
      throw new ArgosError(
        "launch_uncertain",
        `step ${input.stepId} attempt ${input.attempt}: hc reported the terminal name ` +
          `${name} is taken but it could not be adopted (${errorMessage(error)}); reconcile the ` +
          "terminal manually instead of risking a duplicate",
        error instanceof Error ? { cause: error } : {},
      );
    }
  }

  /**
   * FR20: deliver the prompt exactly once, with no checkpoint state.
   *
   * hc records whether a template's first message went in (`first_message.sent`) and whether
   * anything was ever submitted (`turn === 0`). While it reports "not sent, nothing submitted", the
   * prompt is typed in with `if: "idle"`; after a delivery hc says it went in, so a later poll (or a
   * restarted process re-reading the terminal) does nothing. `turn > 0` means a turn already ran, so
   * the prompt is never typed over it.
   */
  async function deliverPrompt(
    input: StepAgentContext,
    terminal: HcTerminal,
    prompt: string,
  ): Promise<void> {
    if (prompt.length === 0) return;
    const first = terminal.first_message;
    if (first === null || first.sent) return;
    if (terminal.turn !== 0) return;
    try {
      await port.sendText({ terminal: terminal.address, text: prompt, if: "idle" });
    } catch (error) {
      if (isHcKindError(error) && SEND_DEFERRED_KINDS.has(error.kind)) return;
      throw toArgosError(error, input.target);
    }
  }

  /** Create the attempt's terminal (`argv` = template plus task) and deliver its prompt. */
  async function runTerminal(
    input: StepAgentContext,
    template: string,
    handover: boolean,
  ): Promise<AgentLaunch> {
    const prompt = promptFor(input, handover);
    const name = hcTerminalName(input.requestId, handover);
    const request: HcRunInput = {
      argv: prompt.length === 0 ? [template] : [template, prompt],
      cwd: input.cwd,
      name,
      labels: labelsFor(input, handover),
      // Deliberately no `rm` (FR26): the crash window needs the label/name to adopt, and collect
      // removes the terminal itself once the attempt is over.
    };
    let run: HcRunResult;
    try {
      run = await port.runTerminal(request);
    } catch (error) {
      if (isHcKindError(error) && error.kind === "name_taken") {
        return adoptByName(input, name, template);
      }
      throw toArgosError(error, input.target);
    }
    await deliverPrompt(input, run, prompt);
    return launchOf(run, template);
  }

  async function createTerminal(
    input: StepAgentContext,
    handover: boolean,
  ): Promise<AgentLaunch> {
    const template = resolveTemplate(input);
    const adopted = await adoptByLabel(input, template);
    if (adopted !== undefined) return adopted;
    return runTerminal(input, template, handover);
  }

  async function launch(input: LaunchInput): Promise<AgentLaunch> {
    // `priorCreateAttempt` is not needed here: hc always filters labels, so the Paseo
    // `launch_uncertain` crash window cannot arise — adoption is label-, then name-based.
    return createTerminal(input, false);
  }

  // ---------------------------------------------------------------- status (FR21/FR22)

  /**
   * FR24: a terminal that is gone gets exactly one relaunch (new name, `argos/handover=1`, the
   * handover note); a second loss fails the step with `agent_missing`. hc's own recovery never
   * re-runs the task, so this is the only path that recreates work.
   */
  async function handover(input: AgentStatusInput): Promise<StepAgentStatus> {
    if (input.handoverAttempted === true) {
      return {
        state: "done",
        errorCode: "agent_missing",
        feedback: `hc terminal ${input.agentId} is unknown after one handover relaunch`,
      };
    }
    const created = await createTerminal(input, true);
    return {
      state: "running",
      agentId: created.agentId,
      handover: true,
      ...(created.target === undefined ? {} : { target: created.target }),
      detail: bounded(`hc terminal ${input.agentId} was lost; relaunched once`),
    };
  }

  /**
   * FR23: decide the attempt's result on the **terminal poll**.
   *
   * This is the only place the decision can live. `argos.step` retries a *status*-reported
   * `invalid_output` with deterministic backoff, and a `collect` result is terminal by
   * construction, so a parser that only ran in `collect` could never satisfy "invalid JSON retries
   * and then fails" (Phase 6 verification 5). The retry needs no state: it re-dispatches with a new
   * `requestId`, therefore a new deterministic terminal name, so the text never has to be stored.
   *
   * NFR deviation, deliberate: a poll is one `terminal.get`, and the terminal poll of a step that
   * declares `outputs` adds **exactly one** `terminal.read` (none while running, none for a step
   * with no outputs) — the alternative is an adapter with no retry and no output parsing at all.
   *
   * A program failure is never a schema failure: a bad ending short-circuits before the read, so
   * `step_failed` keeps the exit code and never consumes a retry.
   */
  async function terminalResult(
    input: AgentStatusInput,
    terminal: HcTerminal,
  ): Promise<StepAgentStatus> {
    const compiled = buildStepOutputSchema({
      outputs: input.outputDefs,
      outcomes: input.outcomes,
    });
    // Nothing declared: `collect` settles the process outcome (and its default outcome) as before.
    if (!compiled.hasOutputs) return { state: "done" };

    if (endedBadly(terminal)) {
      return {
        state: "done",
        errorCode: "step_failed",
        detail: endingDetail(terminal) ?? "the terminal ended without an exit code",
      };
    }

    let text: string;
    try {
      text = stripAnsi((await port.readTerminal(terminal.address)).text);
    } catch {
      // The terminal is finished, so parking would only run the step into its deadline: fail the
      // attempt instead, with a bounded detail and no terminal text.
      return { state: "done", errorCode: "step_failed", detail: COULD_NOT_READ_DETAIL };
    }

    const validation = parseStepResult(compiled, { text });
    if (!validation.ok) {
      // The schema reason is a bounded parser message (keys and types, never the text itself), and
      // `feedback` is what `argos.step` shows for the retry.
      return { state: "done", errorCode: "invalid_output", feedback: bounded(validation.error) };
    }
    return {
      state: "done",
      outputs: validation.outputs,
      ...(validation.outcome === undefined ? {} : { outcome: validation.outcome }),
    };
  }

  async function status(input: AgentStatusInput): Promise<StepAgentStatus> {
    let terminal: HcTerminal;
    try {
      terminal = await port.getTerminal(input.agentId);
    } catch (error) {
      if (isHcKindError(error) && LOST_TERMINAL_KINDS.has(error.kind)) return handover(input);
      // A transport failure reaches `argos.step` as `executor_unreachable`, which parks the step
      // until the deadline instead of failing it (FR7).
      throw toArgosError(error, input.target);
    }
    if (isDone(terminal)) return terminalResult(input, terminal);
    await deliverPrompt(input, terminal, promptFor(input, input.handoverAttempted === true));
    return runningStatus(terminal);
  }

  // ---------------------------------------------------------------- collect (FR23/FR26)

  /**
   * The attempt's terminal, for the exit code and for the kill-before-remove decision. A terminal
   * that is already gone settles from the polled status: `status` would have handed over, so a loss
   * here is a race, not a failure.
   */
  async function settleTerminal(agentId: string): Promise<HcTerminal | undefined> {
    try {
      return await port.getTerminal(agentId);
    } catch {
      return undefined;
    }
  }

  /**
   * FR26: one removal per settled attempt, so a finished run does not accumulate terminals. hc
   * refuses `terminal.rm` on a live terminal (`kind: "live"`), so a program that reported `done`
   * but is still alive — or one whose step hit its deadline — is killed first. Best effort
   * throughout: a lost, already-removed, or unkillable terminal never fails a step, and `rm` is
   * never passed at launch because the crash window needs the record to adopt.
   */
  async function removeSettled(terminal: HcTerminal | undefined): Promise<void> {
    if (terminal === undefined) return;
    if (terminal.state === "live") {
      try {
        await port.killTerminal(terminal.address);
      } catch {
        // The program may have exited in the meantime, or this core cannot kill: try the removal
        // anyway and never fail the step over cleanup.
      }
    }
    try {
      await port.removeTerminal(terminal.address);
    } catch {
      // Already gone, or still live on a core without a usable kill: cleanup is best effort.
    }
  }

  /**
   * FR23: the outcome of a successful step whose result carries none (no declared outputs, so
   * nothing was parsed): `success` when the step declares it, else its first declared outcome.
   */
  function defaultOutcome(input: CollectInput): string | undefined {
    if (input.outcomes.includes("success")) return "success";
    return input.outcomes[0];
  }

  /**
   * Cleanup plus diagnostics, and nothing else. The result was decided by the terminal poll, so a
   * step that declares outputs already carries them in `checkpoint.status` (which `buildResult`
   * reads) — re-reading the screen here would add a round-trip and a second parser for no gain. What
   * is left is FR26's removal and the ending (`exit code 0`, `signal 15`, …) as the receipt's
   * detail.
   */
  async function collect(input: CollectInput): Promise<CollectResult> {
    const status = input.status;
    if (status.state !== "done") return {};
    const terminal = await settleTerminal(input.agentId);
    await removeSettled(terminal);
    const ending = terminal === undefined ? undefined : endingDetail(terminal);
    const withEnding = (result: CollectResult): CollectResult =>
      ending === undefined ? result : { ...result, detail: ending };

    // The task already decided this attempt failed (`step_timeout`, an exhausted handover, an
    // `invalid_output` the poll reported): keep its code and add how the program ended.
    if (status.errorCode !== undefined) return withEnding({});

    const compiled = buildStepOutputSchema({
      outputs: input.outputDefs,
      outcomes: input.outcomes,
    });
    if (compiled.hasOutputs) return withEnding({});

    // No declared outputs: the process outcome and the default outcome live here (FR23).
    if (terminal !== undefined && endedBadly(terminal)) {
      return {
        errorCode: "step_failed",
        detail: ending ?? "the terminal ended without an exit code",
      };
    }
    const outcome = defaultOutcome(input);
    return withEnding(outcome === undefined ? {} : { outcome });
  }

  return { launch, status, collect };
}

/** FR21/FR22: the polled word, mapped the one way Argos understands it. */
function runningStatus(terminal: HcTerminal): StepAgentStatus {
  const program = terminal.status;
  if (program !== null && program.state === "blocked") {
    const message = program.msg?.trim() ?? "";
    return {
      state: "running",
      detail: bounded(message.length === 0 ? "blocked" : `blocked: ${message}`),
    };
  }
  // `working`, `idle`, `error`, a word this Argos has never seen, or a program that never reported:
  // the step keeps polling and its deadline decides (FR21).
  return { state: "running" };
}
