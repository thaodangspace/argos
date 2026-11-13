import { canonicalJson } from "./hash.js";
import type { InputDefIR, PlaybookIR, StepIR } from "./ir.js";

/**
 * Fork applicability (S-FR4): what changed between the definition a run froze and the definition
 * on disk now.
 *
 * The durable guard needs three answers: is the step graph the same shape, did a playbook surface
 * a fork cannot survive change, and which steps differ — because a fork may only apply a change
 * inside the set it is about to re-run (`downstreamClosure`). Comparing with `canonicalJson`, the
 * rule the loader already hashes with, means a reformatted or re-serialized YAML file is "no
 * change": running a formatter over a playbook must not refuse a fork.
 *
 * Not compared here, deliberately: `title`, `description`, `defaults`, `providers`, `roles`,
 * `blocks`, `outcomes`, `concurrency`, and `hash`. Each either resolves into a `StepIR` (so the
 * step diff reports it where it matters) or cannot affect a run that starts at the fork point.
 * `labels` is **not** on that list: playbook labels are merged into every `StepIR.labels`, so a
 * label edit is a real dispatch change and is reported as a step diff.
 *
 * This module is pure — types and a serializer, no I/O, no clock — so it stays usable from the
 * loader, the CLI, and the durable host alike.
 */

/** A playbook-level surface the fork guard compares. `inputs` is reported by name instead. */
export type PlaybookSurface = "id" | "version" | "isolation" | "after";

export interface IrDiff {
  /** Step ids were added, removed, or reordered: the graph is a different shape. */
  readonly stepOrder: boolean;
  /** Playbook-level surfaces that changed, in a stable order. Empty = compatible. */
  readonly playbook: readonly PlaybookSurface[];
  /** Input declarations that changed, were added, or were removed (sorted). */
  readonly inputs: readonly string[];
  /**
   * Step ids whose `StepIR` differs, in the frozen definition's order. Empty when `stepOrder` is
   * true — a different shape makes the per-step answer meaningless.
   */
  readonly steps: readonly string[];
}

/**
 * `isolation` is optional in the IR, and `{mode:"none"}` means the same thing as absent. Normalize
 * both to `"none"` so a loader that spells it out and one that omits it do not conflict.
 */
function isolationKey(isolation: PlaybookIR["isolation"]): string {
  if (isolation === undefined || isolation.mode === "none") return "none";
  return canonicalJson(isolation);
}

/**
 * The semantic half of an input declaration. `description` is documentation: clarifying it cannot
 * change what `{{ inputs.x }}` means, so it must not refuse a fork.
 */
function inputKey(def: InputDefIR): string {
  return canonicalJson({
    type: def.type,
    values: def.values,
    required: def.required,
    default: def.default,
  });
}

function diffInputs(
  before: PlaybookIR["inputs"],
  after: PlaybookIR["inputs"],
): readonly string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const name of [...names].sort()) {
    const previous = before[name];
    const next = after[name];
    if (previous === undefined || next === undefined || inputKey(previous) !== inputKey(next)) {
      changed.push(name);
    }
  }
  return changed;
}

/** Both arrays are known to have the same ids in the same order when this runs. */
function diffSteps(before: readonly StepIR[], after: readonly StepIR[]): readonly string[] {
  const changed: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index] as StepIR;
    const next = after[index] as StepIR;
    if (canonicalJson(previous) !== canonicalJson(next)) changed.push(previous.id);
  }
  return changed;
}

/**
 * Diff two resolved IRs. The caller decides what a difference means; this function only reports it.
 */
export function diffPlaybookIr(before: PlaybookIR, after: PlaybookIR): IrDiff {
  const playbook: PlaybookSurface[] = [];
  if (before.id !== after.id) playbook.push("id");
  if (before.version !== after.version) playbook.push("version");
  if (isolationKey(before.isolation) !== isolationKey(after.isolation)) playbook.push("isolation");
  if (canonicalJson(before.after) !== canonicalJson(after.after)) playbook.push("after");

  const beforeIds = before.steps.map((step) => step.id);
  const afterIds = after.steps.map((step) => step.id);
  const stepOrder =
    beforeIds.length !== afterIds.length ||
    beforeIds.some((id, index) => id !== afterIds[index]);

  return {
    stepOrder,
    playbook,
    inputs: diffInputs(before.inputs, after.inputs),
    steps: stepOrder ? [] : diffSteps(before.steps, after.steps),
  };
}
