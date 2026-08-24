/**
 * The capability artifact.
 *
 * This is the focal point of the whole system, so the reasoning is written down here
 * rather than only in REPORT.md.
 *
 * Three properties drove the shape:
 *
 * 1. It is a CONTRACT, not a recording. A calling agent needs to know what the capability
 *    needs (typed inputs), what it returns (typed outputs), and how to tell whether it
 *    worked (checkpoints). A raw step list gives you none of that. So inputs/outputs are
 *    declared separately from steps, and steps reference inputs by name.
 *
 * 2. Targeting is SEMANTIC, not syntactic. A step never stores a CSS selector. It stores a
 *    description of the control as a human would identify it — role plus accessible name,
 *    with optional scoping context — plus lower-confidence fallbacks. This is what lets the
 *    same artifact survive a re-render, a different tenant's branding, and (in principle) a
 *    different surface technology entirely.
 *
 * 3. It is REVIEWABLE. Every step carries the model's stated reason from discovery. That
 *    field is never used at replay time; it exists so a human approving the capability can
 *    see why the step is there.
 *
 * Versioning: `schemaVersion` versions this format. `revision` versions the artifact's own
 * content, so a capability can be re-recorded or hand-edited with history.
 */

import { z } from "zod";
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "1.0.0" as const;

/* ------------------------------------------------------------------ targeting */

/**
 * How a control is identified.
 *
 * `role` + `name` is the primary strategy because it is what the accessibility tree
 * exposes, which is (a) what a human operator actually perceives, (b) present on legacy
 * server-rendered markup that has no test IDs, and (c) available on native desktop apps
 * through the platform accessibility APIs. That is the seam that makes this design
 * portable off the browser.
 *
 * `nameMatch` matters more than it looks. Enterprise apps rebrand labels per tenant
 * ("Member ID" vs "Member Number"), so exact matching would force a re-record per tenant.
 */
export const ElementDescriptorSchema = z.object({
  /** ARIA/accessibility role, e.g. "textbox", "button", "link", "cell". */
  role: z.string(),
  /** Accessible name, i.e. the label a human reads. */
  name: z.string().optional(),
  nameMatch: z.enum(["exact", "contains", "regex"]).default("exact"),
  /** Nth match when the name is genuinely ambiguous. Zero-based. Avoid if possible. */
  index: z.number().int().nonnegative().optional(),
  /** First-class relational targeting for legacy data grids. */
  tableCell: z.object({
    rowLabel: z.string(),
    columnLabel: z.string(),
    tableName: z.string().optional(),
  }).optional(),
  /** Discovery-time geometry; evidence and future coordinate fallback, never the primary locator. */
  recordedBounds: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  }).optional(),
  /**
   * Optional scoping: only look inside a container.
   *
   * `hasText` is the important half and exists because of a concrete problem: in a legacy
   * nested-table layout the outer <td> wrapping a grid is itself a `cell`, so "the cell
   * containing a dollar amount" matches the wrapper before the real one. Row content also
   * varies per record, so the row cannot be named — but it can be identified by something
   * stable inside it. `within: { role: "row", hasText: "SAVINGS" }` says "the savings row,
   * whichever member this is", which is what a human operator actually does.
   */
  within: z
    .object({
      role: z.string(),
      name: z.string().optional(),
      hasText: z.string().optional(),
    })
    .optional(),
  /** Frame to resolve in. Legacy apps use framesets, so this is not optional in practice. */
  frame: z
    .object({ strategy: z.enum(["main", "name", "url-contains"]), value: z.string().optional() })
    .default({ strategy: "main" }),
  /**
   * Ordered fallbacks, tried only if the primary fails. Each records why it is weaker,
   * so a reviewer can see the confidence ladder rather than a pile of equivalent selectors.
   */
  fallbacks: z
    .array(
      z.object({
        kind: z.enum(["role-name", "label", "placeholder", "text", "css", "xpath"]),
        value: z.string(),
        note: z.string().optional(),
      })
    )
    .default([]),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

/* ------------------------------------------------------------------ values */

/** A value is either a literal or a reference to a declared input parameter. */
export const ValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), param: z.string() }),
]);
export type Value = z.infer<typeof ValueSchema>;

/* ------------------------------------------------------------------ checkpoints */

/**
 * A checkpoint asserts we actually arrived somewhere, instead of assuming the click worked.
 * Every navigating step carries one. This is the single biggest source of determinism.
 */
export type Checkpoint = {
  kind: "element-visible" | "text-present" | "url-matches" | "element-absent" | "all-of";
  descriptor?: ElementDescriptor;
  value?: string;
  conditions?: Checkpoint[];
  timeoutMs: number;
  description: string;
};

// Input type is `unknown` rather than `Checkpoint`: fields with defaults (timeoutMs,
// nameMatch) are optional on the way in and present on the way out, so tying the input type
// to the output type would be a lie the compiler correctly rejects.
export const CheckpointSchema: z.ZodType<Checkpoint, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    kind: z.enum(["element-visible", "text-present", "url-matches", "element-absent", "all-of"]),
    /** Element checkpoints use a descriptor; text/url checkpoints use `value`. */
    descriptor: ElementDescriptorSchema.optional(),
    value: z.string().optional(),
    /**
     * For `all-of`. Conjunction exists because absence alone is not a signal.
     *
     * "There is no SAVINGS row" is true on the search page, on the login page, and on a blank
     * tab. An absence rule without a positive precondition matches everywhere, which is how a
     * detection rule quietly hijacks every unrelated failure. So a rule that asserts something
     * is missing must also assert where it is missing from.
     */
    conditions: z.array(CheckpointSchema).optional(),
    timeoutMs: z.number().int().positive().default(10_000),
    description: z.string(),
  })
);

/* ------------------------------------------------------------------ steps */

export const ActionKind = z.enum(["navigate", "click", "type", "press", "read", "wait_for"]);
export type ActionKind = z.infer<typeof ActionKind>;

/**
 * Risk classification lives on the step, not inferred at run time.
 *
 * Deciding this at record time and freezing it into the artifact means the policy engine
 * has something reviewable to enforce, and a human approving the capability can see
 * exactly which steps are irreversible before it ever runs unattended.
 */
export const RiskSchema = z.enum(["safe", "elevated", "irreversible"]);
export type Risk = z.infer<typeof RiskSchema>;

const StepBaseSchema = z.object({
  id: z.string(),
  risk: RiskSchema.default("safe"),
  /** Asserted after the action. Absent means the action is not expected to change state. */
  checkpoint: CheckpointSchema.optional(),
  /** Discovery-time rationale. Never consulted at replay. For human review only. */
  discoveredBecause: z.string().optional(),
  /** If true, replay tolerates this step not matching (used for optional interstitials). */
  optional: z.boolean().default(false),
});

/** Invalid action shapes are rejected while parsing, not midway through replay. */
export const StepSchema = z.discriminatedUnion("action", [
  StepBaseSchema.extend({ action: z.literal("navigate"), target: z.undefined().optional(), value: ValueSchema, outputKey: z.undefined().optional() }),
  StepBaseSchema.extend({ action: z.literal("click"), target: ElementDescriptorSchema, value: z.undefined().optional(), outputKey: z.undefined().optional() }),
  StepBaseSchema.extend({ action: z.literal("type"), target: ElementDescriptorSchema, value: ValueSchema, outputKey: z.undefined().optional() }),
  StepBaseSchema.extend({ action: z.literal("press"), target: z.undefined().optional(), value: ValueSchema, outputKey: z.undefined().optional() }),
  StepBaseSchema.extend({ action: z.literal("read"), target: ElementDescriptorSchema, value: z.undefined().optional(), outputKey: z.string() }),
  StepBaseSchema.extend({ action: z.literal("wait_for"), target: z.undefined().optional(), value: z.undefined().optional(), outputKey: z.undefined().optional(), checkpoint: CheckpointSchema }),
]);
export type Step = z.infer<typeof StepSchema>;

/* ------------------------------------------------------------------ io contract */

const ParamTypeSchema = z.enum(["string", "number", "boolean", "currency"]);

export const InputParamSchema = z.object({
  name: z.string(),
  type: ParamTypeSchema,
  required: z.boolean().default(true),
  description: z.string(),
  /** Marks a parameter whose value must never be written to logs or evidence. */
  sensitive: z.boolean().default(false),
  /** Optional validation, applied before any browser work happens. */
  pattern: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string(),
  type: ParamTypeSchema,
  description: z.string(),
  sensitive: z.boolean().default(false),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

/* ------------------------------------------------------------------ business outcomes */

/**
 * Declared, expected, non-success endings.
 *
 * The brief calls conflating these with failures "the most common design mistake here", so
 * they are first-class in the schema rather than being inferred from an error string.
 * "No such member" is an answer the caller needs, not a crash.
 */
export const BusinessOutcomeRuleSchema = z.object({
  code: z.string(),
  description: z.string(),
  /** How to recognise it. Checked before treating a checkpoint miss as a failure. */
  detect: CheckpointSchema,
  /** Whether the caller should treat this as terminal for the run. Almost always true. */
  terminal: z.boolean().default(true),
});
export type BusinessOutcomeRule = z.infer<typeof BusinessOutcomeRuleSchema>;

/**
 * Recoverable conditions: things replay may fix itself and continue.
 * Bounded on purpose — `maxAttempts` stops a recovery loop becoming an infinite one.
 */
export const RecoveryRuleSchema = z.object({
  code: z.string(),
  description: z.string(),
  detect: CheckpointSchema,
  remedy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("click"), target: ElementDescriptorSchema }),
    z.object({ kind: z.literal("reload") }),
    z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }),
  ]),
  maxAttempts: z.number().int().positive().default(2),
});
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

/* ------------------------------------------------------------------ tenant overlays */

/**
 * Cross-tenant reuse.
 *
 * Hundreds of tenants run the same vendor product with different branding. Re-recording
 * per tenant does not scale. So the artifact holds one base flow plus small, explicit,
 * reviewable overlays: usually a relabelled control or a different entry URL.
 *
 * Anything an overlay cannot express is a genuinely different flow and should be a
 * different artifact. Keeping overlays deliberately weak is the point — it forces drift
 * to be visible rather than absorbed into a pile of conditionals.
 */
export const TenantOverlaySchema = z.object({
  tenantId: z.string(),
  baseUrl: z.string().optional(),
  /** stepId -> partial descriptor overrides (usually just a different `name`). */
  descriptorOverrides: z.record(z.string(), ElementDescriptorSchema.partial()).default({}),
  note: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;

/* ------------------------------------------------------------------ the artifact */

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Stable machine name an agent invokes, e.g. "member.read_savings_balance". */
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  revision: z.number().int().positive(),
  title: z.string(),
  description: z.string(),

  /** Which app this belongs to, so overlays and drift are scoped to a product, not a URL. */
  application: z.object({
    productId: z.string(),
    vendor: z.string().default("Acme Financial Systems (synthetic)"),
    product: z.string().default("Core Banking Console"),
    versionRange: z.string().default(">=7 <8"),
    surface: z.enum(["web", "legacy-web", "desktop"]),
    baseUrl: z.string().optional(),
  }),

  /** The policy in force when the capability was recorded, for review and provenance. */
  policySnapshot: z.object({
    allowedHosts: z.array(z.string()),
    allowedPathPrefixes: z.array(z.string()),
    allowedActions: z.array(ActionKind),
    irreversiblePolicy: z.enum(["allow", "escalate", "refuse"]),
  }).default({
    allowedHosts: ["localhost"],
    allowedPathPrefixes: ["/"],
    allowedActions: ["navigate", "click", "type", "press", "read", "wait_for"],
    irreversiblePolicy: "escalate",
  }),

  inputs: z.array(InputParamSchema).default([]),
  outputs: z.array(OutputFieldSchema).default([]),
  steps: z.array(StepSchema).min(1),

  /** Final assertion that the capability as a whole achieved its goal. */
  successCheckpoint: CheckpointSchema,

  businessOutcomes: z.array(BusinessOutcomeRuleSchema).default([]),
  recoveries: z.array(RecoveryRuleSchema).default([]),
  tenantOverlays: z.array(TenantOverlaySchema).default([]),

  /**
   * Approval gate. A capability is `draft` until a human reviews it. Unattended replay
   * of an `irreversible` step requires `approved`.
   */
  approval: z
    .object({
      state: z.enum(["draft", "approved", "revoked"]).default("draft"),
      reviewedBy: z.string().optional(),
      reviewedAt: z.string().optional(),
      note: z.string().optional(),
    })
    .default({ state: "draft" }),

  provenance: z.object({
    recordedAt: z.string(),
    goal: z.string(),
    model: z.string().optional(),
    discoveryRunId: z.string(),
    stepCount: z.number().int().nonnegative(),
    /** Deliberately NOT the raw transcript. See REPORT.md §2. */
    transcriptRef: z.string().optional(),
  }),
  artifactHash: z.string().optional(),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export function parseArtifact(raw: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(raw);
}

/** Hash the parsed executable contract, excluding the hash field itself. */
export function computeArtifactHash(raw: CapabilityArtifact): string {
  const parsed = CapabilityArtifactSchema.parse(raw);
  delete parsed.artifactHash;
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}
