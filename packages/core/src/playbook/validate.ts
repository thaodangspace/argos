import { argosError } from "../errors.js";
import type { BlockIR, StepIR, TransitionIR, UnhashedPlaybookIR } from "./ir.js";

interface Scope {
  readonly file: string;
  readonly ids: ReadonlySet<string>;
  readonly blockIds: ReadonlySet<string>;
}

function invalid(file: string, stepId: string | undefined, detail: string): never {
  throw argosError("playbook_invalid", { file, ...(stepId === undefined ? {} : { stepId }) }, detail);
}

function checkDuplicateIds(steps: readonly StepIR[], file: string): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) invalid(file, step.id, `duplicate step id "${step.id}"`);
    seen.add(step.id);
  }
}

function checkTarget(scope: Scope, id: string, target: string, what: string): void {
  if (target === id) return;
  if (scope.ids.has(target) || scope.blockIds.has(target)) return;
  invalid(scope.file, id, `${what} targets unknown step "${target}"`);
}

function checkTransition(
  scope: Scope,
  id: string,
  outcomes: readonly string[],
  outcome: string,
  value: TransitionIR,
): void {
  if (!outcomes.includes(outcome)) {
    invalid(
      scope.file,
      id,
      `(\`on: ${outcome}\`) is not an outcome of this step (outcomes: ${outcomes.join(", ")})`,
    );
  }
  switch (value.kind) {
    case "complete":
    case "fail":
    case "end":
      return;
    case "goto":
      checkTarget(scope, id, value.target, `on.${outcome}.goto`);
      if (value.maxLoops !== undefined && value.maxLoops < 1) {
        invalid(scope.file, id, `on.${outcome}.max_loops must be >= 1`);
      }
      return;
    case "ask":
      checkTarget(scope, id, value.target, `on.${outcome}.ask.goto`);
      if (value.maxLoops !== undefined && value.maxLoops < 1) {
        invalid(scope.file, id, `on.${outcome}.max_loops must be >= 1`);
      }
      for (const [choiceId, choice] of Object.entries(value.choices ?? {})) {
        if (choice.goto !== undefined) {
          checkTarget(scope, id, choice.goto, `on.${outcome}.choices.${choiceId}.goto`);
        }
        if (choice.outcome !== undefined && !outcomes.includes(choice.outcome)) {
          invalid(
            scope.file,
            id,
            `on.${outcome}.choices.${choiceId}.outcome "${choice.outcome}" is not an outcome of this step`,
          );
        }
        if (choice.maxLoops !== undefined && choice.maxLoops < 1) {
          invalid(scope.file, id, `on.${outcome}.choices.${choiceId}.max_loops must be >= 1`);
        }
      }
      return;
  }
}

function checkStep(scope: Scope, step: StepIR): void {
  if (step.kind === "agent" && step.prompt === undefined) {
    invalid(
      scope.file,
      step.id,
      "an agent step needs a `prompt` (step-level or inside its `role` block)",
    );
  }

  for (const need of step.needs) {
    if (!scope.ids.has(need) && !scope.blockIds.has(need)) {
      invalid(scope.file, step.id, `needs unknown step "${need}"`);
    }
    if (need === step.id) invalid(scope.file, step.id, "a step cannot need itself");
  }

  for (const [outcome, value] of Object.entries(step.on)) {
    checkTransition(scope, step.id, step.outcomes, outcome, value);
  }

  if (step.kind === "gate") {
    if (step.gate === undefined) invalid(scope.file, step.id, "a gate step needs a `gate` question");
    for (const choiceId of Object.keys(step.gate.choices)) {
      if (!step.outcomes.includes(choiceId)) {
        invalid(scope.file, step.id, `gate choice "${choiceId}" is not an outcome of this step`);
      }
    }
  }

  if (step.kind === "script" && step.script === undefined) {
    invalid(scope.file, step.id, "a script step needs a `script`");
  }

  if (step.kind === "branch") {
    const cases = step.branch?.cases ?? [];
    if (cases.length === 0) invalid(scope.file, step.id, "a branch step needs at least one case");
    const names = new Set<string>();
    for (const [index, item] of cases.entries()) {
      if (names.has(item.name)) invalid(scope.file, step.id, `duplicate branch case "${item.name}"`);
      names.add(item.name);
      const last = index === cases.length - 1;
      if (!last && item.when === undefined) {
        invalid(scope.file, step.id, `branch case "${item.name}" needs an \`if\` (only the last case may be the else)`);
      }
      if (last && item.when !== undefined) {
        invalid(scope.file, step.id, "the last branch case is the else and must not have an `if`");
      }
    }
  }

  if (step.retries < 0) invalid(scope.file, step.id, "retries must be >= 0");
  if (step.pollMs < 0) invalid(scope.file, step.id, "pollMs must be >= 0");
}

function checkBlocks(scope: Scope, blocks: Readonly<Record<string, BlockIR>>): void {
  for (const block of Object.values(blocks)) {
    for (const [outcome, value] of Object.entries(block.on)) {
      checkTransition(scope, block.id, block.outcomes, outcome, value);
    }
  }
}

function checkCycles(steps: readonly StepIR[], file: string): void {
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const at = stack.lastIndexOf(id);
      const path = [...stack.slice(at === -1 ? 0 : at), id];
      const repeated = path[path.length - 1];
      throw argosError(
        "playbook_cycle",
        { file, ...(repeated === undefined ? {} : { stepId: repeated }) },
        `dependency cycle: ${path.join(" -> ")}`,
      );
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      if (byId.has(need)) visit(need);
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const step of steps) visit(step.id);
}

function validateStepList(
  steps: readonly StepIR[],
  file: string,
  label: string,
  book: UnhashedPlaybookIR,
): void {
  checkDuplicateIds(steps, file);
  const scope: Scope = {
    file,
    ids: new Set(steps.map((step) => step.id)),
    blockIds: new Set(Object.keys(book.blocks)),
  };
  for (const step of steps) {
    if (step.use !== undefined && label !== "playbook") {
      invalid(file, step.id, `\`use\` is not supported inside ${label} (only in the main step graph)`);
    }
    checkStep(scope, step);
  }
  checkCycles(steps, file);
}

/**
 * FR8/FR10/FR21: validate the fully expanded graph and throw the first problem as a
 * `playbook_invalid` (or `playbook_cycle`) error naming the file and step.
 */
export function validatePlaybook(book: UnhashedPlaybookIR, file: string): void {
  validateStepList(book.steps, file, "playbook", book);
  checkBlocks(
    {
      file,
      ids: new Set(book.steps.map((step) => step.id)),
      blockIds: new Set(Object.keys(book.blocks)),
    },
    book.blocks,
  );

  const afterIds = new Set<string>();
  for (const after of book.after) {
    if (afterIds.has(after.id)) invalid(file, after.id, `duplicate after-task id "${after.id}"`);
    afterIds.add(after.id);
    validateStepList(after.steps, file, "after-task", book);
  }
}
