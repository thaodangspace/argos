/**
 * Provider/model catalog resolution (FR24).
 *
 * At start, every target a playbook could launch (`step > role > playbook > defaults`, then the
 * role's ordered `fallback`s) is validated against `providers.snapshot()`. A single unknown
 * `provider/model` refuses the run with `model_unavailable` **before any task is created**.
 *
 * The catalog is also the runtime helper for quota exhaustion (FR24):
 * `isTargetExhausted` implements the "skip for a configurable window" rule, and
 * `availableTargets` returns the ordered candidate list a step may still use.
 *
 * `ArgosHost` takes an injected {@link TargetCatalog}; the host itself never talks to Paseo, so
 * the Phase 4 durability tests (which use a fake executor) keep working unchanged.
 */

import type { ExhaustedRecord } from "../engine/index.js";
import type { AgentSettingsIR, PlaybookIR, Scalar, StepIR } from "../playbook/ir.js";
import type { PaseoPort, ProviderCatalog } from "./port.js";

/** Default quota-exhaustion window (FR24): 15 minutes. */
export const DEFAULT_EXHAUSTED_WINDOW_MS = 15 * 60_000;

/**
 * The host-facing check. Implemented by {@link ModelCatalog}; a test can pass a tiny object
 * instead. Unknown targets must be returned (not thrown) so the host can name all of them in one
 * `model_unavailable` error.
 */
export interface TargetCatalog {
  /** Every resolved target of the playbook (main graph and after-tasks) that is not in the catalog. */
  missingTargets(ir: PlaybookIR, inputs?: Readonly<Record<string, Scalar>>): readonly string[];
  /** Optional read-only snapshot for `GET /info` / `argos doctor` when no Paseo probe is wired. */
  snapshot?(): ModelCatalogSnapshot;
}

/** One provider entry in the `argos doctor` snapshot. */
export interface CatalogProviderSnapshot {
  readonly provider: string;
  readonly enabled: boolean;
  readonly models: readonly string[];
  readonly error?: string;
}

/** Stable, JSON-safe shape for `argos doctor` and tests. */
export interface ModelCatalogSnapshot {
  readonly generatedAt: number;
  readonly providers: readonly CatalogProviderSnapshot[];
  /** Every canonical `provider/model`, sorted (aliases are accepted but not listed). */
  readonly targets: readonly string[];
}

/** `provider/model` for one resolved agent block. */
export function targetOf(agent: Pick<AgentSettingsIR, "provider" | "model">): string {
  return `${agent.provider}/${agent.model}`;
}

/** The ordered candidates of one step: its resolved agent first, then role fallbacks (FR24). */
export function resolveStepTargets(step: StepIR): string[] {
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

function stepTargets(step: StepIR, inputs: Readonly<Record<string, Scalar>> | undefined): string[] {
  return resolveStepTargets(step).map((target) => renderTarget(target, inputs));
}

/** True while `target` is inside its quota-exhaustion window (FR24). */
export function isTargetExhausted(
  target: string,
  exhausted: readonly ExhaustedRecord[],
  now: number,
  windowMs: number = DEFAULT_EXHAUSTED_WINDOW_MS,
): boolean {
  const entry = exhausted.find((candidate) => candidate.target === target);
  if (entry === undefined) return false;
  return now >= entry.at && now - entry.at < windowMs;
}

export interface ModelCatalogOptions {
  /** Clock for `snapshot().generatedAt` when the catalog has no `fetchedAt`. */
  readonly now?: () => number;
  /** Quota window used by `availableTargets`; default 15 minutes. */
  readonly exhaustedWindowMs?: number;
}

/**
 * An immutable catalog built from one `providers.snapshot()`. Aliases are accepted by `has()`
 * but only canonical targets are listed, so `model_unavailable` never suggests an alias.
 */
export class ModelCatalog implements TargetCatalog {
  readonly #targets: ReadonlySet<string>;
  readonly #canonical: readonly string[];
  readonly #providers: readonly CatalogProviderSnapshot[];
  readonly #generatedAt: number;
  readonly #exhaustedWindowMs: number;

  private constructor(
    targets: ReadonlySet<string>,
    canonical: readonly string[],
    providers: readonly CatalogProviderSnapshot[],
    generatedAt: number,
    exhaustedWindowMs: number,
  ) {
    this.#targets = targets;
    this.#canonical = canonical;
    this.#providers = providers;
    this.#generatedAt = generatedAt;
    this.#exhaustedWindowMs = exhaustedWindowMs;
  }

  /** Load the catalog from a port (`providers.snapshot()`), lazily at `argos serve` start. */
  static async load(port: PaseoPort, options: ModelCatalogOptions = {}): Promise<ModelCatalog> {
    const catalog = await port.providersSnapshot();
    return ModelCatalog.fromSnapshot(catalog, options);
  }

  static fromSnapshot(
    catalog: ProviderCatalog,
    options: ModelCatalogOptions = {},
  ): ModelCatalog {
    const targets = new Set<string>();
    const canonical = new Set<string>();
    const providers: CatalogProviderSnapshot[] = [];
    for (const entry of catalog.providers) {
      const models: string[] = [];
      for (const model of entry.models) {
        if (model.selectable === false) continue;
        const target = `${entry.provider}/${model.id}`;
        models.push(target);
        targets.add(target);
        canonical.add(target);
        for (const alias of model.aliases ?? []) {
          targets.add(`${entry.provider}/${alias}`);
        }
      }
      models.sort();
      providers.push({
        provider: entry.provider,
        enabled: entry.enabled,
        models,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      });
    }
    providers.sort((left, right) => left.provider.localeCompare(right.provider));
    const generatedAt = catalog.fetchedAt ?? options.now?.() ?? 0;
    return new ModelCatalog(
      targets,
      [...canonical].sort(),
      providers,
      generatedAt,
      options.exhaustedWindowMs ?? DEFAULT_EXHAUSTED_WINDOW_MS,
    );
  }

  /** Is this exact `provider/model` (or one of its aliases) in the catalog? */
  has(target: string): boolean {
    return this.#targets.has(target);
  }

  /** Every canonical target, for diagnostics and error messages. */
  get targets(): readonly string[] {
    return this.#canonical;
  }

  /** Ordered candidates of a step, filtered by quota exhaustion (FR24). */
  availableTargets(
    step: StepIR,
    exhausted: readonly ExhaustedRecord[],
    now: number,
  ): string[] {
    return resolveStepTargets(step).filter(
      (target) => !isTargetExhausted(target, exhausted, now, this.#exhaustedWindowMs),
    );
  }

  missingTargets(
    ir: PlaybookIR,
    inputs?: Readonly<Record<string, Scalar>>,
  ): readonly string[] {
    const missing = new Set<string>();
    const steps: StepIR[] = [...ir.steps, ...ir.after.flatMap((after) => after.steps)];
    for (const step of steps) {
      for (const target of stepTargets(step, inputs)) {
        if (!this.has(target)) missing.add(target);
      }
    }
    return [...missing].sort();
  }

  snapshot(): ModelCatalogSnapshot {
    return {
      generatedAt: this.#generatedAt,
      providers: this.#providers,
      targets: this.targets,
    };
  }
}
