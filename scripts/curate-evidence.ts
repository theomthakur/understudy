import assert from "node:assert/strict";
import { chromium } from "playwright";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { computeArtifactHash, parseArtifact, type CapabilityArtifact } from "../src/domain/artifact.js";
import type { ReplayResult } from "../src/domain/result.js";
import { replay } from "../src/replay/replay.js";
import { WebSurface } from "../src/surface/web-surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";
import { EvidenceLog, newRunId } from "../src/evidence/logger.js";
import { Redactor } from "../src/policy/redact.js";
import { EscalationBroker } from "../src/escalation/escalation.js";
import { startTargetServer } from "../target-app/server.js";

// Match the host used by the target server and approved artifacts. On macOS, localhost may
// bind IPv6 while 127.0.0.1 reaches a different socket and makes curation fail midway.
const TARGET_ORIGIN = "http://localhost:4471";
const STAGE = resolve("evidence/.curation-stage");
const CURATED = resolve("evidence/curated");

interface ManifestCase {
  label: string;
  capability: string;
  syntheticInput: string;
  expectedStatus: ReplayResult["status"];
  expectedCode?: string;
  expectedFailure?: string;
  resultPath: string;
  screenshotPaths: string[];
}

async function load(name: string): Promise<CapabilityArtifact> {
  return parseArtifact(JSON.parse(await readFile(resolve(`capabilities/${name}.json`), "utf8")));
}

async function runCase(
  label: string,
  memberId: string,
  mutate?: (artifact: CapabilityArtifact) => void,
  tenantId?: string
): Promise<{ result: ReplayResult; screenshotPaths: string[] }> {
  const artifact = await load("member.read_savings_balance");
  mutate?.(artifact);
  if (mutate) artifact.artifactHash = computeArtifactHash(artifact);
  const surface = new WebSurface({ headless: true });
  await surface.start();
  try {
    const result = await replay(artifact, { memberId }, {
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
      tenantId,
      evidenceRoot: STAGE,
      captureStepScreenshots: true,
    });
    return { result, screenshotPaths: await publish(label, result) };
  } finally {
    await surface.close();
  }
}

async function publish(label: string, result: ReplayResult): Promise<string[]> {
  const source = resolve(STAGE, result.evidence.runId);
  const destination = resolve(CURATED, label);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  const resultPath = resolve(destination, "result.json");
  const persisted = JSON.parse(await readFile(resultPath, "utf8")) as ReplayResult;
  persisted.evidence.logPath = `evidence/curated/${label}/events.jsonl`;
  if (persisted.evidence.screenshotPath) {
    persisted.evidence.screenshotPath = `evidence/curated/${label}/${basename(persisted.evidence.screenshotPath)}`;
  }
  if (persisted.evidence.observationPath) {
    persisted.evidence.observationPath = `evidence/curated/${label}/${basename(persisted.evidence.observationPath)}`;
  }
  await writeFile(resultPath, JSON.stringify(persisted, null, 2) + "\n", "utf8");
  const names = (await import("node:fs/promises")).readdir(destination);
  return (await names).filter((name) => name.endsWith(".png")).sort().map((name) => `evidence/curated/${label}/${name}`);
}

async function curateHandoff(): Promise<{ result: ReplayResult; screenshotPaths: string[] }> {
  const artifact = await load("member.open_sub_account");
  const surface = new WebSurface({ headless: true });
  await surface.start();
  const placeholder = new EvidenceLog(newRunId("replay"), new Redactor(), STAGE);
  const broker = new EscalationBroker(surface, placeholder, "http://127.0.0.1:4317/studio");
  try {
    const replayPromise = replay(artifact, { memberId: "12345" }, {
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
      escalation: broker,
      evidenceRoot: STAGE,
      captureStepScreenshots: true,
      handoffWaitMs: 10_000,
    });
    const intervention = await waitForIntervention(broker);

    broker.claim(intervention.id, "candidate.reviewer");
    const endpoint = intervention.liveSessionEndpoint;
    assert.ok(endpoint, "handoff must expose the same live browser session");
    const operatorBrowser = await chromium.connectOverCDP(endpoint);
    const operatorPage = operatorBrowser.contexts()[0]?.pages()[0];
    assert.ok(operatorPage, "operator must attach to the existing page");
    await clickInAnyFrame(operatorPage, "Confirm and Open");
    await broker.release(intervention.id, "Confirmed the guarded action in the same live session.");
    const result = await replayPromise;
    assert.equal(result.status, "ok", "replay must verify the human action and resume to final success");
    assert.ok(surface.collectHumanEvents().length > 0, "the handoff audit must contain a real human-session event");

    const events = await readFile(result.evidence.logPath, "utf8");
    const ordered = ["control.ceded", "control.claimed", "control.released", "escalation.resumed", "replay.ok"];
    let cursor = -1;
    for (const event of ordered) {
      const next = events.indexOf(`\"event\":\"${event}\"`);
      assert.ok(next > cursor, `${event} must appear in order in the handoff evidence stream`);
      cursor = next;
    }

    return { result, screenshotPaths: await publish("replay-handoff", result) };
  } finally {
    await surface.close();
  }
}

async function waitForIntervention(broker: EscalationBroker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const intervention = broker.list().at(-1);
    if (intervention) return intervention;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("handoff intervention was not raised in time");
}

async function clickInAnyFrame(page: import("playwright").Page, name: string): Promise<void> {
  for (const frame of page.frames()) {
    const button = frame.getByRole("button", { name });
    if (await button.count()) {
      await button.click();
      return;
    }
  }
  throw new Error(`operator could not find ${name}`);
}

async function main(): Promise<void> {
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await mkdir(CURATED, { recursive: true });
  const target = await startTargetServer(4471);
  const cases: ManifestCase[] = [];

  try {
    const success = await runCase("replay-success", "22871");
    assert.equal(success.result.status, "ok");
    if (success.result.status === "ok") {
      assert.deepEqual(success.result.outputs.savingsBalance, { amount: 402.19, currency: "USD", display: "$402.19" });
    }
    cases.push(entry("replay-success", "22871", success));

    const noSavings = await runCase("replay-no-savings", "44120");
    assertOutcome(noSavings.result, "NO_SAVINGS_ACCOUNT");
    cases.push(entry("replay-no-savings", "44120", noSavings, "NO_SAVINGS_ACCOUNT"));

    const notFound = await runCase("replay-not-found", "99999");
    assertOutcome(notFound.result, "MEMBER_NOT_FOUND");
    cases.push(entry("replay-not-found", "99999", notFound, "MEMBER_NOT_FOUND"));

    const denied = await runCase("replay-permission-denied", "30099");
    assertOutcome(denied.result, "PERMISSION_DENIED");
    cases.push(entry("replay-permission-denied", "30099", denied, "PERMISSION_DENIED"));

    await fetch(`${TARGET_ORIGIN}/__fault?kind=interstitial&times=1`);
    const recovered = await runCase("replay-recovery", "12345");
    assert.equal(recovered.result.status, "ok");
    cases.push(entry("replay-recovery", "12345", recovered));

    const failed = await runCase("replay-hard-failure", "12345", (artifact) => {
      const step = artifact.steps.find((candidate) => candidate.id === "s2");
      assert.ok(step?.target);
      step.target = {
        role: "button",
        name: "Wire Funds",
        nameMatch: "exact",
        frame: { strategy: "main" },
        fallbacks: [],
      };
    });
    assert.equal(failed.result.status, "failed");
    if (failed.result.status === "failed") assert.equal(failed.result.failure, "target_not_found");
    assert.ok(failed.screenshotPaths.some((path) => path.endsWith("failure.png")));
    cases.push(entry("replay-hard-failure", "12345", failed, undefined, "target_not_found"));

    const tenant = await runCase("replay-second-tenant", "22871", undefined, "summitline");
    assert.equal(tenant.result.status, "ok");
    if (tenant.result.status === "ok") {
      assert.deepEqual(tenant.result.outputs.savingsBalance, { amount: 402.19, currency: "USD", display: "$402.19" });
    }
    cases.push(entry("replay-second-tenant", "22871", tenant));

    const handoff = await curateHandoff();
    cases.push(entry("replay-handoff", "12345", handoff));

    const manifest = {
      generatedAt: new Date().toISOString(),
      environment: "synthetic",
      discovery: {
        model: "codex-cli:account-default",
        syntheticInput: "12345",
        events: "evidence/examples/01-discovery-live/events.jsonl",
      },
      guarantees: {
        replayModelInvocations: 0,
        curatedByExactRunId: true,
        rawSensitiveValuesExcludedFromStructuredLogs: true,
      },
      cases,
    };
    await writeFile(resolve(CURATED, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`Curated ${cases.length} asserted runs into evidence/curated/.`);
  } finally {
    await target.close();
    await rm(STAGE, { recursive: true, force: true });
  }
}

function entry(
  label: string,
  memberId: string,
  run: { result: ReplayResult; screenshotPaths: string[] },
  expectedCode?: string,
  expectedFailure?: string
): ManifestCase {
  return {
    label,
    capability: run.result.capability,
    syntheticInput: memberId,
    expectedStatus: run.result.status,
    expectedCode,
    expectedFailure,
    resultPath: `evidence/curated/${label}/result.json`,
    screenshotPaths: run.screenshotPaths,
  };
}

function assertOutcome(result: ReplayResult, code: string): void {
  assert.equal(result.status, "outcome");
  if (result.status === "outcome") assert.equal(result.code, code);
}

await main();
