#!/usr/bin/env node
/**
 * CLI.
 *
 *   discover   run the LLM-driven discovery loop and record a capability artifact
 *   replay     execute a saved artifact deterministically, no model involved
 *   catalog    show saved capabilities as agent-invocable tool definitions
 *   operator   start the operator surface on its own (for inspecting past interventions)
 *   approve    move an artifact from draft to approved
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "./env.js";
import { WebSurface } from "./surface/web-surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "./policy/policy.js";
import { Redactor } from "./policy/redact.js";
import { EvidenceLog, newRunId } from "./evidence/logger.js";
import { discover } from "./discovery/agent.js";
import { record } from "./discovery/recorder.js";
import { createLlmClient, MissingKeyError } from "./discovery/llm.js";
import { replay } from "./replay/replay.js";
import { summarize } from "./domain/result.js";
import { parseArtifact, type CapabilityArtifact } from "./domain/artifact.js";
import { EscalationBroker } from "./escalation/escalation.js";
import { startOperatorServer } from "./escalation/operator-server.js";
import { CapabilityCatalog } from "./catalog/catalog.js";
import { CU_BUSINESS_OUTCOMES, CU_RECOVERIES, cuTenantOverlays } from "./knowledge.js";

loadEnv();

const CAPABILITIES_DIR = "capabilities";
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 4471);
const OPERATOR_PORT = Number(process.env.OPERATOR_PORT ?? 4472);
const BASE_URL = `http://localhost:${TARGET_PORT}`;

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? "help";
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) args[a.slice(2)] = argv[++i]!;
    else args[a.slice(2)] = true;
  }
  return { cmd, args };
}

/* ------------------------------------------------------------------ presets */

/**
 * Two goals, chosen to exercise different parts of the design.
 *
 * `read_savings_balance` is the read path: parameterised input, typed output, and the
 * not-found business outcome. It is the one to look at first.
 *
 * `open_sub_account` deliberately ends at an irreversible step, so the safety gate and the
 * human escalation path are exercised rather than described.
 */
const PRESETS: Record<
  string,
  {
    name: string;
    title: string;
    description: string;
    goal: string;
    inputs: CapabilityArtifact["inputs"];
    outputs: CapabilityArtifact["outputs"];
    sampleValues: Record<string, string>;
  }
> = {
  read_savings_balance: {
    name: "member.read_savings_balance",
    title: "Read a member's savings balance",
    description:
      "Looks up a member by ID in the back-office console and returns the balance of their savings account.",
    goal:
      "Look up the member with the given member ID, open their profile, and read the current balance " +
      "of their SAVINGS account. Capture it as the output 'savingsBalance'.",
    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        description: "The member's ID number as shown in the console",
        sensitive: false,
        pattern: "^\\d{3,10}$",
      },
    ],
    outputs: [
      {
        name: "savingsBalance",
        type: "number",
        description: "Current balance of the member's savings account, in dollars",
        sensitive: false,
      },
    ],
    sampleValues: { memberId: "12345" },
  },
  open_sub_account: {
    name: "member.open_sub_account",
    title: "Open a sub-account for a member",
    description:
      "Opens a new sub-account for an existing member. Ends at an irreversible confirmation step, " +
      "which is gated by policy and routed to a human.",
    goal:
      "Look up the member with the given member ID, open their profile, and begin opening a new " +
      "sub-account. Stop when you reach the confirmation screen.",
    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        description: "The member's ID number",
        sensitive: false,
        pattern: "^\\d{3,10}$",
      },
    ],
    outputs: [],
    sampleValues: { memberId: "12345" },
  },
};

/* ------------------------------------------------------------------ commands */

async function cmdDiscover(args: Args): Promise<void> {
  const presetKey = String(args.goal ?? "read_savings_balance");
  const preset = PRESETS[presetKey];
  if (!preset) {
    fail(`Unknown goal "${presetKey}". Available: ${Object.keys(PRESETS).join(", ")}`);
  }

  const inputValues = { ...preset.sampleValues };
  for (const p of preset.inputs) {
    if (args[p.name] !== undefined) inputValues[p.name] = String(args[p.name]);
  }

  let llm;
  try {
    llm = createLlmClient();
  } catch (e) {
    if (e instanceof MissingKeyError) fail(e.message);
    throw e;
  }

  const runId = newRunId("discover");
  const redactor = new Redactor();
  for (const p of preset.inputs) if (p.sensitive) redactor.addSecret(inputValues[p.name]);
  const log = new EvidenceLog(runId, redactor);

  const surface = new WebSurface({
    headless: !args.headed,
    slowMoMs: args.headed ? 250 : 0,
  });
  await surface.start();

  const policy = new PolicyEngine({ ...DEFAULT_POLICY, maxSteps: 40 });
  const startUrl = String(args.url ?? BASE_URL);

  console.log(`\ndiscovery  goal=${presetKey}  model=${llm.modelId}  run=${runId}`);
  console.log(`           start=${startUrl}  inputs=${JSON.stringify(inputValues)}\n`);

  try {
    const result = await discover(
      {
        goal: preset.goal,
        startUrl,
        inputs: preset.inputs,
        outputs: preset.outputs,
        inputValues,
      },
      { surface, policy, llm, log }
    );

    if (!result.success) {
      await surface.screenshot(log.screenshotPath("discovery-incomplete"));
      log.error("discovery.incomplete", { reason: result.reason });
      console.log(`\ndiscovery did not complete: ${result.reason}`);
      console.log(`evidence: ${log.dir}`);
      process.exitCode = 1;
      return;
    }

    const artifact = record({
      name: preset.name,
      title: preset.title,
      description: preset.description,
      productId: "acme-core-banking",
      baseUrl: BASE_URL,
      startUrl,
      inputs: preset.inputs,
      outputs: preset.outputs,
      inputValues,
      discovery: result,
      runId,
      businessOutcomes: CU_BUSINESS_OUTCOMES,
      recoveries: CU_RECOVERIES,
      tenantOverlays: cuTenantOverlays(TARGET_PORT),
    });

    mkdirSync(CAPABILITIES_DIR, { recursive: true });
    const path = join(CAPABILITIES_DIR, `${artifact.name}.json`);
    writeFileSync(path, JSON.stringify(artifact, null, 2), "utf8");

    console.log(`\nrecorded  ${artifact.name}@${artifact.revision}  ${artifact.steps.length} steps`);
    console.log(`          ${path}`);
    console.log(`          approval=${artifact.approval.state} (irreversible steps stay gated until approved)`);
    console.log(`evidence: ${log.dir}\n`);
  } finally {
    await surface.close();
  }
}

async function cmdReplay(args: Args): Promise<void> {
  const name = String(args.capability ?? "member.read_savings_balance");
  const path = join(CAPABILITIES_DIR, `${name}.json`);
  if (!existsSync(path)) fail(`No artifact at ${path}. Run discover first.`);

  const artifact = parseArtifact(JSON.parse(readFileSync(path, "utf8")));

  const inputs: Record<string, string> = {};
  for (const p of artifact.inputs) {
    if (args[p.name] !== undefined) inputs[p.name] = String(args[p.name]);
  }
  // Allow deliberately-invalid input for the error-path demo.
  if (args.memberId !== undefined) inputs.memberId = String(args.memberId);

  const surface = new WebSurface({ headless: !args.headed, slowMoMs: args.headed ? 250 : 0 });
  await surface.start();

  const redactor = new Redactor();
  const brokerLog = new EvidenceLog(newRunId("replay"), redactor);

  // One broker, shared by the run and the operator surface. Two instances would mean the
  // operator queue serves a different object from the one holding the intervention.
  const broker = new EscalationBroker(surface, brokerLog, `http://localhost:${OPERATOR_PORT}`);
  const operator = await startOperatorServer(broker, OPERATOR_PORT).catch(() => undefined);

  try {
    const result = await replay(artifact, inputs, {
      surface,
      policy: new PolicyEngine(DEFAULT_POLICY),
      attended: !!args.attended,
      tenantId: args.tenant ? String(args.tenant) : undefined,
      escalation: broker,
    });

    console.log("\n" + summarize(result));
    console.log(`evidence: evidence/runs/${result.evidence.runId}\n`);

    if (result.status === "escalated") {
      console.log(`The run is paused and the live session is held for a human.`);
      console.log(`Operator queue: ${result.handoffUrl}`);
      if (args.headed) console.log(`The browser window is open — that is the session to work in.`);
      console.log(`Waiting up to 120s for control to be handed back...`);
      const req = await broker.waitForRelease(result.interventionId, 120_000);
      console.log(`intervention ${req.id} -> ${req.state}${req.operatorNote ? `  note="${req.operatorNote}"` : ""}\n`);
    }

    process.exitCode = result.status === "failed" ? 1 : 0;
  } finally {
    await operator?.close();
    await surface.close();
  }
}

function cmdCatalog(): void {
  const catalog = new CapabilityCatalog(CAPABILITIES_DIR).load();
  const tools = catalog.toToolDefinitions();
  if (tools.length === 0) {
    console.log(`No capabilities in ${CAPABILITIES_DIR}/. Run discover first.`);
    return;
  }
  console.log(JSON.stringify(tools, null, 2));
}

function cmdApprove(args: Args): void {
  const name = String(args.capability ?? "");
  if (!name) fail("--capability is required");
  const path = join(CAPABILITIES_DIR, `${name}.json`);
  if (!existsSync(path)) fail(`No artifact at ${path}`);
  const artifact = parseArtifact(JSON.parse(readFileSync(path, "utf8")));
  artifact.approval = {
    state: "approved",
    reviewedBy: String(args.by ?? "reviewer@example.invalid"),
    reviewedAt: new Date().toISOString(),
    note: String(args.note ?? "Reviewed steps, locators and risk classification."),
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`approved  ${artifact.name}@${artifact.revision}  by ${artifact.approval.reviewedBy}`);
}

async function cmdOperator(): Promise<void> {
  const surface = new WebSurface({ headless: true });
  const log = new EvidenceLog(newRunId("replay"), new Redactor());
  const broker = new EscalationBroker(surface, log, `http://localhost:${OPERATOR_PORT}`);
  const s = await startOperatorServer(broker, OPERATOR_PORT);
  console.log(`operator surface: ${s.url}`);
}

function usage(): void {
  console.log(`
understudy — computer-use automation with deterministic replay

  npm run target                                   start the stand-in back-office app

  npm run discover -- --goal read_savings_balance [--memberId 12345] [--headed]
  npm run discover -- --goal open_sub_account     [--headed]

  npm run replay -- --capability member.read_savings_balance --memberId 22871
  npm run replay -- --capability member.read_savings_balance --memberId 99999   # business outcome
  npm run replay -- --capability member.read_savings_balance --memberId 30099   # permission denied
  npm run replay -- --capability member.open_sub_account --memberId 12345 --headed  # escalation

  npm run catalog                                  agent-invocable tool definitions
  tsx src/cli.ts approve --capability member.open_sub_account

Fault injection against the target app:
  curl "http://localhost:${TARGET_PORT}/__fault?kind=session&times=1"
  curl "http://localhost:${TARGET_PORT}/__fault?kind=interstitial&times=1"
`);
}

function fail(msg: string): never {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

const { cmd, args } = parseArgs(process.argv.slice(2));
const run = async (): Promise<void> => {
  switch (cmd) {
    case "discover":
      return cmdDiscover(args);
    case "replay":
      return cmdReplay(args);
    case "catalog":
      return cmdCatalog();
    case "approve":
      return cmdApprove(args);
    case "operator":
      return cmdOperator();
    default:
      return usage();
  }
};

run().catch((e) => {
  console.error(`\n${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
