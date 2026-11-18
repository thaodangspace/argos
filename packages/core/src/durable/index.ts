/**
 * Durable host surface (`@thaodangspace/argos-core/durable`).
 *
 * This subpath is deliberately separate from the package root: importing it is the only way to
 * pull `@earendil-works/*` and the SQLite writer into a process. The CLI and Paseo plugin talk
 * HTTP and must never import it (FR3, Phase 9 import-graph rule).
 */

export * from "./context.js";
export * from "./mirror.js";
export * from "./host.js";
export * from "./ulid.js";
// Database maintenance surface: the host's methods `argos db` calls. The helpers in `db.ts`
// (queries, purge selection) stay internal, so the runtime export surface is unchanged.
export type {
  DbDocumentKind,
  DbFileSizes,
  DbPurgeOptions,
  DbPurgeResult,
  DbPurgeSkipped,
  DbPurgedRun,
  DbStats,
  DbTaskKind,
  DbVacuumResult,
} from "./db.js";
// Named exports only: `plannedAfterTasks` is an internal helper of the run task, not surface.
export { afterPlaybookIR, planAfterRun, type PlannedAfterRun } from "./tasks/after.js";
export * from "./tasks/gate.js";
export * from "./tasks/run.js";
export * from "./tasks/script.js";
export * from "./tasks/step.js";
