/**
 * Writes a hand-authored capability artifact so the replay path can be demonstrated
 * without model credentials.
 *
 * This is NOT a substitute for the discovery run. It is the same schema the recorder
 * emits, authored by hand, and provenance says so explicitly. Once a model key is
 * available, `npm run discover` overwrites it with a genuinely discovered artifact.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { CapabilityArtifactSchema } from "../src/domain/artifact.js";
import { CU_BUSINESS_OUTCOMES, CU_RECOVERIES, cuTenantOverlays } from "../src/knowledge.js";

const BASE = "http://localhost:4471";
const a = CapabilityArtifactSchema.parse({
  schemaVersion: "1.0.0",
  name: "member.read_savings_balance",
  revision: 1,
  title: "Read a member's savings balance",
  description: "Looks up a member by ID and returns the balance of their savings account.",
  application: { productId: "acme-core-banking", surface: "legacy-web", baseUrl: BASE },
  inputs: [{ name: "memberId", type: "string", required: true, description: "Member ID as shown in the console", sensitive: false, pattern: "^\\d{3,10}$" }],
  outputs: [{ name: "savingsBalance", type: "number", description: "Savings balance in dollars", sensitive: false }],
  steps: [
    { id: "s0", action: "navigate", value: { kind: "literal", value: BASE }, risk: "safe", optional: false,
      discoveredBecause: "Entry point for the flow",
      checkpoint: { kind: "element-visible", descriptor: { role: "button", name: "Search", nameMatch: "exact", frame: { strategy: "main" }, fallbacks: [] }, timeoutMs: 8000, description: "Search page is loaded" } },
    { id: "s1", action: "type",
      target: { role: "textbox", name: "Member ID", nameMatch: "contains", frame: { strategy: "main" },
        fallbacks: [{ kind: "role-name", value: "Member", note: "relaxed to substring — survives the per-tenant relabel to 'Member Number'" },
                    { kind: "label", value: "Member", note: "label association, if the accessible name is computed differently" }] },
      value: { kind: "param", param: "memberId" }, risk: "safe", optional: false,
      discoveredBecause: "Enter the member id into the search field" },
    { id: "s2", action: "click",
      target: { role: "button", name: "Search", nameMatch: "exact", frame: { strategy: "main" },
        fallbacks: [{ kind: "text", value: "Search", note: "visible text — last resort" }] },
      risk: "safe", optional: false, discoveredBecause: "Submit the search",
      checkpoint: { kind: "element-visible", descriptor: { role: "heading", name: "Member Profile", nameMatch: "contains", frame: { strategy: "main" }, fallbacks: [] }, timeoutMs: 8000, description: "Member profile is showing" } },
    { id: "s3", action: "read",
      target: { role: "cell", name: "^\\$[0-9,.]+$", nameMatch: "regex", within: { role: "row", hasText: "SAVINGS" }, frame: { strategy: "main" }, fallbacks: [] },
      outputKey: "savingsBalance", risk: "safe", optional: false,
      discoveredBecause: "Read the balance from the SAVINGS row of the accounts grid" },
  ],
  successCheckpoint: { kind: "text-present", value: "Member Profile", timeoutMs: 8000, description: "Reached the member profile" },
  businessOutcomes: CU_BUSINESS_OUTCOMES,
  recoveries: CU_RECOVERIES,
  tenantOverlays: cuTenantOverlays(4471),
  approval: { state: "draft" },
  provenance: { recordedAt: new Date().toISOString(), goal: "Look up a member and read their savings balance",
    discoveryRunId: "hand-authored-pending-discovery",
    model: "none — authored by hand so replay can be demonstrated without credentials",
    stepCount: 4 },
});
mkdirSync("capabilities", { recursive: true });
writeFileSync(`capabilities/${a.name}.json`, JSON.stringify(a, null, 2));
console.log(`wrote capabilities/${a.name}.json`);
