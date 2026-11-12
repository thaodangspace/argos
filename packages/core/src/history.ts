/**
 * The history event vocabulary shared by the durable writer and the read model.
 *
 * It lives outside `durable/` for one reason: `rpc/contracts.ts` (imported by the CLI and the
 * Paseo plugin) may validate the projected history without dragging pi-durable in. Nothing here
 * imports anything, so both sides can use it. Adding an event means adding it here once.
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
] as const;

export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];
