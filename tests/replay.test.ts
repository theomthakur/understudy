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
import { readFile } from "node:fs/promises";
import { WebSurface } from "../src/surface/web-surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";
import { replay } from "../src/replay/replay.js";
import { EscalationBroker } from "../src/escalation/escalation.js";
import { EvidenceLog, newRunId } from "../src/evidence/logger.js";
import { Redactor } from "../src/policy/redact.js";
import { CapabilityArtifactSchema, computeArtifactHash, type CapabilityArtifact } from "../src/domain/artifact.js";
import { CU_BUSINESS_OUTCOMES, CU_RECOVERIES } from "../src/knowledge.js";

const PORT = Number(process.env.TARGET_PORT ?? 4471);
const BASE = `http://localhost:${PORT}`;
// Use the exact host the self-contained server binds. On macOS, `localhost` may
// resolve to IPv6 while 127.0.0.1 is not covered by that listener.
const CONTROL_BASE = BASE;
const EVIDENCE_ROOT = "evidence/test-runs";

let surface: WebSurface;

function approveArtifact(artifact: CapabilityArtifact): void {
  artifact.approval = { state: "approved", reviewedBy: "test", reviewedAt: new Date().toISOString() };
  artifact.artifactHash = computeArtifactHash(artifact);
}

before(async () => {
  surface = new WebSurface({ headless: true });
  await surface.start();
});

after(async () => {
  await surface?.close();
  await fetch(`${CONTROL_BASE}/__fault?kind=none`).catch(() => {});
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
        sensitive: true,
        pattern: "^\\d{3,10}$",
      },
    ],
    outputs: [
      { name: "savingsBalance", type: "currency", description: "Savings balance", sensitive: true },
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
          tableCell: { rowLabel: "SAVINGS", columnLabel: "Balance" },
          nameMatch: "exact",
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

function addSubAccountSteps(artifact: CapabilityArtifact, timeoutMs = 1_000): void {
  artifact.steps.push(
    {
      id: "s4",
      action: "click",
      target: targetDescriptor("button", "Open Sub-Account"),
      risk: "safe",
      optional: false,
      checkpoint: {
        kind: "text-present",
        value: "Confirm New Sub-Account",
        timeoutMs,
        description: "confirmation form is showing",
      },
    },
    {
      id: "s5",
      action: "type",
      target: targetDescriptor("textbox", "Sub-Account Nickname"),
      value: { kind: "literal", value: "Holiday Savings" },
      risk: "safe",
      optional: false,
    },
    {
      id: "s6",
      action: "click",
      target: targetDescriptor("button", "Confirm and Open"),
      risk: "irreversible",
      optional: false,
      checkpoint: {
        kind: "text-present",
        value: "Sub-Account Opened",
        timeoutMs,
        description: "application confirms the sub-account was opened",
      },
    }
  );
  artifact.successCheckpoint = {
    kind: "text-present",
    value: "Sub-Account Opened",
    timeoutMs,
    description: "sub-account opened",
  };
}

function targetDescriptor(role: string, name: string) {
  return {
    role,
    name,
    nameMatch: "contains" as const,
    frame: { strategy: "main" as const },
    fallbacks: [],
  };
}

async function waitForIntervention(broker: EscalationBroker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const intervention = broker.list().at(-1);
    if (intervention) return intervention;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("intervention was not raised in time");
}

function failureEscalationArtifact(): CapabilityArtifact {
  const artifact = CapabilityArtifactSchema.parse({
    schemaVersion: "1.0.0",
    name: "member.open_sub_account_from_search",
    revision: 1,
    title: "Open sub-account from search",
    description: "Test fixture for a target that becomes available after operator repair.",
    application: { productId: "acme-core-banking", surface: "legacy-web", baseUrl: BASE },
    inputs: [],
    outputs: [],
    steps: [
      {
        id: "s0", action: "navigate", value: { kind: "literal", value: BASE }, risk: "safe", optional: false,
        checkpoint: { kind: "text-present", value: "Member Search", timeoutMs: 500, description: "search page" },
      },
      {
        id: "s1", action: "click", target: targetDescriptor("button", "Open Sub-Account"), risk: "safe", optional: false,
        checkpoint: { kind: "text-present", value: "Confirm New Sub-Account", timeoutMs: 500, description: "confirmation page" },
      },
    ],
    successCheckpoint: { kind: "text-present", value: "Confirm New Sub-Account", timeoutMs: 500, description: "confirmation page" },
    approval: { state: "approved", reviewedBy: "test" },
    provenance: { recordedAt: new Date().toISOString(), goal: "test", discoveryRunId: "test", stepCount: 2 },
  });
  approveArtifact(artifact);
  return artifact;
}

test("happy path: replays deterministically and returns a typed output", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(r.status, "ok", `expected ok, got ${r.status}: ${JSON.stringify(r)}`);
  if (r.status !== "ok") return;
  assert.deepEqual(r.outputs.savingsBalance, { amount: 8241.55, currency: "USD", display: "$8,241.55" });
});

test("same artifact, different input: no re-recording needed", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "22871" }, deps());
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(
    r.outputs.savingsBalance,
    { amount: 402.19, currency: "USD", display: "$402.19" },
    "parameterisation must actually vary the run"
  );
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
  const started = Date.now();
  const r = await replay(readBalanceArtifact(), { memberId: "99999" }, deps());
  assert.equal(r.status, "outcome", `expected a business outcome, got ${r.status}`);
  if (r.status !== "outcome") return;
  assert.equal(r.code, "MEMBER_NOT_FOUND");
  assert.ok(Date.now() - started < 15_000, "single-shot outcome detection must not inherit act-path polling latency");
});

test("BUSINESS OUTCOME: a missing savings row bypasses the target polling budget", async () => {
  const started = Date.now();
  const r = await replay(readBalanceArtifact(), { memberId: "44120" }, deps());
  assert.equal(r.status, "outcome");
  if (r.status !== "outcome") return;
  assert.equal(r.code, "NO_SAVINGS_ACCOUNT");
  assert.ok(Date.now() - started < 6_000, "a visible business outcome should be returned before target polling");
});

test("BUSINESS OUTCOME: restricted record reports permission denied", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "30099" }, deps());
  assert.equal(r.status, "outcome");
  if (r.status !== "outcome") return;
  assert.equal(r.code, "PERMISSION_DENIED");
});

test("BUSINESS OUTCOME: session expiry is reported, not retried with credentials", async () => {
  await fetch(`${CONTROL_BASE}/__fault?kind=session&times=1`);
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, deps());
  assert.equal(r.status, "outcome", `expected outcome, got ${r.status}`);
  if (r.status !== "outcome") return;
  assert.equal(r.code, "SESSION_EXPIRED");
});

test("RECOVERABLE: an unexpected interstitial is dismissed and the run continues", async () => {
  await fetch(`${CONTROL_BASE}/__fault?kind=interstitial&times=1`);
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

test("INTEGRITY: replay refuses an approved artifact changed after review", async () => {
  const artifact = readBalanceArtifact();
  approveArtifact(artifact);
  artifact.title = "Tampered after approval";
  const r = await replay(artifact, { memberId: "12345" }, deps());
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "policy_denied");
  assert.match(r.message, /artifactHash check/);
});

test("DETERMINISM: act-path resolution polls through a transiently late control", async () => {
  await fetch(`${CONTROL_BASE}/__fault?kind=slow&times=1`);
  const artifact = readBalanceArtifact();
  artifact.steps[0]!.checkpoint = {
    kind: "text-present", value: "Member Search", timeoutMs: 500, description: "search page loaded",
  };
  const r = await replay(artifact, { memberId: "12345" }, deps());
  assert.equal(r.status, "ok");
  const events = await readFile(r.evidence.logPath, "utf8");
  assert.match(events, /"event":"target.resolved_after_wait"/);
  assert.match(events, /"attempts":[2-9]/);
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

test("HARD FAILURE: an unreachable application is distinct from a broken surface", async () => {
  const artifact = readBalanceArtifact();
  artifact.steps[0]!.value = { kind: "literal", value: "http://localhost:65534/" };
  const r = await replay(artifact, { memberId: "12345" }, deps());
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "target_unreachable");
  assert.equal(r.stepId, "s0");
  assert.match(r.expected, /reachable/i);
  assert.match(r.observed, /CONNECTION_REFUSED|ECONNREFUSED/i);
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

test("POLICY + ESCALATION: a human acts, releases, and replay resumes to ok", async () => {
  const artifact = readBalanceArtifact();
  addSubAccountSteps(artifact);
  approveArtifact(artifact);

  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const replayPromise = replay(artifact, { memberId: "12345" }, {
    ...deps(), escalation: broker, handoffWaitMs: 5_000,
  });
  const intervention = await waitForIntervention(broker);
  assert.equal(broker.controlHolder, "awaiting_human", "control must be ceded, not just logged");
  assert.equal(surface.isAutomationInControl(), false, "the surface must actually be paused");

  // Full round trip: a human claims, works, hands back.
  broker.claim(intervention.id, "operator@test");
  assert.equal(broker.controlHolder, "human");
  await broker.humanAction(intervention.id, {
    kind: "click",
    target: {
      role: "button",
      name: "Confirm and Open",
      nameMatch: "contains",
      frame: { strategy: "main" },
      fallbacks: [],
    },
  });
  const released = await broker.release(intervention.id, "Opened the sub-account manually.");
  const r = await replayPromise;
  assert.equal(released.state, "released");
  assert.equal(broker.controlHolder, "automation");
  assert.equal(surface.isAutomationInControl(), true, "control must return to automation");
  assert.equal(released.operatorNote, "Opened the sub-account manually.");
  assert.equal(r.status, "ok", `replay must continue after a verified handoff, got ${r.status}`);
  assert.ok(r.trace.some((step) => step.status === "human" && step.interventionId === intervention.id));

  const events = await readFile(r.evidence.logPath, "utf8");
  assert.match(events, /"modelInvocations":0/, "resumed replay must remain zero-model");
  const ordered = ["control.ceded", "control.claimed", "control.human_action", "control.released", "replay.ok"];
  let cursor = -1;
  for (const event of ordered) {
    const next = events.indexOf(`\"event\":\"${event}\"`);
    assert.ok(next > cursor, `${event} must appear in handoff order in one event stream`);
    cursor = next;
  }
});

test("ESCALATION: releasing without the human action fails its checkpoint", async () => {
  const artifact = readBalanceArtifact();
  addSubAccountSteps(artifact, 300);
  approveArtifact(artifact);

  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const replayPromise = replay(artifact, { memberId: "12345" }, {
    ...deps(), escalation: broker, handoffWaitMs: 5_000,
  });
  const intervention = await waitForIntervention(broker);
  broker.claim(intervention.id, "operator@test");
  await broker.release(intervention.id, "No action taken.");
  const r = await replayPromise;
  assert.equal(r.status, "failed");
  if (r.status === "failed") assert.equal(r.failure, "checkpoint_failed");
});

test("ESCALATION: a bounded timeout abandons and returns the surface lease", async () => {
  const artifact = readBalanceArtifact();
  addSubAccountSteps(artifact, 300);
  approveArtifact(artifact);

  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const r = await replay(artifact, { memberId: "12345" }, {
    ...deps(), escalation: broker, handoffWaitMs: 30,
  });
  assert.equal(r.status, "escalated");
  if (r.status !== "escalated") return;
  assert.equal(r.resolution, "abandoned");

  assert.equal(broker.controlHolder, "automation");
  assert.equal(surface.isAutomationInControl(), true, "abandonment must return the surface lease");
});

test("FAILURE ESCALATION: no operator repair returns the original failure with linkage", async () => {
  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const replayPromise = replay(failureEscalationArtifact(), {}, {
    ...deps(), escalation: broker, escalateOnFailure: true, handoffWaitMs: 5_000,
  });
  const intervention = await waitForIntervention(broker);
  broker.claim(intervention.id, "operator@test");
  await broker.release(intervention.id, "Could not repair the page.");
  const result = await replayPromise;
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.failure, "target_not_found");
  assert.equal(result.interventionId, intervention.id);
});

test("FAILURE ESCALATION: operator repairs state and deterministic replay continues", async () => {
  const log = new EvidenceLog(newRunId("replay"), new Redactor(), EVIDENCE_ROOT);
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const replayPromise = replay(failureEscalationArtifact(), {}, {
    ...deps(), escalation: broker, escalateOnFailure: true, handoffWaitMs: 5_000,
  });
  const intervention = await waitForIntervention(broker);
  broker.claim(intervention.id, "operator@test");
  await broker.humanAction(intervention.id, {
    kind: "type",
    target: { ...targetDescriptor("textbox", "Member ID") },
    text: "12345",
  });
  await broker.humanAction(intervention.id, {
    kind: "click",
    target: { ...targetDescriptor("button", "Search") },
  });
  await broker.release(intervention.id, "Moved the same session to the member profile.");
  const result = await replayPromise;
  assert.equal(result.status, "ok", `operator repair should let replay re-resolve and continue, got ${result.status}`);
  const events = await readFile(result.evidence.logPath, "utf8");
  assert.match(events, /"failure":"target_not_found"/);
  assert.match(events, /"event":"failure.handoff_recovered"/);
  assert.match(events, /"modelInvocations":0/);
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

test("TENANT SAFETY: an unknown tenant fails closed instead of running the base flow", async () => {
  const r = await replay(readBalanceArtifact(), { memberId: "12345" }, { ...deps(), tenantId: "summitlin" });
  assert.equal(r.status, "failed");
  if (r.status !== "failed") return;
  assert.equal(r.failure, "invalid_input");
  assert.match(r.message, /No tenant overlay is declared/);
  assert.equal(r.trace.length, 0);
});
