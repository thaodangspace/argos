/**
 * The history event vocabulary shared by the durable writer and the read model.
 *
 * It lives outside `durable/` for one reason: `rpc/contracts.ts` (imported by the CLI and the
 * Paseo plugin) may validate the projected history without dragging pi-durable in. Nothing here
 * imports anything, so both sides can use it.
 *
 * Adding an event means **two** edits: the list here (so the contract accepts it) and
 * `packages/paseo-plugin/shared/panel.ts`'s exhaustive `historyText`/`historyTone` switches, which
 * the compiler enforces — a new type without a label fails the plugin typecheck rather than
 * rendering as an empty log line.
 */
export const HISTORY_EVENT_TYPES = [
  "run_started",
  "select",
  "dispatch",
  "settle",
  "gate",
  "gate_decided",
  "finish",
  "effect_skipped",
  "task_error",
  "after_queued",
  "after_start",
  "retry",
  // FR3.4: `retryStep` re-pinned one script; `detail` holds `<name>: <from> -> <to>`.
  "script_repinned",
  // Fork: the first event of a forked run; `stepId` is the fork point and `detail` holds
  // `<parentRunId>@<stepId>` (the hashes live in `RunRecord.forkedFrom`).
  "forked_from",
] as const;

export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];
