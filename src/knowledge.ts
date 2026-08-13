/**
 * Per-application error knowledge.
 *
 * Business outcomes and recovery rules cannot be learned from a successful discovery run,
 * because a happy path never encounters them. Pretending otherwise is how you end up with
 * capabilities that work in the demo and fall over the first time a member id is mistyped.
 *
 * So they are authored once per application, not once per capability, and attached by the
 * recorder. That matches how the real environment works too: "record not found", "session
 * expired" and "not authorized" are properties of the vendor product, shared by every
 * capability against it, and shared across the hundreds of tenants running it.
 *
 * In production this file is a small reviewed artifact per product, maintained alongside the
 * capabilities rather than inside them.
 */

import type { BusinessOutcomeRule, RecoveryRule, TenantOverlay } from "./domain/artifact.js";

export const CU_BUSINESS_OUTCOMES: BusinessOutcomeRule[] = [
  {
    code: "MEMBER_NOT_FOUND",
    description: "No member exists with the supplied ID. A legitimate answer, not a failure.",
    detect: {
      kind: "text-present",
      value: "No member found with ID",
      timeoutMs: 1500,
      description: "Search page shows a not-found message",
    },
    terminal: true,
  },
  {
    code: "PERMISSION_DENIED",
    description: "The record is restricted and this operator may not view it.",
    detect: {
      kind: "text-present",
      value: "do not have permission",
      timeoutMs: 1500,
      description: "Authorization error is displayed",
    },
    terminal: true,
  },
  {
    code: "VALIDATION_ERROR",
    description: "The application rejected the supplied input.",
    detect: {
      kind: "text-present",
      value: "must be numeric",
      timeoutMs: 1500,
      description: "Field validation message is displayed",
    },
    terminal: true,
  },
  {
    code: "SESSION_EXPIRED",
    description:
      "The session timed out. Terminal for this run: re-authentication is the caller's concern, " +
      "not something automation should attempt with stored credentials.",
    detect: {
      kind: "text-present",
      value: "session has timed out",
      timeoutMs: 1500,
      description: "Session expiry page is displayed",
    },
    terminal: true,
  },
];

export const CU_RECOVERIES: RecoveryRule[] = [
  {
    code: "DISMISS_MAINTENANCE_NOTICE",
    description: "A scheduled-maintenance interstitial appears over the member profile.",
    detect: {
      kind: "text-present",
      value: "Scheduled maintenance tonight",
      timeoutMs: 1500,
      description: "Maintenance notice is present",
    },
    remedy: {
      kind: "reload",
    },
    maxAttempts: 2,
  },
  {
    code: "TRANSIENT_SLOW_LOAD",
    description: "The page is taking unusually long. Wait once before treating it as a failure.",
    detect: {
      kind: "text-present",
      value: "Application Error",
      timeoutMs: 1000,
      description: "Generic application error, which is sometimes transient",
    },
    remedy: { kind: "wait", ms: 1500 },
    maxAttempts: 1,
  },
];

/**
 * Two tenants running the same vendor product.
 *
 * The only real differences are branding and one relabelled field: Riverbend calls it
 * "Member ID", Summitline calls it "Member Number". That is precisely the class of drift
 * an overlay should absorb, and the reason the base descriptor uses a substring-tolerant
 * fallback rather than requiring an exact label match everywhere.
 */
export function cuTenantOverlays(basePort: number): TenantOverlay[] {
  return [
    {
      tenantId: "summitline",
      baseUrl: `http://localhost:${basePort}/?tenant=summitline`,
      descriptorOverrides: {},
      note:
        "Same vendor product, different branding. The member-id field is labelled 'Member Number' " +
        "here; the base descriptor's contains-match fallback covers it, so no override is needed. " +
        "If the label diverged further, the override would go here rather than in a new artifact.",
    },
  ];
}
