import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSurface } from "../src/surface/web-surface.js";
import { discover } from "../src/discovery/agent.js";
import type { LlmClient } from "../src/discovery/llm.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";
import { EvidenceLog, newRunId } from "../src/evidence/logger.js";
import { Redactor } from "../src/policy/redact.js";
import { EscalationBroker } from "../src/escalation/escalation.js";

const PORT = Number(process.env.TARGET_PORT ?? 4471);
const BASE = `http://localhost:${PORT}`;

test("discovery give_up raises a contextual intervention in record-only mode", async () => {
  const surface = new WebSurface({ headless: true });
  await surface.start();
  const log = new EvidenceLog(newRunId("discover"), new Redactor(), "evidence/test-runs");
  const broker = new EscalationBroker(surface, log, "http://localhost:4472");
  const llm: LlmClient = {
    modelId: "scripted-give-up",
    async complete() {
      return JSON.stringify({ action: "give_up", reason: "The application state is unfamiliar" });
    },
  };
  try {
    const result = await discover({
      goal: "Read the service banner",
      startUrl: BASE,
      inputs: [],
      outputs: [],
      inputValues: {},
      maxSteps: 2,
    }, {
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
      llm,
      log,
      escalation: broker,
      escalationWaitMs: 0,
    });
    assert.equal(result.success, false);
    assert.ok(result.interventionId);
    assert.equal(broker.get(result.interventionId!)?.reason, "The application state is unfamiliar");
    assert.equal(broker.controlHolder, "awaiting_human");
    await broker.abandon(result.interventionId!, "test cleanup");
  } finally {
    await surface.close();
  }
});

test("discovery stops on its wall-clock budget before asking the model to act", async () => {
  const surface = new WebSurface({ headless: true });
  await surface.start();
  const log = new EvidenceLog(newRunId("discover"), new Redactor(), "evidence/test-runs");
  let modelCalls = 0;
  const llm: LlmClient = {
    modelId: "must-not-run-after-timeout",
    async complete() {
      modelCalls += 1;
      return JSON.stringify({ action: "done", reason: "unexpected" });
    },
  };
  try {
    const result = await discover({
      goal: "Read the service banner",
      startUrl: BASE,
      inputs: [],
      outputs: [],
      inputValues: {},
      maxRunMs: 1,
    }, {
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
      llm,
      log,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? "", /time budget/);
    assert.equal(modelCalls, 0);
  } finally {
    await surface.close();
  }
});
