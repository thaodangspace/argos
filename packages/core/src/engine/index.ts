/**
 * Public engine surface (Phase 3). Phase 4/5 import from here, never from the module files
 * directly, so the reducer contract stays one stable entry point.
 */
export {
  createRunRecord,
  hydrateRunRecord,
  InvalidRunRecordError,
  invariantIssues,
  isTerminalRunStatus,
  isTerminalStepStatus,
  RUN_STATUSES,
  RunRecordSchema,
  STEP_STATUSES,
  stepDefinition,
  stepDefinitions,
  type AttemptOutcome,
  type AttemptRecord,
  type CreateRunRecordInput,
  type GateChoiceRecord,
  type GateComment,
  type GateKind,
  type GateRecord,
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type StepStatus,
  type WorktreeRecord,
} from "./record.js";
export { evaluateWhen, isEmpty, matches, readCondition, readySteps, type ReadySet } from "./ready.js";
export {
  edgeKey,
  loopGateId,
  loopGateQuestion,
  loopUsage,
  LOOP_GATE_CHOICES,
  parseEdgeKey,
  type LoopUsage,
} from "./loops.js";
export {
  DEFAULT_STEP_TIMEOUT_MS,
  resolveTimeoutValue,
  retryBackoffMs,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  runDeadlineReached,
  stepTimeoutMs,
  timedOutAttempts,
  type TimedOutAttempt,
} from "./timeouts.js";
export {
  next,
  type Effect,
  type EngineEvent,
  type NextResult,
} from "./reducer.js";
export {
  decideGate,
  type GateDecisionPlan,
  type GateDecisionRejection,
  type GateDecisionRequest,
} from "./decide.js";
