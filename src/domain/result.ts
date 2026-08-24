/**
 * The result contract.
 *
 * The brief names the central design mistake explicitly: conflating an expected business
 * outcome with a failure. "No such member" is an answer the caller needs; treating it as an
 * exception makes the capability unusable, because now the caller has to parse error strings
 * to find out whether the system broke or the member simply does not exist.
 *
 * So the return type has four arms: three terminal execution results and a non-terminal
 * handoff state. They mean genuinely different things to a caller:
 *
 *   ok        - the capability did what it says, here are the typed outputs.
 *   outcome   - the capability ran correctly and the answer is a declared non-success state.
 *               The caller should branch on `code`. Nothing is broken.
 *   failed    - something went wrong that the caller cannot act on programmatically.
 *               Carries enough detail to debug: which step, what was expected, what was seen.
 *
 * `escalated` is a fourth arm rather than a failure because a run that is waiting on a human
 * is not finished and is not broken. Collapsing it into `failed` would lose the distinction
 * between "this needs a person" and "this is wrong".
 */

import type { Risk } from "./artifact.js";

export interface CurrencyValue {
  amount: number;
  currency: string;
  display: string;
}

export type OutputValue = string | number | boolean | CurrencyValue;

export type FailureClass =
  /** The target application could not be reached at all. */
  | "target_unreachable"
  /** The control we needed was not there, and no fallback matched. */
  | "target_not_found"
  /** We acted, but the checkpoint said we did not end up where we expected. */
  | "checkpoint_failed"
  /** A recoverable condition was detected but recovery ran out of attempts. */
  | "recovery_exhausted"
  /** Policy refused the action (allowlist, risk class, missing approval). */
  | "policy_denied"
  /** Inputs did not satisfy the declared contract. Caught before touching the browser. */
  | "invalid_input"
  /** The surface itself errored after contact: page crashed or the browser session died. */
  | "surface_error"
  /** Global budget exceeded. */
  | "timeout"
  /** Anything not otherwise classified. Should be rare; treat growth here as a bug. */
  | "internal_error";

export interface StepTrace {
  stepId: string;
  action: string;
  risk: Risk;
  startedAt: string;
  durationMs: number;
  status: "ok" | "recovered" | "skipped" | "failed" | "human";
  /** Human-readable, already redacted. */
  detail?: string;
  recoveryCode?: string;
  /** Links a human-completed step to its intervention audit trail. */
  interventionId?: string;
}

export interface ReplayEvidence {
  runId: string;
  logPath: string;
  /** Populated on failure and on escalation. */
  screenshotPath?: string;
  observationPath?: string;
}

export interface OkResult {
  status: "ok";
  capability: string;
  revision: number;
  outputs: Record<string, OutputValue>;
  trace: StepTrace[];
  evidence: ReplayEvidence;
  durationMs: number;
}

export interface OutcomeResult {
  status: "outcome";
  capability: string;
  revision: number;
  /** Declared in the artifact's businessOutcomes. The caller branches on this. */
  code: string;
  description: string;
  /** Outputs read before the outcome was hit, if any. */
  outputs: Record<string, OutputValue>;
  trace: StepTrace[];
  evidence: ReplayEvidence;
  durationMs: number;
}

export interface FailedResult {
  status: "failed";
  capability: string;
  revision: number;
  failure: FailureClass;
  /** Which step. Null when the failure happened before or after the step loop. */
  stepId: string | null;
  expected: string;
  observed: string;
  message: string;
  /** Present when a human handoff was attempted before the terminal failure. */
  interventionId?: string;
  trace: StepTrace[];
  evidence: ReplayEvidence;
  durationMs: number;
}

export interface EscalatedResult {
  status: "escalated";
  capability: string;
  revision: number;
  interventionId: string;
  reason: string;
  stepId: string | null;
  /** How the operator reaches the live session. */
  handoffUrl: string;
  /** Pending when returned immediately; abandoned when the bounded wait elapsed. */
  resolution?: "pending" | "abandoned";
  trace: StepTrace[];
  evidence: ReplayEvidence;
  durationMs: number;
}

export type ReplayResult = OkResult | OutcomeResult | FailedResult | EscalatedResult;

export function isOk(r: ReplayResult): r is OkResult {
  return r.status === "ok";
}

/** A one-line summary suitable for a CLI or a calling agent's log. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case "ok":
      return `ok  ${r.capability}@${r.revision}  outputs=${JSON.stringify(r.outputs)}  ${r.durationMs}ms`;
    case "outcome":
      return `outcome  ${r.capability}@${r.revision}  code=${r.code}  (${r.description})  ${r.durationMs}ms`;
    case "failed":
      return `FAILED  ${r.capability}@${r.revision}  ${r.failure} at step=${r.stepId ?? "-"}\n  expected: ${r.expected}\n  observed: ${r.observed}`;
    case "escalated":
      return `escalated  ${r.capability}@${r.revision}  intervention=${r.interventionId}  ${r.reason}\n  operator: ${r.handoffUrl}`;
  }
}
