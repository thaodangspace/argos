import { argosError } from "../errors.js";
import type {
  AfterIR,
  AgentSettingsIR,
  AgentTargetIR,
  AskChoiceIR,
  BlockIR,
  BranchCaseIR,
  DeciderIR,
  DefaultsIR,
  GateChoiceIR,
  GateIR,
  InputBindingIR,
  InputDefIR,
  IsolationIR,
  OutputDefIR,
  RoleIR,
  ScriptIR,
  StepIR,
  StepKind,
  TransitionIR,
  UnhashedPlaybookIR,
} from "./ir.js";
import { isStepKind } from "./ir.js";
import type {
  RawAfter,
  RawAgent,
  RawChoices,
  RawDecider,
  RawDefaults,
  RawGateStep,
  RawInputDef,
  RawIsolation,
  RawOutputDef,
  RawPlaybook,
  RawRoleFile,
  RawRoleStep,
  RawScriptStep,
  RawStep,
  RawTransition,
} from "./schema.js";

/** Poll defaults from plan D3. */
export const DEFAULT_POLL_MS: Readonly<Record<StepKind, number>> = {
  agent: 3000,
  gate: 2000,
  script: 5000,
  branch: 0,
};

/** paseo's implicit gate buttons. */
export const DEFAULT_GATE_CHOICES: Readonly<Record<string, GateChoiceIR>> = {
  approved: { label: "Approve", comment: "none" },
  rejected: { label: "Reject", comment: "optional", color: "danger" },
};

/** Outcomes of a step that declares none (paseo compatibility). */
export const IMPLICIT_AGENT_OUTCOMES = ["success", "failure"] as const;

export interface LoadedRole {
  readonly id: string;
  readonly raw: RawRoleFile;
  readonly instructions: string;
}

export interface LoadedDefaults {
  readonly file: string;
  readonly raw: RawDefaults;
}

export interface ResolveContext {
  /** Absolute path of the playbook file, used in every error. */
  readonly file: string;
  readonly playbookId: string;
  /** Lazy role lookup; resolves a role or returns undefined so the caller can name the step. */
  readonly getRole: (id: string, stepId: string) => LoadedRole | undefined;
  readonly defaults?: LoadedDefaults;
  /** Roles referenced by this playbook, collected while resolving. */
  readonly referencedRoles: Map<string, RoleIR>;
}

interface Location {
  readonly file: string;
  readonly stepId?: string;
}

function invalid(location: Location, detail: string): never {
  throw argosError("playbook_invalid", location, detail);
}

/** Strip `undefined` keys before a typed cast: the IR must be exact JSON. */
function plain<T>(value: Record<string, unknown>): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value as unknown as T;
}

// ------------------------------------------------------------------ durations

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `"30s"`, `"5m"`, `"1h"` -> milliseconds. Used for paseo's `poll:` alias. */
export function durationToMs(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = DURATION_UNITS[(match[2] ?? "").toLowerCase()];
  if (unit === undefined || !Number.isFinite(amount)) return undefined;
  return Math.round(amount * unit);
}

// ------------------------------------------------------------------ agents

interface AgentCore {
  provider: string;
  model: string;
  modeId?: string;
  thinking?: string;
}

interface ResolvedAgent {
  readonly core?: AgentCore;
  readonly fallbacks: readonly AgentTargetIR[];
}

type TierEntry = RawAgent;

function targetOf(entry: TierEntry): AgentTargetIR {
  const modeId = entry.mode_id ?? entry.mode;
  return {
    provider: entry.provider ?? "",
    model: entry.model ?? "",
    ...(modeId !== undefined ? { modeId } : {}),
    ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
  };
}

/**
 * FR24 / plan Phase 2: step > role > playbook > `defaults/main.yaml`. Layers apply bottom-up.
 * A `tier` expands from the repo defaults; its remaining entries become fallbacks.
 */
export function resolveAgentCore(
  layers: readonly (RawAgent | undefined)[],
  tiers: RawDefaults["tiers"] | undefined,
  location: Location,
): ResolvedAgent {
  const core: { -readonly [K in keyof AgentCore]?: AgentCore[K] } = {};
  const fallbacks: AgentTargetIR[] = [];

  for (const layer of layers) {
    if (layer === undefined) continue;
    let own: TierEntry = layer;
    if (layer.tier !== undefined) {
      const tier = tiers?.[layer.tier];
      if (tier === undefined) {
        invalid(location, `unknown agent tier "${layer.tier}" (define it under \`tiers:\` in defaults/main.yaml)`);
      }
      const entries: readonly TierEntry[] = Array.isArray(tier) ? tier : [tier];
      const first = entries[0];
      if (first === undefined) invalid(location, `agent tier "${layer.tier}" is empty`);
      for (const extra of entries.slice(1)) fallbacks.push(targetOf(extra));
      own = {
        provider: layer.provider ?? first.provider,
        model: layer.model ?? first.model,
        mode_id: layer.mode_id ?? first.mode_id,
        mode: layer.mode ?? first.mode,
        thinking: layer.thinking ?? first.thinking,
      };
    }
    if (own.provider !== undefined) core.provider = own.provider;
    if (own.model !== undefined) core.model = own.model;
    const modeId = own.mode_id ?? own.mode;
    if (modeId !== undefined) core.modeId = modeId;
    if (own.thinking !== undefined) core.thinking = own.thinking;
    for (const extra of layer.fallback ?? []) fallbacks.push(targetOf(extra));
  }

  if (core.provider === undefined && core.model === undefined) {
    return { fallbacks: dedupeTargets(fallbacks) };
  }
  if (core.provider === undefined || core.model === undefined) {
    invalid(location, "agent settings are incomplete: both provider and model are required");
  }
  const resolved: AgentCore = { provider: core.provider, model: core.model };
  if (core.modeId !== undefined) resolved.modeId = core.modeId;
  if (core.thinking !== undefined) resolved.thinking = core.thinking;
  return {
    core: resolved,
    fallbacks: dedupeTargets(fallbacks).filter(
      (target) => target.provider !== core.provider || target.model !== core.model,
    ),
  };
}

function dedupeTargets(targets: readonly AgentTargetIR[]): AgentTargetIR[] {
  const seen = new Set<string>();
  const result: AgentTargetIR[] = [];
  for (const target of targets) {
    if (target.provider === "" || target.model === "") continue;
    const key = `${target.provider}/${target.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

function withLabels(
  core: AgentCore | undefined,
  labels: Readonly<Record<string, string>>,
): AgentSettingsIR | undefined {
  if (core === undefined) return undefined;
  return { ...core, labels: { ...labels } };
}

function resolveDecider(
  raw: RawDecider | undefined,
  ctx: ResolveContext,
  stepId: string,
  playbookAgent: RawAgent | undefined,
  playbookDefaultsAgent: RawAgent | undefined,
  labels: Readonly<Record<string, string>>,
): DeciderIR | undefined {
  if (raw === undefined) return undefined;
  let roleAgent: RawAgent | undefined;
  if (raw.by === "role") {
    if (raw.role === undefined) invalid({ file: ctx.file, stepId }, "a gate decider with `by: role` needs a `role`");
    const role = ctx.getRole(raw.role, stepId);
    if (role === undefined) {
      invalid({ file: ctx.file, stepId }, `unknown role "${raw.role}" for the gate decider`);
    }
    roleAgent = role.raw.agent;
    const roleWithDefaults = resolveAgentCore(
      [ctx.defaults?.raw.agent, playbookAgent, playbookDefaultsAgent, role.raw.agent],
      ctx.defaults?.raw.tiers,
      { file: ctx.file, stepId },
    );
    ctx.referencedRoles.set(role.id, roleIR(role, roleWithDefaults.core, labels));
  }
  const resolved = resolveAgentCore(
    [ctx.defaults?.raw.agent, playbookAgent, playbookDefaultsAgent, roleAgent, raw.agent],
    ctx.defaults?.raw.tiers,
    { file: ctx.file, stepId },
  );
  return plain<DeciderIR>({
    by: raw.by,
    role: raw.role,
    agent: withLabels(resolved.core, labels),
  });
}

// ------------------------------------------------------------------ roles

function roleIR(role: LoadedRole, agent: AgentCore | undefined, labels: Readonly<Record<string, string>>): RoleIR {
  return plain<RoleIR>({
    id: role.id,
    title: role.raw.title ?? role.id,
    readonly: role.raw.readonly ?? false,
    instructions: role.instructions,
    agent: withLabels(agent, labels),
    fallbacks: (role.raw.fallback ?? []).map(targetOf),
  });
}

// ------------------------------------------------------------------ inputs

interface StepSummary {
  readonly id: string;
  readonly outputs: Readonly<Record<string, OutputDefIR>>;
}

const SINGLE_REF = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/**
 * Wire step inputs from declared playbook inputs, earlier steps' outputs, or an explicit
 * `{{ playbook.inputs.x }}` / `{{ steps.x.outputs.y }}` expression (FR7/FR9).
 */
function wireInputs(
  raw: RawStep["inputs"],
  playbookInputs: Readonly<Record<string, InputDefIR>>,
  earlier: readonly StepSummary[],
  location: Location,
): Record<string, InputBindingIR> {
  const result: Record<string, InputBindingIR> = {};
  if (raw === undefined) return result;

  const byName = (name: string): InputBindingIR => {
    const candidates = earlier.filter((step) => step.outputs[name] !== undefined);
    if (candidates.length > 1) {
      invalid(
        location,
        `input "${name}" matches outputs of several steps (${candidates.map((step) => step.id).join(", ")}); wire it explicitly with "{{ steps.<id>.outputs.${name} }}"`,
      );
    }
    const only = candidates[0];
    if (only !== undefined) return { from: "step", stepId: only.id, output: name };
    if (playbookInputs[name] !== undefined) return { from: "playbook", name };
    invalid(
      location,
      `input "${name}" has no source: no earlier step outputs it and the playbook has no such input`,
    );
  };

  const wire = (name: string, value: string | null | undefined): InputBindingIR => {
    if (value === null || value === undefined) return byName(name);
    const single = SINGLE_REF.exec(value);
    if (single !== null) {
      const ref = single[1]?.trim() ?? "";
      const playbookRef = /^(?:playbook\.)?inputs\.([A-Za-z_][\w-]*)$/.exec(ref);
      if (playbookRef !== null) {
        const inputName = playbookRef[1] ?? "";
        if (playbookInputs[inputName] === undefined) {
          invalid(location, `input "${name}" reads undeclared playbook input "${inputName}"`);
        }
        return { from: "playbook", name: inputName };
      }
      const stepRef = /^steps\.([^.]+)\.outputs\.([A-Za-z_][\w-]*)$/.exec(ref);
      if (stepRef !== null) {
        const stepId = stepRef[1] ?? "";
        const output = stepRef[2] ?? "";
        const source = earlier.find((step) => step.id === stepId);
        if (source === undefined) {
          invalid(location, `input "${name}" reads step "${stepId}", which is not an earlier step`);
        }
        if (source.outputs[output] === undefined) {
          invalid(location, `input "${name}" reads output "${output}" of step "${stepId}", which declares none`);
        }
        return { from: "step", stepId, output };
      }
      return { from: "template", template: value };
    }
    if (value.includes("{{")) return { from: "template", template: value };
    return { from: "literal", value };
  };

  if (Array.isArray(raw)) {
    for (const name of raw) result[name] = byName(name);
    return result;
  }
  for (const [name, value] of Object.entries(raw)) result[name] = wire(name, value);
  return result;
}

// ------------------------------------------------------------------ definitions

function inputDef(raw: RawInputDef | null | undefined): InputDefIR {
  return plain<InputDefIR>({
    type: raw?.type ?? "string",
    values: raw?.values,
    required: raw?.required,
    default: raw?.default,
    description: raw?.description,
  });
}

function outputDef(raw: RawOutputDef | null | undefined): OutputDefIR {
  const base = inputDef(raw);
  return plain<OutputDefIR>({ ...base, value: raw?.value });
}

// ------------------------------------------------------------------ transitions

function gateChoices(raw: RawChoices | undefined): Record<string, GateChoiceIR> {
  if (raw === undefined) return { ...DEFAULT_GATE_CHOICES };
  if (Array.isArray(raw)) {
    const result: Record<string, GateChoiceIR> = {};
    for (const id of raw) result[id] = { label: id, comment: "none" };
    return result;
  }
  const result: Record<string, GateChoiceIR> = {};
  for (const [id, choice] of Object.entries(raw)) {
    result[id] = plain<GateChoiceIR>({
      label: choice?.label ?? id,
      comment: choice?.comment ?? "none",
      color: choice?.color,
    });
  }
  return result;
}

function askChoices(raw: RawChoices | undefined): Record<string, AskChoiceIR> | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const result: Record<string, AskChoiceIR> = {};
    for (const id of raw) result[id] = { label: id, comment: "required" };
    return result;
  }
  const result: Record<string, AskChoiceIR> = {};
  for (const [id, choice] of Object.entries(raw)) {
    result[id] = plain<AskChoiceIR>({
      label: choice?.label ?? id,
      comment: choice?.comment ?? "required",
      color: choice?.color,
      goto: choice?.goto,
      maxLoops: choice?.max_loops,
      outcome: choice?.outcome,
      outputs: choice?.outputs === undefined ? undefined : { ...choice.outputs },
    });
  }
  return result;
}

function transition(
  raw: RawTransition,
  ctx: ResolveContext,
  stepId: string,
  playbookAgent: RawAgent | undefined,
  playbookDefaultsAgent: RawAgent | undefined,
  labels: Readonly<Record<string, string>>,
): TransitionIR {
  if (typeof raw === "string") {
    if (raw === "complete") return { kind: "complete" };
    if (raw === "end") return { kind: "end" };
    return { kind: "fail" };
  }
  if ("end" in raw) return { kind: "end", outcome: raw.end };
  if ("ask" in raw) {
    return plain<TransitionIR>({
      kind: "ask",
      ask: raw.ask,
      target: raw.goto ?? stepId,
      maxLoops: raw.max_loops,
      choices: askChoices(raw.choices),
      decider: resolveDecider(raw.decider, ctx, stepId, playbookAgent, playbookDefaultsAgent, labels),
    });
  }
  if (typeof raw.goto === "string") {
    return plain<TransitionIR>({
      kind: "goto",
      target: raw.goto,
      maxLoops: raw.max_loops,
      decider: resolveDecider(raw.decider, ctx, stepId, playbookAgent, playbookDefaultsAgent, labels),
    });
  }
  return plain<TransitionIR>({
    kind: "goto",
    target: raw.goto.target,
    maxLoops: raw.goto.max_loops ?? raw.max_loops,
    decider: resolveDecider(raw.decider, ctx, stepId, playbookAgent, playbookDefaultsAgent, labels),
  });
}

function resolveBranch(raw: RawStep["branch"]): { readonly cases: readonly BranchCaseIR[] } | undefined {
  if (raw === undefined) return undefined;
  return {
    cases: raw.cases.map((item) =>
      plain<BranchCaseIR>({ name: item.name, when: item.if, end: item.end }),
    ),
  };
}

// ------------------------------------------------------------------ steps

function stepKind(raw: RawStep, location: Location): StepKind {
  const hasUse = raw.use !== undefined || raw.playbook !== undefined;
  const inferred: StepKind =
    raw.branch !== undefined
      ? "branch"
      : raw.script !== undefined
        ? "script"
        : raw.gate !== undefined || raw.choices !== undefined
          ? "gate"
          : "agent";
  if (hasUse && raw.kind !== undefined && raw.kind !== "agent") {
    invalid(location, `a sub-playbook step has kind "${raw.kind}"; \`use\` steps are expanded as agent steps`);
  }
  if (raw.kind === undefined) return inferred;
  if (!isStepKind(raw.kind)) invalid(location, `unknown step kind "${raw.kind}"`);
  if (raw.kind !== inferred && !(raw.kind === "agent" && hasUse)) {
    invalid(location, `kind "${raw.kind}" does not match the step fields (inferred "${inferred}")`);
  }
  return raw.kind;
}

function normalizeIsolation(raw: RawIsolation | undefined): IsolationIR | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return { mode: raw };
  return plain<IsolationIR>({ mode: raw.mode ?? "none", base: raw.base });
}

function stepOutcomes(
  raw: RawStep,
  kind: StepKind,
  choices: Readonly<Record<string, GateChoiceIR>> | undefined,
  branchIR: { readonly cases: readonly BranchCaseIR[] } | undefined,
): string[] {
  if (raw.outcomes !== undefined) return [...raw.outcomes];
  if (kind === "gate") return Object.keys(choices ?? DEFAULT_GATE_CHOICES);
  if (kind === "branch") return (branchIR?.cases ?? []).map((item) => item.name);
  return [...IMPLICIT_AGENT_OUTCOMES];
}

interface ResolvedPlaybookContext {
  readonly agent: RawAgent | undefined;
  readonly defaultsAgent: RawAgent | undefined;
  readonly inputs: Record<string, InputDefIR>;
  readonly labels: Record<string, string>;
}

function gateStep(raw: RawStep): RawGateStep | undefined {
  return typeof raw.gate === "object" ? raw.gate : undefined;
}

function resolveStep(
  raw: RawStep,
  ctx: ResolveContext,
  playbook: ResolvedPlaybookContext,
  earlier: readonly StepSummary[],
): StepIR {
  const location: Location = { file: ctx.file, stepId: raw.id };
  const kind = stepKind(raw, location);
  const labels: Record<string, string> = { ...playbook.labels, ...(raw.labels ?? {}) };
  const roleBlock: RawRoleStep | undefined = typeof raw.role === "object" ? raw.role : undefined;
  const roleId = typeof raw.role === "string" ? raw.role : roleBlock?.name;

  let role: RoleIR | undefined;
  let roleFile: LoadedRole | undefined;
  if (roleId !== undefined) {
    roleFile = ctx.getRole(roleId, raw.id);
    if (roleFile === undefined) {
      invalid(location, `unknown role "${roleId}" (no ${roleId}/role.yaml in the roles directory)`);
    }
    const roleAgent = resolveAgentCore(
      [ctx.defaults?.raw.agent, playbook.agent, playbook.defaultsAgent, roleFile.raw.agent],
      ctx.defaults?.raw.tiers,
      location,
    );
    role = roleIR(roleFile, roleAgent.core, playbook.labels);
    ctx.referencedRoles.set(roleFile.id, role);
  }

  const resolvedAgent = resolveAgentCore(
    [
      ctx.defaults?.raw.agent,
      playbook.agent,
      playbook.defaultsAgent,
      roleFile?.raw.agent,
      roleBlock?.agent,
      raw.agent,
    ],
    ctx.defaults?.raw.tiers,
    location,
  );
  const fallbacks = dedupeTargets([
    ...resolvedAgent.fallbacks,
    ...(roleFile?.raw.fallback ?? []).map(targetOf),
    ...(roleBlock?.fallback ?? []).map(targetOf),
  ]);

  const choices = kind === "gate" ? gateChoices(raw.choices ?? gateStep(raw)?.choices) : undefined;
  const branchIR = resolveBranch(raw.branch);
  const outputs: Record<string, OutputDefIR> = {};
  for (const [name, def] of Object.entries(raw.outputs ?? {})) outputs[name] = outputDef(def);

  let gate: GateIR | undefined;
  if (kind === "gate") {
    const question = typeof raw.gate === "string" ? raw.gate : gateStep(raw)?.question;
    if (question === undefined) {
      invalid(location, "a gate step needs a `gate` question (string or `{ question }` block)");
    }
    gate = plain<GateIR>({
      question,
      choices: choices ?? DEFAULT_GATE_CHOICES,
      decider: resolveDecider(
        gateStep(raw)?.decider,
        ctx,
        raw.id,
        playbook.agent,
        playbook.defaultsAgent,
        labels,
      ),
    });
  }

  let script: ScriptIR | undefined;
  if (kind === "script") {
    const block: RawScriptStep | undefined = typeof raw.script === "object" ? raw.script : undefined;
    const run = typeof raw.script === "string" ? raw.script : block?.run;
    if (run === undefined || run === "") invalid(location, "a script step needs `script: <name>` or `script: { run }`");
    script = { run, env: [...(block?.env ?? raw.env ?? [])] };
  }

  const pollMs =
    raw.pollMs ??
    raw.poll_ms ??
    (raw.poll !== undefined ? (durationToMs(raw.poll) ?? DEFAULT_POLL_MS[kind]) : DEFAULT_POLL_MS[kind]);

  const on: Record<string, TransitionIR> = {};
  for (const [outcome, transitionRaw] of Object.entries(raw.on ?? {})) {
    on[outcome] = transition(
      transitionRaw,
      ctx,
      raw.id,
      playbook.agent,
      playbook.defaultsAgent,
      labels,
    );
  }

  const useId =
    raw.use ?? (typeof raw.playbook === "string" ? raw.playbook : raw.playbook?.name);
  return plain<StepIR>({
    id: raw.id,
    title: raw.title ?? raw.id,
    kind,
    needs: [...(raw.needs ?? [])],
    prompt: raw.prompt ?? roleBlock?.prompt,
    inputs: wireInputs(raw.inputs, playbook.inputs, earlier, location),
    outputs,
    outcomes: stepOutcomes(raw, kind, choices, branchIR),
    on,
    gate,
    choices,
    script,
    pollMs,
    timeout: raw.timeout,
    retries: raw.retries ?? 0,
    agent: withLabels(resolvedAgent.core, labels),
    role,
    fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
    labels,
    when: raw.when,
    branch: branchIR,
    use:
      useId === undefined
        ? undefined
        : { blockId: raw.id, playbookId: useId, depth: 1 },
  });
}

function resolveStepList(
  rawSteps: readonly RawStep[],
  ctx: ResolveContext,
  playbook: ResolvedPlaybookContext,
): StepIR[] {
  const steps: StepIR[] = [];
  for (const raw of rawSteps) {
    steps.push(resolveStep(raw, ctx, playbook, steps));
  }
  return steps;
}

/**
 * Normalize one playbook. Expansion (`expand.ts`) runs afterwards and may replace sub-playbook
 * steps; validation (`validate.ts`) runs on the fully expanded graph.
 */
export function resolvePlaybook(raw: RawPlaybook, ctx: ResolveContext): UnhashedPlaybookIR {
  const playbookLabels: Record<string, string> = {
    ...(ctx.defaults?.raw.labels ?? {}),
    ...(raw.labels ?? {}),
  };
  const inputs: Record<string, InputDefIR> = {};
  for (const [name, def] of Object.entries(raw.inputs ?? {})) inputs[name] = inputDef(def);
  const outputs: Record<string, OutputDefIR> = {};
  for (const [name, def] of Object.entries(raw.outputs ?? {})) outputs[name] = outputDef(def);

  const playbook: ResolvedPlaybookContext = {
    agent: raw.agent,
    defaultsAgent: raw.defaults?.agent,
    inputs,
    labels: playbookLabels,
  };
  const steps = resolveStepList(raw.steps, ctx, playbook);

  const after: AfterIR[] = (raw.after ?? []).map((item: RawAfter) => {
    const afterSteps = resolveStepList(item.steps, ctx, playbook);
    return plain<AfterIR>({
      id: item.id,
      title: item.title ?? item.id,
      trigger: item.trigger ?? "auto",
      steps: afterSteps,
    });
  });

  const playbookDefaultsAgent = resolveAgentCore(
    [ctx.defaults?.raw.agent, raw.agent, raw.defaults?.agent],
    ctx.defaults?.raw.tiers,
    { file: ctx.file },
  );
  const defaultsAgent = withLabels(playbookDefaultsAgent.core, playbookLabels);
  const isolation =
    normalizeIsolation(raw.isolation) ??
    normalizeIsolation(raw.defaults?.isolation) ??
    normalizeIsolation(ctx.defaults?.raw.isolation);

  const roles: Record<string, RoleIR> = {};
  for (const [id, role] of ctx.referencedRoles) roles[id] = role;

  const defaults: DefaultsIR | undefined =
    defaultsAgent !== undefined ||
    isolation !== undefined ||
    Object.keys(ctx.defaults?.raw.labels ?? {}).length > 0
      ? plain<DefaultsIR>({
          agent: defaultsAgent,
          isolation,
          labels: { ...(ctx.defaults?.raw.labels ?? {}) },
        })
      : undefined;

  return plain<UnhashedPlaybookIR>({
    version: 1,
    id: ctx.playbookId,
    title: raw.title ?? ctx.playbookId,
    description: raw.description ?? "",
    inputs,
    outputs,
    concurrency: raw.concurrency,
    isolation,
    steps,
    outcomes: [...(raw.outcomes ?? [])],
    blocks: {} as Record<string, BlockIR>,
    after,
    labels: playbookLabels,
    roles,
    defaults,
  });
}
