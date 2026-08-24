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
    code: "NO_SAVINGS_ACCOUNT",
    description:
      "The member exists and is viewable, but holds no savings account. A legitimate answer to " +
      "'what is their savings balance', and the caller needs to be able to tell it apart from " +
      "'the automation could not find the field'.",
    // Conjunctive on purpose. "No SAVINGS row" on its own is also true of the search page,
    // the session-expired page and a blank tab, so without the positive precondition this
    // rule hijacks every unrelated failure. It did exactly that before it was scoped.
    detect: {
      kind: "all-of",
      conditions: [
        {
          kind: "text-present",
          value: "Member Profile",
          timeoutMs: 1500,
          description: "We are on a member profile",
        },
        {
          kind: "element-absent",
          descriptor: {
            role: "cell",
            name: "SAVINGS",
            nameMatch: "contains",
            frame: { strategy: "main" },
            fallbacks: [],
          },
          timeoutMs: 1500,
          description: "...and the accounts grid has no SAVINGS row",
        },
      ],
      timeoutMs: 1500,
      description: "On a member profile with no SAVINGS account",
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
 * an explicit overlay should absorb. The label change is reviewable rather than hidden
 * behind fuzzy matching.
 */
export function cuTenantOverlays(basePort: number): TenantOverlay[] {
  return [
    {
      tenantId: "summitline",
      baseUrl: `http://localhost:${basePort}/?tenant=summitline`,
      descriptorOverrides: {
        s1: {
          name: "Member Number",
          nameMatch: "exact",
          fallbacks: [
            { kind: "role-name", value: "Member Number", note: "tenant-specific accessible name" },
            { kind: "label", value: "Member Number", note: "tenant-specific label association" },
          ],
        },
      },
      note:
        "Same vendor product, different branding. The member-id field is labelled 'Member Number' " +
        "here, so step s1 receives an explicit descriptor override. The rest of the flow is shared.",
    },
  ];
}
