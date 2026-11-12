/**
 * The frozen playbook IR — the stable contract every later phase consumes. Everything here is
 * plain JSON: no class instances, no Maps, no functions, no absolute paths. A `PlaybookIR` can
 * be JSON round-tripped byte-for-byte and its `hash` is stable across machines.
 */

/** Agent settings after tier expansion and precedence resolution. */
export interface AgentSettingsIR {
  readonly provider: string;
  readonly model: string;
  readonly modeId?: string;
  readonly thinking?: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface AgentTargetIR {
  readonly provider: string;
  readonly model: string;
  readonly modeId?: string;
  readonly thinking?: string;
}

export interface RoleIR {
  readonly id: string;
  readonly title: string;
  readonly readonly: boolean;
  readonly instructions: string;
  readonly agent?: AgentSettingsIR;
  readonly fallbacks: readonly AgentTargetIR[];
}

export type InputType = "string" | "number" | "boolean" | "enum";
export type Scalar = string | number | boolean;

export interface InputDefIR {
  readonly type: InputType;
  readonly values?: readonly string[];
  readonly required?: boolean;
  readonly default?: Scalar;
  readonly description?: string;
}

export interface OutputDefIR {
  readonly type: InputType;
  readonly values?: readonly string[];
  readonly required?: boolean;
  readonly default?: Scalar;
  readonly description?: string;
  /** Template the value is read from (paseo `outputs.<name>.value`). */
  readonly value?: string;
}

/**
 * Where a step input takes its value. `playbook` reads a run input, `step` reads an output of an
 * earlier step, `template` is a mixed template over both, `literal` is a constant.
 */
export type InputBindingIR =
  | { readonly from: "playbook"; readonly name: string }
  | { readonly from: "step"; readonly stepId: string; readonly output: string }
  | { readonly from: "template"; readonly template: string }
  | { readonly from: "literal"; readonly value: Scalar | null };

export type WhenOperandIR =
  | Scalar
  | readonly Scalar[]
  | { readonly empty: boolean };

/** A `when` condition: every key must hold. Stored as written, JSON-stable. */
export type WhenIR = Readonly<Record<string, WhenOperandIR>>;

export interface BranchCaseIR {
  readonly name: string;
  readonly when?: WhenIR;
  readonly end?: true | string;
}

export interface BranchIR {
  readonly cases: readonly BranchCaseIR[];
}

export interface DeciderIR {
  readonly by: "human" | "manager" | "role";
  readonly role?: string;
  readonly agent?: AgentSettingsIR;
}

export interface GateChoiceIR {
  readonly label: string;
  readonly comment: "none" | "optional" | "required";
  readonly color?: "primary" | "neutral" | "success" | "warning" | "danger";
}

export interface AskChoiceIR {
  readonly label?: string;
  readonly comment: "none" | "optional" | "required";
  readonly color?: "primary" | "neutral" | "success" | "warning" | "danger";
  /** Argos extension: where this choice goes (defaults to the ask target). */
  readonly goto?: string;
  readonly maxLoops?: number;
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

/**
 * A transition, normalized to a tagged union (never a YAML shortcut).
 * `goto`/`ask.target` may name a step, the step itself, or a sub-playbook block id.
 */
export type TransitionIR =
  | { readonly kind: "complete" }
  | { readonly kind: "end"; readonly outcome?: string }
  | { readonly kind: "fail" }
  | {
      readonly kind: "goto";
      readonly target: string;
      readonly maxLoops?: number;
      readonly decider?: DeciderIR;
    }
  | {
      readonly kind: "ask";
      readonly ask: string;
      readonly target: string;
      readonly maxLoops?: number;
      readonly choices?: Readonly<Record<string, AskChoiceIR>>;
      readonly decider?: DeciderIR;
    };

export interface GateIR {
  readonly question: string;
  readonly choices: Readonly<Record<string, GateChoiceIR>>;
  readonly decider?: DeciderIR;
}

export interface ScriptIR {
  readonly run: string;
  readonly env: readonly string[];
}

export interface IsolationIR {
  readonly mode: "none" | "worktree";
  readonly base?: string;
}

export type StepKind = "agent" | "gate" | "script" | "branch";

/** Provenance for a step that came from a sub-playbook (FR10). */
export interface UseProvenanceIR {
  readonly blockId: string;
  readonly playbookId: string;
  /** 1 = inlined from a playbook used by the top-level playbook. */
  readonly depth: number;
}

export interface StepIR {
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly needs: readonly string[];
  readonly prompt?: string;
  readonly inputs: Readonly<Record<string, InputBindingIR>>;
  readonly outputs: Readonly<Record<string, OutputDefIR>>;
  readonly outcomes: readonly string[];
  readonly on: Readonly<Record<string, TransitionIR>>;
  readonly gate?: GateIR;
  readonly choices?: Readonly<Record<string, GateChoiceIR>>;
  readonly script?: ScriptIR;
  readonly pollMs: number;
  readonly timeout?: string | number;
  readonly retries: number;
  /** Fully resolved; absent when no layer names a provider/model. */
  readonly agent?: AgentSettingsIR;
  readonly role?: RoleIR;
  /** Fallback targets from the role (FR9), in order. */
  readonly fallbacks?: readonly AgentTargetIR[];
  /** Merged playbook labels + step labels. */
  readonly labels: Readonly<Record<string, string>>;
  readonly when?: WhenIR;
  readonly branch?: BranchIR;
  readonly use?: UseProvenanceIR;
}

/**
 * A sub-playbook step after expansion. The block itself is not an executable step: its children
 * are inlined into `steps`, and references to the block id (`needs`, `goto`) resolve through it.
 * `needs` edges are rewritten to the block's terminals at load time; a step input binding that
 * reads `steps.<block>.outputs.<name>` stays block-qualified and is resolved by the engine from
 * `outputs` (an explicit `value`, or the unique inlined step that declares the output).
 */
export interface BlockIR {
  readonly id: string;
  readonly playbookId: string;
  readonly title: string;
  readonly stepIds: readonly string[];
  readonly entry: readonly string[];
  readonly terminals: readonly string[];
  readonly inputs: Readonly<Record<string, InputBindingIR>>;
  readonly outputs: Readonly<Record<string, OutputDefIR>>;
  readonly outcomes: readonly string[];
  readonly on: Readonly<Record<string, TransitionIR>>;
  readonly when?: WhenIR;
}

export interface AfterIR {
  readonly id: string;
  readonly title: string;
  readonly trigger: "auto" | "manual";
  readonly steps: readonly StepIR[];
}

/**
 * `providers` quota policy (FR24): from the playbook's `defaults.providers`, else
 * `defaults/main.yaml` `providers` (whole object, no per-field merge). Absent = executor defaults
 * and `on_exhausted: fail`.
 */
export interface ProvidersIR {
  readonly onExhausted: "fail" | "wait";
  /** `exhausted_for`: how long a quota-exhausted target is skipped. */
  readonly exhaustedForMs?: number;
  /** `max_wait`: total time one step may spend parked on `provider_exhausted`. */
  readonly maxWaitMs?: number;
}

export interface DefaultsIR {
  readonly agent?: AgentSettingsIR;
  readonly isolation?: IsolationIR;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PlaybookIR {
  /** IR format version; bumped only for a breaking change to this file. */
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** sha256 over the canonical JSON of this IR without `hash`. */
  readonly hash: string;
  readonly inputs: Readonly<Record<string, InputDefIR>>;
  readonly outputs: Readonly<Record<string, OutputDefIR>>;
  readonly concurrency?: number;
  readonly isolation?: IsolationIR;
  readonly steps: readonly StepIR[];
  /** How the playbook can end when used as a sub-playbook (FR10). Empty = implicit success/failure. */
  readonly outcomes: readonly string[];
  /** Sub-playbook blocks, in source order. Empty when the playbook has no `use` steps. */
  readonly blocks: Readonly<Record<string, BlockIR>>;
  readonly after: readonly AfterIR[];
  readonly labels: Readonly<Record<string, string>>;
  readonly roles: Readonly<Record<string, RoleIR>>;
  readonly defaults?: DefaultsIR;
  readonly providers?: ProvidersIR;
}

/** A resolved but not yet hashed/frozen playbook; internal to the load pipeline. */
export type UnhashedPlaybookIR = Omit<PlaybookIR, "hash">;

export function isStepKind(value: string): value is StepKind {
  return value === "agent" || value === "gate" || value === "script" || value === "branch";
}

/** Deep-freeze plain JSON so later phases cannot mutate the contract by accident. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Normalize to plain JSON (drops `undefined` properties, which JSON would drop anyway) so a
 * `PlaybookIR` always survives `JSON.parse(JSON.stringify(...))` deep-equal.
 */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
