import { z } from "zod";

/**
 * Raw YAML shapes. These mirror the paseo-playbooks format (FR6–FR11) plus the Argos
 * extensions. Every Argos surface is strict (FR1): the playbook, a step, and an input/output
 * definition reject unknown keys, so a typo like `need:` is `playbook_invalid` instead of a
 * silently ignored dependency. Upstream-only keys (FR1.2) are declared as
 * `z.unknown().optional()` so real paseo files keep loading; the inner `manager`/`workspace`
 * shapes stay loose because upstream may extend them.
 *
 * Compatibility aliases accepted and normalized by `resolve.ts`:
 * - `poll_ms` | `pollMs` | `poll` (duration string, paseo script block) -> `StepIR.pollMs`
 * - `mode` | `mode_id` (FR9 spells it `mode_id`, paseo uses `mode`) -> `modeId`
 * - `use: <id>` (FR10) | `playbook: <id>` / `playbook: { name: <id> }` (paseo) -> sub-playbook
 * - flat `gate: <question>` + step-level `choices` (FR7) | `gate: { question, choices }` (paseo)
 * - flat `script: <name>` (FR7) | `script: { run, poll, env }` (paseo)
 * - `goto: <id>` + sibling `max_loops` | `goto: { target, max_loops }` (plan FR8/decisions)
 */

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export type RawScalar = z.infer<typeof ScalarSchema>;

const DurationSchema = z.union([z.string().min(1), z.number().nonnegative()]);
const ColorSchema = z.enum(["primary", "neutral", "success", "warning", "danger"]);
const CommentSchema = z.enum(["none", "optional", "required"]);

const RawVarDefSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "enum"]).optional(),
  values: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  default: ScalarSchema.optional(),
  description: z.string().optional(),
});

export const RawInputDefSchema = RawVarDefSchema;
export const RawOutputDefSchema = RawVarDefSchema.extend({ value: z.string().optional() });
export type RawInputDef = z.infer<typeof RawInputDefSchema>;
export type RawOutputDef = z.infer<typeof RawOutputDefSchema>;

/** A provider/model pair. `mode_id` is the FR9 spelling, `mode` the paseo one. */
export const RawAgentTargetSchema = z.strictObject({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  mode_id: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
});

export const RawAgentSchema = RawAgentTargetSchema.extend({
  /** A named bundle from `defaults/main.yaml` `tiers:` (paseo compatibility). */
  tier: z.string().min(1).optional(),
  fallback: z.array(RawAgentTargetSchema).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export type RawAgent = z.infer<typeof RawAgentSchema>;

export const RawIsolationSchema = z.union([
  z.enum(["none", "worktree"]),
  z.strictObject({
    mode: z.enum(["none", "worktree"]).optional(),
    base: z.string().min(1).optional(),
    /** paseo fields, accepted so their defaults do not fail the load; not part of the IR. */
    submodules: z.union([z.enum(["none", "all"]), z.array(z.string().min(1))]).optional(),
    allow_gitlink_removal: z.boolean().optional(),
  }),
]);

export type RawIsolation = z.infer<typeof RawIsolationSchema>;

export const RawDeciderSchema = z.strictObject({
  by: z.enum(["human", "manager", "role"]),
  role: z.string().min(1).optional(),
  agent: RawAgentSchema.optional(),
});
export type RawDecider = z.infer<typeof RawDeciderSchema>;

/** A `when` operand: a value, any of a list, or an emptiness test. */
export const RawConditionSchema = z.record(
  z.string(),
  z.union([
    ScalarSchema,
    z.array(ScalarSchema).min(1),
    z.strictObject({ empty: z.boolean() }),
  ]),
);
export type RawCondition = z.infer<typeof RawConditionSchema>;

export const RawBranchSchema = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        if: RawConditionSchema.optional(),
        end: z.union([z.literal(true), z.string().min(1)]).optional(),
      }),
    )
    .min(1),
});

export const RawChoiceSchema = z.strictObject({
  label: z.string().optional(),
  comment: CommentSchema.optional(),
  color: ColorSchema.optional(),
  /** Argos extension: a gate choice may jump on its own (paseo `ask` choices do). */
  goto: z.string().min(1).optional(),
  max_loops: z.number().int().min(1).optional(),
  outcome: z.string().min(1).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});

/** `choices: [approve, reject]` or `choices: { approve: { label }, reject: null }`. */
export const RawChoicesSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), RawChoiceSchema.nullable()),
]);
export type RawChoices = z.infer<typeof RawChoicesSchema>;

const RawGotoObjectSchema = z.strictObject({
  target: z.string().min(1),
  max_loops: z.number().int().min(1).optional(),
});

export const RawTransitionSchema = z.union([
  z.enum(["complete", "end", "fail"]),
  z.strictObject({ end: z.string().min(1) }),
  z.strictObject({
    goto: z.union([z.string().min(1), RawGotoObjectSchema]),
    max_loops: z.number().int().min(1).optional(),
    decider: RawDeciderSchema.optional(),
  }),
  z.strictObject({
    ask: z.string().min(1),
    goto: z.string().min(1).optional(),
    max_loops: z.number().int().min(1).optional(),
    choices: z.record(z.string(), RawChoiceSchema.nullable()).optional(),
    decider: RawDeciderSchema.optional(),
  }),
]);
export type RawTransition = z.infer<typeof RawTransitionSchema>;

export const RawRoleStepSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().optional(),
  agent: RawAgentSchema.optional(),
  fallback: z.array(RawAgentTargetSchema).optional(),
  silence: z.string().optional(),
  archive_agents: z.boolean().optional(),
});
export type RawRoleStep = z.infer<typeof RawRoleStepSchema>;

export const RawGateStepSchema = z.strictObject({
  question: z.string().min(1),
  choices: z.record(z.string(), RawChoiceSchema.nullable()).optional(),
  decider: RawDeciderSchema.optional(),
});
export type RawGateStep = z.infer<typeof RawGateStepSchema>;

export const RawScriptStepSchema = z.strictObject({
  run: z.string().min(1),
  poll: z.string().min(1).optional(),
  env: z.array(z.string().min(1)).optional(),
});
export type RawScriptStep = z.infer<typeof RawScriptStepSchema>;

export const RawStepSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  short_title: z.string().min(1).optional(),
  kind: z.enum(["agent", "gate", "script", "branch"]).optional(),
  role: z.union([z.string().min(1), RawRoleStepSchema]).optional(),
  needs: z.array(z.string().min(1)).optional(),
  prompt: z.string().optional(),
  inputs: z
    .union([z.array(z.string().min(1)), z.record(z.string(), z.string().nullable())])
    .optional(),
  outputs: z.record(z.string(), RawOutputDefSchema.nullable()).optional(),
  outcomes: z.array(z.string().min(1)).min(1).optional(),
  on: z.record(z.string(), RawTransitionSchema).optional(),
  gate: z.union([z.string().min(1), RawGateStepSchema]).optional(),
  choices: RawChoicesSchema.optional(),
  script: z.union([z.string().min(1), RawScriptStepSchema]).optional(),
  pollMs: z.number().int().positive().optional(),
  poll_ms: z.number().int().positive().optional(),
  poll: z.string().min(1).optional(),
  timeout: DurationSchema.optional(),
  retries: z.number().int().min(0).optional(),
  agent: RawAgentSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  env: z.array(z.string().min(1)).optional(),
  when: RawConditionSchema.optional(),
  branch: RawBranchSchema.optional(),
  /** FR10 sub-playbook reference. */
  use: z.string().min(1).optional(),
  /** paseo sub-playbook spelling. */
  playbook: z.union([z.string().min(1), z.strictObject({ name: z.string().min(1) })]).optional(),
  /** FR11 only on after-tasks; a plain step with a trigger is rejected by the validator. */
  trigger: z.enum(["auto", "manual"]).optional(),
  /** paseo fields accepted but not part of the v1 IR. */
  silence: z.string().optional(),
  archive_agents: z.boolean().optional(),
  handoff: z.unknown().optional(),
  queue: z.unknown().optional(),
  settle: z.unknown().optional(),
});
export type RawStep = z.infer<typeof RawStepSchema>;

/** FR11: an after-task is a named, triggered list of steps. */
export const RawAfterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  trigger: z.enum(["auto", "manual"]).optional(),
  steps: z.array(RawStepSchema).min(1),
});
export type RawAfter = z.infer<typeof RawAfterSchema>;

/** FR24 quota policy; `fallback` is parsed for paseo-playbooks compatibility and ignored. */
export const RawProvidersSchema = z.strictObject({
  exhausted_for: DurationSchema.optional(),
  on_exhausted: z.enum(["fail", "wait"]).optional(),
  max_wait: DurationSchema.optional(),
  fallback: z.array(z.string().min(1)).optional(),
});
export type RawProviders = z.infer<typeof RawProvidersSchema>;

export const RawDefaultsSchema = z.strictObject({
  agent: RawAgentSchema.optional(),
  tiers: z
    .record(z.string(), z.union([RawAgentTargetSchema, z.array(RawAgentTargetSchema).min(1)]))
    .optional(),
  providers: RawProvidersSchema.optional(),
  manager: RawAgentSchema.extend({ compact: z.unknown().optional() }).optional(),
  workspace: z.object({ archive: z.enum(["never", "on_end"]).optional(), keep_failed: z.boolean().optional() }).optional(),
  isolation: RawIsolationSchema.optional(),
  role: z
    .strictObject({ silence: z.string().optional(), archive_agents: z.boolean().optional() })
    .optional(),
  labels: z.record(z.string(), z.string()).optional(),
  timeout: DurationSchema.optional(),
  reload_stale_sessions: z.boolean().optional(),
});
export type RawDefaults = z.infer<typeof RawDefaultsSchema>;

export const RawRoleFileSchema = z.strictObject({
  title: z.string().min(1).optional(),
  readonly: z.boolean().optional(),
  agent: RawAgentSchema.optional(),
  fallback: z.array(RawAgentTargetSchema).optional(),
  silence: z.string().optional(),
  archive_agents: z.boolean().optional(),
});
export type RawRoleFile = z.infer<typeof RawRoleFileSchema>;

/** Argos-only playbook defaults block. */
export const RawPlaybookDefaultsSchema = z.strictObject({
  agent: RawAgentSchema.optional(),
  providers: RawProvidersSchema.optional(),
  isolation: RawIsolationSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
});
export type RawPlaybookDefaults = z.infer<typeof RawPlaybookDefaultsSchema>;

export const RawPlaybookSchema = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  agent: RawAgentSchema.optional(),
  defaults: RawPlaybookDefaultsSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  isolation: RawIsolationSchema.optional(),
  inputs: z.record(z.string(), RawInputDefSchema.nullable()).optional(),
  outputs: z.record(z.string(), RawOutputDefSchema.nullable()).optional(),
  outcomes: z.array(z.string().min(1)).min(1).optional(),
  concurrency: z.number().int().positive().optional(),
  steps: z.array(RawStepSchema).min(1),
  after: z.array(RawAfterSchema).optional(),
  /** paseo keys accepted for compatibility, not part of the v1 IR. */
  hidden: z.boolean().optional(),
  manager: z.object({ prompt: z.string().optional(), compact: z.unknown().optional() }).optional(),
  workspace: z.object({ archive: z.enum(["never", "on_end"]).optional(), keep_failed: z.boolean().optional() }).optional(),
  next: z.unknown().optional(),
  singleton: z.unknown().optional(),
});
export type RawPlaybook = z.infer<typeof RawPlaybookSchema>;

/**
 * Locate the step id an issue refers to, for errors that must name the step. Covers both main
 * steps (`steps[n]`) and after-task steps (`after[n].steps[m]`) — FR1.5.
 */
export function stepIdAtPath(document: unknown, path: readonly PropertyKey[]): string | undefined {
  const root = (document ?? {}) as { steps?: unknown; after?: unknown };
  const at = (value: unknown, index: PropertyKey | undefined): unknown =>
    Array.isArray(value) && typeof index === "number" ? value[index] : undefined;
  let step: unknown;
  if (path[0] === "steps") {
    step = at(root.steps, path[1]);
  } else if (path[0] === "after" && path[2] === "steps") {
    const after = at(root.after, path[1]) as { steps?: unknown } | undefined;
    step = at(after?.steps, path[3]);
  }
  const id = (step as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}
