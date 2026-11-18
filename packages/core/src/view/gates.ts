/**
 * Gate views (spec FR6, FR12): a pending gate's choices with their semantic tone, so a client only
 * has to map a tone onto its palette.
 */

import type { GateSummary } from "../rpc/contracts.js";
import type { StatusTone } from "./labels.js";

/** One choice button of a pending gate. */
export interface GateChoiceView {
  readonly id: string;
  readonly label: string;
  readonly comment: "none" | "optional" | "required";
  readonly tone: StatusTone;
}

export interface GateView {
  readonly key: string;
  readonly runId: string;
  readonly gateId: string;
  readonly stepId: string;
  readonly kind: GateSummary["kind"];
  readonly question: string;
  readonly status: GateSummary["status"];
  readonly choices: readonly GateChoiceView[];
  /** A decision for this gate is in flight: disable every button. */
  readonly deciding: boolean;
  readonly decision?: string;
}

export const CHOICE_TONES: Readonly<Record<string, StatusTone>> = {
  primary: "accent",
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "danger",
};

export function gateKey(runId: string, gateId: string): string {
  return `${runId}.${gateId}`;
}

function choiceTone(choice: GateSummary["choices"][string]): StatusTone {
  return choice.color === undefined ? "accent" : (CHOICE_TONES[choice.color] ?? "accent");
}

export function gateView(
  gate: GateSummary,
  options: { readonly deciding?: boolean } = {},
): GateView {
  return {
    key: gateKey(gate.runId, gate.gateId),
    runId: gate.runId,
    gateId: gate.gateId,
    stepId: gate.stepId,
    kind: gate.kind,
    question: gate.question,
    status: gate.status,
    choices: Object.entries(gate.choices).map(([id, choice]) => ({
      id,
      label: choice.label,
      comment: choice.comment,
      tone: choiceTone(choice),
    })),
    deciding: options.deciding === true,
    ...(gate.decision === undefined ? {} : { decision: gate.decision }),
  };
}
