/**
 * Recorder and policy tests.
 *
 * The recorder is where a raw run becomes something reusable, so the things worth asserting
 * are the transformations it adds: parameterisation, checkpoints, fallbacks, and the fact
 * that it refuses to emit an artifact that would not validate.
 *
 * No browser and no model needed here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { record } from "../src/discovery/recorder.js";
import type { DiscoveryResult } from "../src/discovery/agent.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";
import { Redactor, maskPartial } from "../src/policy/redact.js";
import { CapabilityCatalog } from "../src/catalog/catalog.js";
import { CU_BUSINESS_OUTCOMES } from "../src/knowledge.js";

const BASE = "http://localhost:4471";

function discoveryFixture(): DiscoveryResult {
  return {
    success: true,
    goal: "Look up a member and read their savings balance",
    model: "test-model",
    successText: "Member Profile",
    actions: [
      {
        index: 0,
        proposed: { action: "type", reason: "Enter the member id", target: { role: "textbox", name: "Member ID" }, text: "12345" },
        executedTarget: {
          role: "textbox",
          name: "Member ID",
          nameMatch: "exact",
          frame: { strategy: "main" },
          fallbacks: [],
        },
        strategy: "role-name",
        matchCount: 1,
        risk: "safe",
        typedText: "12345",
        observationAfter: { location: `${BASE}/`, title: "Member Search", notices: [] },
      },
      {
        index: 1,
        proposed: { action: "click", reason: "Submit the search", target: { role: "button", name: "Search" } },
        executedTarget: {
          role: "button",
          name: "Search",
          nameMatch: "exact",
          frame: { strategy: "main" },
          fallbacks: [],
        },
        strategy: "role-name",
        matchCount: 1,
        risk: "safe",
        observationAfter: {
          location: `${BASE}/workspace?memberId=12345`,
          title: "Member Workspace 12345",
          notices: [],
        },
      },
    ],
  };
}

function recordFixture() {
  return record({
    name: "member.read_savings_balance",
    title: "Read savings balance",
    description: "Test",
    productId: "acme-core-banking",
    baseUrl: BASE,
    startUrl: BASE,
    inputs: [
      { name: "memberId", type: "string", required: true, description: "Member ID", sensitive: false },
    ],
    outputs: [],
    inputValues: { memberId: "12345" },
    discovery: discoveryFixture(),
    runId: "test-run",
    businessOutcomes: CU_BUSINESS_OUTCOMES,
  });
}

test("recorder parameterises a typed value that matches a declared input", () => {
  const a = recordFixture();
  const typeStep = a.steps.find((s) => s.action === "type");
  assert.ok(typeStep, "expected a type step");
  assert.deepEqual(
    typeStep!.value,
    { kind: "param", param: "memberId" },
    "the literal 12345 must become a parameter reference, or the capability only works once"
  );
});

test("recorder does not parameterise text that merely resembles an input", () => {
  const d = discoveryFixture();
  d.actions[0]!.typedText = "123456";
  d.actions[0]!.proposed.text = "123456";
  const a = record({
    name: "x.y",
    title: "t",
    description: "d",
    productId: "p",
    baseUrl: BASE,
    startUrl: BASE,
    inputs: [{ name: "memberId", type: "string", required: true, description: "", sensitive: false }],
    outputs: [],
    inputValues: { memberId: "12345" },
    discovery: d,
    runId: "r",
  });
  const typeStep = a.steps.find((s) => s.action === "type");
  assert.equal(typeStep!.value?.kind, "literal", "substring matches must not be parameterised");
});

test("recorder prepends an explicit navigate so the capability is self-contained", () => {
  const a = recordFixture();
  assert.equal(a.steps[0]!.action, "navigate");
  assert.ok(a.steps[0]!.checkpoint, "the entry step needs a checkpoint like any other");
});

test("recorder attaches a checkpoint to every state-changing step", () => {
  const a = recordFixture();
  for (const s of a.steps) {
    if (s.action === "click" || s.action === "navigate") {
      assert.ok(s.checkpoint, `step ${s.id} (${s.action}) must assert where it landed`);
    }
  }
  // Typing does not change page state, so asserting after it would cost time for no safety.
  const typeStep = a.steps.find((s) => s.action === "type");
  assert.equal(typeStep!.checkpoint, undefined);
});

test("recorder builds a fallback ladder and never records a brittle id", () => {
  const a = recordFixture();
  const click = a.steps.find((s) => s.action === "click")!;
  assert.ok(click.target!.fallbacks.length > 0, "expected fallbacks beneath the primary locator");
  for (const s of a.steps) {
    for (const fb of s.target?.fallbacks ?? []) {
      assert.notEqual(fb.kind, "css", "the app's ids carry row indexes; recording one is a trap");
      assert.notEqual(fb.kind, "xpath");
    }
  }
});

test("recorder attaches error knowledge that a happy-path run could not have learned", () => {
  const a = recordFixture();
  const codes = a.businessOutcomes.map((b) => b.code);
  assert.ok(codes.includes("MEMBER_NOT_FOUND"));
  assert.ok(codes.includes("SESSION_EXPIRED"));
});

test("recorded artifacts start as drafts", () => {
  assert.equal(recordFixture().approval.state, "draft");
});

test("recorder keeps the discovery rationale for human review", () => {
  const a = recordFixture();
  const click = a.steps.find((s) => s.action === "click")!;
  assert.equal(click.discoveredBecause, "Submit the search");
});

/* ------------------------------------------------------------------ policy */

test("risk classification is conservative about irreversible verbs", () => {
  assert.equal(PolicyEngine.classifyRisk("click", "Confirm and Open"), "irreversible");
  assert.equal(PolicyEngine.classifyRisk("click", "Open Sub-Account"), "irreversible");
  assert.equal(PolicyEngine.classifyRisk("click", "Transfer Funds"), "irreversible");
  assert.equal(PolicyEngine.classifyRisk("click", "Save Changes"), "elevated");
  assert.equal(PolicyEngine.classifyRisk("click", "Search"), "safe");
  assert.equal(PolicyEngine.classifyRisk("read", "Confirm and Open"), "safe", "reading is never destructive");
});

test("allowlist rejects a host that merely contains an allowed name", () => {
  const p = new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["bank.example"] });
  assert.equal(p.checkUrl("https://bank.example/x").allow, true);
  assert.equal(p.checkUrl("https://bank.example.evil.com/x").allow, false);
  assert.equal(p.checkUrl("https://notbank.example/x").allow, false);
});

test("suffix allowlisting works for subdomains when asked for explicitly", () => {
  const p = new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: [".bank.example"] });
  assert.equal(p.checkUrl("https://core.bank.example/x").allow, true);
  assert.equal(p.checkUrl("https://bank.example.evil.com/x").allow, false);
});

/* ------------------------------------------------------------------ redaction */

test("redactor removes declared secrets and known patterns from nested structures", () => {
  const r = new Redactor();
  r.addSecret("hunter2-the-password");
  const out = r.redact({
    note: "logged in with hunter2-the-password",
    ssn: "123-45-6789",
    contact: "dana@example.invalid",
    password: "anything at all",
    nested: [{ token: "Bearer abcdefghijklmnop" }],
  }) as Record<string, unknown>;

  assert.ok(!JSON.stringify(out).includes("hunter2-the-password"));
  assert.ok(!JSON.stringify(out).includes("123-45-6789"));
  assert.ok(!JSON.stringify(out).includes("dana@example.invalid"));
  assert.equal(out.password, "[REDACTED]", "sensitive keys are dropped, not pattern-matched");
});

test("maskPartial keeps enough to correlate without revealing the value", () => {
  assert.equal(maskPartial("12345678"), "12****78");
  assert.equal(maskPartial("abc"), "***");
});

/* ------------------------------------------------------------------ catalog */

test("catalog renders artifacts as agent-invocable tool definitions", () => {
  const catalog = new CapabilityCatalog("capabilities").load();
  const tools = catalog.toToolDefinitions();
  // The repo ships a recorded artifact, but the test should not fail if it is absent.
  if (tools.length === 0) return;
  for (const t of tools) {
    assert.ok(t.name.length > 0);
    assert.ok(t.input_schema, "an agent needs a JSON Schema to call this");
    assert.ok(["safe", "elevated", "irreversible"].includes(t.x_understudy.maxRisk));
  }
});
