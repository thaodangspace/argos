import { argosError } from "../errors.js";
import type { BlockIR, InputBindingIR, RoleIR, StepIR, TransitionIR, UnhashedPlaybookIR } from "./ir.js";
import { toPlainJson } from "./ir.js";

export interface ExpandLocation {
  readonly file: string;
  readonly stepId: string;
}

export interface ExpandOptions {
  readonly file: string;
  /** Playbook ids currently being loaded, outermost first (cycle detection). */
  readonly stack: readonly string[];
  /** 0 for the top-level playbook, 1 for a sub-playbook. */
  readonly depth: number;
  /** Load and normalize a sub-playbook; throws `playbook_missing` when absent. */
  readonly loadSub: (playbookId: string, location: ExpandLocation) => UnhashedPlaybookIR;
}

const EMPTY_BLOCKS: Readonly<Record<string, BlockIR>> = {};

function expandError(file: string, stepId: string, detail: string): never {
  throw argosError("playbook_invalid", { file, stepId }, detail);
}

/**
 * FR10: inline a sub-playbook's steps at the block's position with `<stepId>.` id prefixes.
 * Depth 1 only; cycles are `playbook_cycle`; the block stays addressable through
 * `PlaybookIR.blocks` so `needs` and `goto` can point at it.
 */
export function expandPlaybook(book: UnhashedPlaybookIR, options: ExpandOptions): UnhashedPlaybookIR {
  const blocks: Record<string, BlockIR> = {};
  const steps: StepIR[] = [];
  const roles: Record<string, RoleIR> = { ...book.roles };

  for (const step of book.steps) {
    if (step.use === undefined) {
      steps.push(step);
      continue;
    }

    const location: ExpandLocation = { file: options.file, stepId: step.id };
    if (options.stack.includes(step.use.playbookId)) {
      throw argosError(
        "playbook_cycle",
        location,
        `sub-playbook cycle: ${[...options.stack, step.use.playbookId].join(" -> ")}`,
      );
    }
    if (options.depth >= 1) {
      expandError(
        options.file,
        step.id,
        `sub-playbook recursion depth 1 exceeded: "${step.id}" uses "${step.use.playbookId}" inside another sub-playbook`,
      );
    }

    const sub = options.loadSub(step.use.playbookId, location);
    if (sub.steps.some((child) => child.use !== undefined)) {
      expandError(options.file, step.id, `sub-playbook "${sub.id}" uses another sub-playbook; only depth 1 is supported`);
    }

    const prefix = `${step.id}.`;
    const internalIds = new Set(sub.steps.map((child) => child.id));
    const prefixed = sub.steps.map((child) =>
      prefixStep(child, prefix, internalIds, step.id, sub.id, step.inputs),
    );

    const entry = sub.steps
      .filter((child) => child.needs.length === 0)
      .map((child) => `${prefix}${child.id}`);
    const terminals = sub.steps
      .filter((child) => !sub.steps.some((other) => other.needs.includes(child.id)))
      .map((child) => `${prefix}${child.id}`);

    if (entry.length === 0) {
      expandError(options.file, step.id, `sub-playbook "${sub.id}" has no entry step`);
    }

    // Entry steps also wait for whatever the block step waited for.
    const inheritedNeeds = step.needs;
    const inlined = prefixed.map((child) =>
      entry.includes(child.id) && inheritedNeeds.length > 0
        ? { ...child, needs: [...child.needs, ...inheritedNeeds] }
        : child,
    );

    steps.push(...inlined);

    const blockOutputs = Object.keys(step.outputs).length > 0 ? step.outputs : sub.outputs;
    blocks[step.id] = toPlainJson({
      id: step.id,
      playbookId: sub.id,
      title: step.title,
      stepIds: inlined.map((child) => child.id),
      entry,
      terminals,
      inputs: step.inputs,
      outputs: blockOutputs,
      outcomes: sub.outcomes.length > 0 ? sub.outcomes : step.outcomes,
      on: step.on,
      ...(step.when !== undefined ? { when: step.when } : {}),
    });

    for (const [id, role] of Object.entries(sub.roles)) roles[id] = role;
  }

  // `needs: [block]` means "the whole sub-graph finished": resolve it to the block's terminals.
  const rewritten = steps.map((step) => {
    const needs = step.needs.flatMap((need) => {
      const block = blocks[need];
      return block === undefined ? [need] : block.terminals;
    });
    return needs.length === step.needs.length && needs.every((need, index) => need === step.needs[index])
      ? step
      : { ...step, needs };
  });

  return {
    ...book,
    steps: rewritten,
    blocks: Object.keys(blocks).length > 0 ? blocks : EMPTY_BLOCKS,
    roles,
  };
}

function prefixStep(
  child: StepIR,
  prefix: string,
  internalIds: ReadonlySet<string>,
  blockId: string,
  playbookId: string,
  blockInputs: Readonly<Record<string, InputBindingIR>>,
): StepIR {
  return {
    ...child,
    id: `${prefix}${child.id}`,
    needs: child.needs.map((need) => (internalIds.has(need) ? `${prefix}${need}` : need)),
    inputs: Object.fromEntries(
      Object.entries(child.inputs).map(([name, binding]) => {
        if (binding.from === "step") {
          return [name, { ...binding, stepId: `${prefix}${binding.stepId}` }];
        }
        if (binding.from === "playbook") {
          // A sub-playbook input is fed by the block step's input wiring.
          const mapped = blockInputs[binding.name];
          return [name, mapped ?? binding];
        }
        return [name, binding];
      }),
    ),
    on: Object.fromEntries(
      Object.entries(child.on).map(([outcome, value]) => [
        outcome,
        prefixTransition(value, prefix, internalIds),
      ]),
    ),
    use: { blockId, playbookId, depth: 1 },
  };
}

function prefixTransition(
  value: TransitionIR,
  prefix: string,
  internalIds: ReadonlySet<string>,
): TransitionIR {
  const target = (id: string): string => (internalIds.has(id) ? `${prefix}${id}` : id);
  if (value.kind === "goto") return { ...value, target: target(value.target) };
  if (value.kind === "ask") {
    return {
      ...value,
      target: target(value.target),
      ...(value.choices === undefined
        ? {}
        : {
            choices: Object.fromEntries(
              Object.entries(value.choices).map(([id, choice]) => [
                id,
                choice.goto === undefined ? choice : { ...choice, goto: target(choice.goto) },
              ]),
            ),
          }),
    };
  }
  return value;
}
