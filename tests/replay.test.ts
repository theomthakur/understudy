/**
 * Replay tests.
 *
 * These are the tests that matter most, because replay is the production path and the
 * evaluation weights robustness and error handling heavily.
 *
 * The artifact used here is hand-built rather than produced by a discovery run. That is
 * deliberate: these tests must be runnable with no model credentials and must not depend on
 * what a model happened to do on a given day. The recorder is tested separately for shape.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSurface } from "../src/surface/web-surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";
import { replay } from "../src/replay/replay.js";
import { EscalationBroker } from "../src/escalation/escalation.js";
import { EvidenceLog, newRunId } from "../src/evidence/logger.js";
import { Redactor } from "../src/policy/redact.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../src/domain/artifact.js";
import { CU_BUSINESS_OUTCOMES, CU_RECOVERIES } from "../src/knowledge.js";

const PORT = Number(process.env.TARGET_PORT ?? 4471);
const BASE = `http://localhost:${PORT}`;
const EVIDENCE_ROOT = "evidence/test-runs";

let surface: WebSurface;

before(async () => {
  surface = new WebSurface({ headless: true });
  await surface.start();
});

after(async () => {
  await surface?.close();
  await fetch(`${BASE}/__fault?kind=none`).catch(() => {});
});

/** The read-balance capability, as the recorder would produce it. */
function readBalanceArtifact(): CapabilityArtifact {
  return CapabilityArtifactSchema.parse({
    schemaVersion: "1.0.0",
    name: "member.read_savings_balance",
    revision: 1,
    title: "Read a member's savings balance",
    description: "Looks up a member and returns their savings balance.",
    application: { productId: "acme-core-banking", surface: "legacy-web", baseUrl: BASE },
    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        description: "Member ID",
        sensitive: false,
        pattern: "^\\d{3,10}$",
      },
    ],
    outputs: [
      { name: "savingsBalance", type: "number", description: "Savings balance", sensitive: false },
    ],
    steps: [
      {
        id: "s0",
        action: "navigate",
        value: { kind: "literal", value: BASE },
        risk: "safe",
        optional: false,
        checkpoint: {
          kind: "element-visible",
          descriptor: {
            role: "button",
            name: "Search",
            nameMatch: "exact",
            frame: { strategy: "main" },
            fallbacks: [],
          },
          timeoutMs: 8000,
          description: "Search page is loaded",
        },
      },
      {
        id: "s1",
        action: "type",
        target: {
          role: "textbox",
          name: "Member ID",
          nameMatch: "contains",
          frame: { strategy: "main" },
          fallbacks: [{ kind: "role-name", value: "Member", note: "relaxed to substring" }],
        },
        value: { kind: "param", param: "memberId" },
        risk: "safe",
        optional: false,
      },
      {
        id: "s2",
        action: "click",
        target: {
          role: "button",
          name: "Search",
          nameMatch: "exact",
          frame: { strategy: "main" },
          fallbacks: [{ kind: "text", value: "Search" }],
        },
        risk: "safe",
        optional: false,
        checkpoint: {
          kind: "element-visible",
          descriptor: {
            role: "heading",
            name: "Member Profile",
            nameMatch: "contains",
            frame: { strategy: "main" },
            fallbacks: [],
          },
          timeoutMs: 8000,
          description: "Member profile is showing",
        },
      },
      {
        id: "s3",
        action: "read",
        // The interesting targeting problem in this app. The accounts grid sits inside a
        // nested layout table, so "the cell containing a dollar amount" matches the outer
        // wrapper cell first. And the row cannot be addressed by name, because its name
        // includes the balance, which is the thing that varies per member.
        //
        // So: scope to the row that mentions SAVINGS, then take the cell that looks like
        // currency. That is what a human does, and it holds for any member.
        target: {
          role: "cell",
          name: "^\\$[0-9,.]+$",
          nameMatch: "regex",
          within: { role: "row", hasText: "SAVINGS" },
          frame: { strategy: "main" },
          fallbacks: [],
        },
        outputKey: "savingsBalance",
        risk: "safe",
        optional: false,
      },
    ],
    successCheckpoint: {
      kind: "text-present",
      value: "Member Profile",
      timeoutMs: 8000,
      description: "Reached the member profile",
    },
    businessOutcomes: CU_BUSINESS_OUTCOMES,
    recoveries: CU_RECOVERIES,
    tenantOverlays: [],
    approval: { state: "draft" },
    provenance: {
      recordedAt: new Date().toISOString(),
      goal: "read savings balance",
      discoveryRunId: "test-fixture",
      stepCount: 4,
    },
  });
}

function deps() {
  return {
    surface,
    policy: new PolicyEngine(DEFAULT_POLICY),
    evidenceRoot: EVIDENCE_ROOT,
  };
}

test("happy path: replays deterministically and returns a typed output", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(r.status, "ok", `expected ok, got ${r.status}: ${JSON.stringify(r)}`);
  if (r.status !== "ok") return;
  assert.equal(typeof r.outputs.savingsBalance, "number", "declared number output must be a number");
  assert.equal(r.outputs.savingsBalance, 8241.55);
});

test("same artifact, different input: no re-recording needed", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "22871" }, deps());
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.outputs.savingsBalance, 402.19, "parameterisation must actually vary the run");
});

test("replay is stable across repeated runs", async () => {
  const a = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  const b = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  if (a.status !== "ok" || b.status !== "ok") return;
  assert.deepEqual(a.outputs, b.outputs, "same inputs must produce the same outputs");
});

test("BUSINESS OUTCOME: unknown member is an answer, not a failure", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "99999" }, deps());
  assert.equal(r.status, "outcome", `expected a business outcome, got ${r.status}`);
  if (r.status !== "outcome") return;
  assert.equal(r.code, "MEMBER_NOT_FOUND");
});

test("BUSINESS OUTCOME: restricted record reports permission denied", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "30099" }, deps());
  assert.equal(r.status, "outcome");
  if (r.status !== "outcome") return;
  assert.equal(r.code, "PERMISSION_DENIED");
});

test("BUSINESS OUTCOME: session expiry is reported, not retried with credentials", async () => {
  await fetch(`${BASE}/__fault?kind=session&times=1`);
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(r.status, "outcome", `expected outcome, got ${r.status}`);
  if (r.status !== "outcome") return;
  assert.equal(r.code, "SESSION_EXPIRED");
});

test("RECOVERABLE: an unexpected interstitial is dismissed and the run continues", async () => {
  await fetch(`${BASE}/__fault?kind=interstitial&times=1`);
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(r.status, "ok", `expected recovery then success, got ${r.status}`);
});

test("INVALID INPUT: rejected before any browser work", async () => {
  const started = Date.now();
  const r = await replay(readBalanceArtifact(), { memberId: "not-a-number" }, deps());
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "invalid_input");
  assert.ok(Date.now() - started < 1500, "contract violations should not cost a page load");
});

test("INVALID INPUT: a missing required parameter is caught", async () => {
  const r = await replay(readBalanceArtifact(), {}, deps());
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "invalid_input");
  assert.match(r.message, /memberId/);
});

test("HARD FAILURE: a control that no longer exists reports expected vs observed", async () => {
  const artifact = readBalanceArtifact();
  artifact.steps[2]!.target = {
    role: "button",
    name: "Wire Funds",
    nameMatch: "exact",
    frame: { strategy: "main" },
    fallbacks: [],
  };
  const r = await replay(artifact, { memberId: "12345" }, deps());
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "target_not_found");
  assert.equal(r.stepId, "s2");
  assert.match(r.expected, /Wire Funds/, "failure must say what it was looking for");
  assert.ok(r.evidence.screenshotPath, "a hard failure must leave a screenshot");
});

test("POLICY: navigation off the allowlist is denied", async () => {
  const artifact = readBalanceArtifact();
  artifact.steps[0]!.value = { kind: "literal", value: "https://example.com/" };
  const r = await replay(artifact, { memberId: "12345" }, {
    ...deps(),
    policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
  });
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.match(r.message, /allowlist|Policy denied/i);
});

test("POLICY + ESCALATION: an irreversible step in an approved artifact routes to a human", async () => {
  const artifact = readBalanceArtifact();
  artifact.approval = { state: "approved", reviewedBy: "test" };
  artifact.steps.push({
    id: "s4",
    action: "click",
    target: {
      role: "button",
      name: "Open Sub-Account",
      nameMatch: "contains",
      frame: { strategy: "main" },
      fallbacks: [],
    },
    risk: "irreversible",
    optional: false,
  });

  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");

  const r = await replay(artifact, { memberId: "12345" }, { ...deps(), escalation: broker });

  assert.equal(r.status, "escalated", `expected escalation, got ${r.status}`);
  if (r.status !== "escalated") return;
  assert.equal(broker.controlHolder, "awaiting_human", "control must be ceded, not just logged");
  assert.equal(surface.isAutomationInControl(), false, "the surface must actually be paused");

  // Full round trip: a human claims, works, hands back.
  broker.claim(r.interventionId, "operator@test");
  assert.equal(broker.controlHolder, "human");
  const released = await broker.release(r.interventionId, "Opened the sub-account manually.");
  assert.equal(released.state, "released");
  assert.equal(broker.controlHolder, "automation");
  assert.equal(surface.isAutomationInControl(), true, "control must return to automation");
  assert.equal(released.operatorNote, "Opened the sub-account manually.");
});

test("POLICY: an unapproved irreversible step is refused outright, not escalated", async () => {
  const artifact = readBalanceArtifact();
  artifact.approval = { state: "draft" };
  artifact.steps.push({
    id: "s4",
    action: "click",
    target: {
      role: "button",
      name: "Open Sub-Account",
      nameMatch: "contains",
      frame: { strategy: "main" },
      fallbacks: [],
    },
    risk: "irreversible",
    optional: false,
  });

  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const r = await replay(artifact, { memberId: "12345" }, { ...deps(), escalation: broker });

  assert.equal(r.status, "failed", "review is the control; escalation is not a substitute");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "policy_denied");
  assert.match(r.message, /not been approved/);
});

test("TENANT REUSE: the same artifact runs against a second tenant of the same product", async () => {
  const artifact = readBalanceArtifact();
  artifact.tenantOverlays = [
    {
      tenantId: "summitline",
      baseUrl: `${BASE}/?tenant=summitline`,
      descriptorOverrides: {},
      note: "same vendor product, different branding",
    },
  ];
  const r = await replay(artifact, { memberId: "12345" }, { ...deps(), tenantId: "summitline" });
  assert.equal(r.status, "ok", `expected the base flow to work on tenant 2, got ${r.status}`);
});
