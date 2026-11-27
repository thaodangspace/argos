/**
 * The `hc` (herdr-core) target catalog (FR18).
 *
 * A playbook targets hc exactly the way it targets Paseo — `agent: { provider: hc, model:
 * <template-name> }` — so the canonical target is `hc/<template>` and every existing surface
 * (`model_unavailable` at start, `StepRecord.attempts[].target`, the UI's target column) works
 * with no new IR field and no new config file. The catalog itself is `templates.list`: a template
 * the core does not offer is refused before any task exists, by the same host check that refuses an
 * off-catalog `provider/model`, so there is no second code path (FR18).
 *
 * The class structurally satisfies `TargetCatalog` (`src/paseo/model-catalog.ts`) without importing
 * it: the two adapters stay independent (`test/hc/isolation.test.ts`), and the host only ever needs
 * `missingTargets` from a catalog.
 */

import type { AgentSettingsIR, PlaybookIR, Scalar, StepIR } from "../playbook/ir.js";
import type { HcPort, HcTemplate } from "./port.js";

/** The canonical provider id (FR18). `herdr`/`herdr-core` are accepted as aliases (FR1's family). */
export const HC_PROVIDER = "hc";

/** Providers that mean herdr-core when they appear in a resolved agent target. */
const HC_PROVIDERS: ReadonlySet<string> = new Set<string>([HC_PROVIDER, "herdr", "herdr-core"]);

/**
 * The canonical `hc/<template>` target for one resolved `provider/model`, or `undefined` when the
 * target belongs to another substrate. Non-hc targets are ignored everywhere (FR18): one run uses
 * one substrate, and a step's Paseo fallbacks are not this catalog's business.
 */
export function hcTargetOf(target: string): string | undefined {
  const slash = target.indexOf("/");
  if (slash < 0) return undefined;
  const provider = target.slice(0, slash).trim().toLowerCase();
  const template = target.slice(slash + 1).trim();
  if (!HC_PROVIDERS.has(provider) || template.length === 0) return undefined;
  return `${HC_PROVIDER}/${template}`;
}

/** The paired `provider/model` of one resolved agent block. */
function targetOf(agent: Pick<AgentSettingsIR, "provider" | "model">): string {
  return `${agent.provider}/${agent.model}`;
}

/**
 * The ordered candidates of one step: its resolved agent first, then role fallbacks. The same rule
 * as `resolveStepTargets` in `src/paseo/model-catalog.ts`, duplicated on purpose so this adapter
 * never imports the Paseo one.
 */
function resolveStepTargets(step: StepIR): string[] {
  const targets: string[] = [];
  const primary = step.agent ?? step.role?.agent;
  if (primary !== undefined) targets.push(targetOf(primary));
  for (const fallback of step.fallbacks ?? []) targets.push(targetOf(fallback));
  for (const fallback of step.role?.fallbacks ?? []) targets.push(targetOf(fallback));
  return [...new Set(targets)];
}

/** Render a whole-value `{{ inputs.name }}` / `{{ playbook.inputs.name }}` in an agent target. */
function renderTarget(value: string, inputs: Readonly<Record<string, Scalar>> | undefined): string {
  if (inputs === undefined) return value;
  return value.replace(
    /\{\{\s*(?:playbook\.)?inputs\.([A-Za-z0-9_-]+)\s*\}\}/g,
    (match, name: string) => {
      const resolved = inputs[name];
      return resolved === undefined ? match : String(resolved);
    },
  );
}

/**
 * The `hc/<template>` targets a core offers, built from one `templates.list`. A template whose
 * entry carries an `error` is not usable and is therefore absent, exactly like a provider model
 * that is not selectable in `ModelCatalog`.
 */
export class HcCatalog {
  readonly #targets: ReadonlySet<string>;
  readonly #canonical: readonly string[];

  private constructor(targets: ReadonlySet<string>, canonical: readonly string[]) {
    this.#targets = targets;
    this.#canonical = canonical;
  }

  /** Build the catalog from a `templates.list` response. */
  static fromTemplates(templates: readonly HcTemplate[]): HcCatalog {
    const targets = new Set<string>();
    for (const template of templates) {
      if (template.error !== null) continue;
      const name = template.name.trim();
      if (name.length === 0) continue;
      targets.add(`${HC_PROVIDER}/${name}`);
    }
    return new HcCatalog(targets, [...targets].sort());
  }

  /** Load the catalog from a port (`templates.list`), lazily at `argos serve` start (FR9). */
  static async load(port: HcPort): Promise<HcCatalog> {
    return HcCatalog.fromTemplates(await port.templatesList());
  }

  /** Is this `hc/<template>` target (or an alias provider spelling) in the catalog? */
  has(target: string): boolean {
    const canonical = hcTargetOf(target);
    return canonical !== undefined && this.#targets.has(canonical);
  }

  /** Every canonical `hc/<template>`, sorted, for diagnostics and error messages. */
  get targets(): readonly string[] {
    return this.#canonical;
  }

  /**
   * Every hc target of the playbook (main graph and after-tasks) that the core does not offer.
   * Steps whose resolved agent is another substrate are ignored, so a Paseo playbook run on the
   * `hc` executor fails inside its first step (`model_unavailable` from the executor) rather than
   * advertising a false catalog problem here.
   */
  missingTargets(
    ir: PlaybookIR,
    inputs?: Readonly<Record<string, Scalar>>,
  ): readonly string[] {
    const missing = new Set<string>();
    const steps: StepIR[] = [...ir.steps, ...ir.after.flatMap((after) => after.steps)];
    for (const step of steps) {
      for (const target of resolveStepTargets(step)) {
        const canonical = hcTargetOf(renderTarget(target, inputs));
        if (canonical !== undefined && !this.#targets.has(canonical)) missing.add(canonical);
      }
    }
    return [...missing].sort();
  }
}
