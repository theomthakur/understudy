/**
 * Deterministic replay. This is the production execution path.
 *
 * No model is consulted here. Not for decisions, not for recovery, not for locating a
 * control. Given the same artifact, the same inputs and the same app state, this executes
 * the same steps in the same order every time. That is the entire value proposition: the
 * expensive, non-deterministic discovery happens once, and every subsequent invocation is
 * cheap and predictable.
 *
 * The interesting logic is not "click the things in order". It is the classification loop:
 * after every step, before deciding anything is wrong, we ask in this order
 *
 *   1. Is this a declared business outcome?  -> return `outcome`, not an error
 *   2. Is this a known recoverable condition? -> remedy it, bounded, and retry the step
 *   3. Did the checkpoint pass?               -> continue
 *   4. Otherwise                              -> `failed`, with expected vs observed
 *
 * Order matters. Checking business outcomes first is what stops "no such member" being
 * reported as a broken capability.
 */

import type {
  CapabilityArtifact,
  Checkpoint,
  ElementDescriptor,
  RecoveryRule,
  Step,
  Value,
} from "../domain/artifact.js";
import type {
  FailedResult,
  OutcomeResult,
  ReplayResult,
  StepTrace,
} from "../domain/result.js";
import type { Observation, ResolveTarget, Surface } from "../surface/surface.js";
import { describeTarget } from "../surface/web-surface.js";
import type { PolicyEngine } from "../policy/policy.js";
import { Redactor } from "../policy/redact.js";
import { EvidenceLog, newRunId } from "../evidence/logger.js";
import type { EscalationBroker } from "../escalation/escalation.js";

export interface ReplayOptions {
  surface: Surface;
  policy: PolicyEngine;
  /** true when a human is watching and can approve elevated steps inline. */
  attended?: boolean;
  /** Applies matching tenant overlay before execution. */
  tenantId?: string;
  escalation?: EscalationBroker;
  evidenceRoot?: string;
}

export async function replay(
  artifact: CapabilityArtifact,
  inputs: Record<string, string | number | boolean>,
  opts: ReplayOptions
): Promise<ReplayResult> {
  const started = Date.now();
  const runId = newRunId("replay");
  const redactor = new Redactor();
  const log = new EvidenceLog(runId, redactor, opts.evidenceRoot);
  const trace: StepTrace[] = [];

  // Register sensitive inputs with the redactor before anything is written anywhere.
  for (const p of artifact.inputs) {
    if (p.sensitive) redactor.addSecret(String(inputs[p.name] ?? ""));
  }

  log.info("replay.start", {
    capability: artifact.name,
    revision: artifact.revision,
    runId,
    tenantId: opts.tenantId,
    attended: !!opts.attended,
  });

  const evidence = { runId, logPath: log.eventsPath };
  const fail = (
    failure: FailedResult["failure"],
    stepId: string | null,
    expected: string,
    observed: string,
    message: string
  ): FailedResult => ({
    status: "failed",
    capability: artifact.name,
    revision: artifact.revision,
    failure,
    stepId,
    expected,
    observed,
    message,
    trace,
    evidence,
    durationMs: Date.now() - started,
  });

  /* ---------------------------------------------------------- input validation */
  // Done before any browser work: a contract violation should cost nothing.
  const validation = validateInputs(artifact, inputs);
  if (validation) {
    log.error("replay.invalid_input", { detail: validation });
    const r = fail("invalid_input", null, "inputs satisfying the declared contract", validation, validation);
    log.saveResult(r);
    return r;
  }

  /* ---------------------------------------------------------- tenant overlay */
  const overlay = opts.tenantId
    ? artifact.tenantOverlays.find((o) => o.tenantId === opts.tenantId)
    : undefined;
  if (opts.tenantId && !overlay) {
    log.warn("replay.no_overlay", {
      tenantId: opts.tenantId,
      detail: "running the base flow unmodified",
    });
  }

  const approved = artifact.approval.state === "approved";

  /* ---------------------------------------------------------- step loop */
  const outputs: Record<string, string | number | boolean> = {};
  const recoveryAttempts = new Map<string, number>();

  for (const rawStep of artifact.steps) {
    if (Date.now() - started > opts.policy.config.maxRunMs) {
      const r = fail("timeout", rawStep.id, `run under ${opts.policy.config.maxRunMs}ms`, "budget exceeded", "Run budget exceeded");
      log.error("replay.timeout", { stepId: rawStep.id });
      log.saveResult(r);
      return r;
    }

    const step = applyOverlay(rawStep, overlay?.descriptorOverrides[rawStep.id]);
    const stepStarted = Date.now();

    /* ------------------------------------------------ policy */
    const actionVerdict = opts.policy.checkAction(step.action);
    if (!actionVerdict.allow) {
      log.error("policy.action_denied", { stepId: step.id, reason: actionVerdict.reason });
      const r = fail("policy_denied", step.id, "an allowed action", step.action, actionVerdict.reason);
      await captureFailure(opts.surface, log, r);
      log.saveResult(r);
      return r;
    }

    const riskVerdict = opts.policy.checkRisk(step.risk, {
      approved,
      attended: !!opts.attended,
    });
    if (!riskVerdict.allow) {
      log.warn("policy.risk_gate", { stepId: step.id, risk: step.risk, reason: riskVerdict.reason });
      if (riskVerdict.escalate && opts.escalation) {
        return await escalate(
          artifact, step.id, riskVerdict.reason, opts, log, trace, started, evidence
        );
      }
      const r = fail("policy_denied", step.id, `a permitted ${step.risk} action`, "refused by policy", riskVerdict.reason);
      await captureFailure(opts.surface, log, r);
      log.saveResult(r);
      return r;
    }

    /* ------------------------------------------------ execute, with bounded recovery */
    let attempt = 0;
    let stepStatus: StepTrace["status"] = "ok";
    let recoveryCode: string | undefined;

    for (;;) {
      attempt++;
      try {
        await executeStep(step, artifact, inputs, outputs, opts, log, overlay?.baseUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("step.action_error", { stepId: step.id, attempt, detail: message });

        // An action throwing is not automatically a failure. The page may be showing a
        // declared business outcome or a recoverable interstitial, and we must look before
        // we conclude anything.
        const obs = await safeObserve(opts.surface);
        const outcome = obs && detectBusinessOutcome(artifact, obs);
        if (outcome) return finishOutcome(outcome, artifact, outputs, trace, evidence, started, log);

        const rec = obs && detectRecovery(artifact, obs);
        if (rec && underAttemptLimit(recoveryAttempts, rec)) {
          recoveryCode = rec.code;
          stepStatus = "recovered";
          log.info("recovery.apply", { stepId: step.id, code: rec.code, remedy: rec.remedy.kind });
          await applyRecovery(rec, opts.surface, log);
          continue; // retry the step
        }
        if (rec) {
          const r = fail("recovery_exhausted", step.id, `recovery "${rec.code}" to clear the condition`, message, `Recovery ${rec.code} exhausted after ${rec.maxAttempts} attempts`);
          await captureFailure(opts.surface, log, r);
          log.saveResult(r);
          return r;
        }

        if (step.optional) {
          log.info("step.optional_skipped", { stepId: step.id, detail: message });
          stepStatus = "skipped";
          break;
        }

        const cls = /Could not resolve control/.test(message) ? "target_not_found" : "surface_error";
        const r = fail(cls, step.id, step.target ? describeDescriptor(step.target) : step.action, message, message);
        await captureFailure(opts.surface, log, r);
        log.saveResult(r);
        return r;
      }

      /* ------------------------------------------------ checkpoint */
      if (!step.checkpoint) break;

      const cpOk = await assertCheckpoint(step.checkpoint, opts.surface);
      if (cpOk) break;

      const obs = await safeObserve(opts.surface);

      // Business outcome takes precedence over "the checkpoint failed". This ordering is
      // the whole point: reaching the search page with "No member found" is a correct
      // answer to a lookup, not a broken step.
      const outcome = obs && detectBusinessOutcome(artifact, obs);
      if (outcome) return finishOutcome(outcome, artifact, outputs, trace, evidence, started, log);

      const rec = obs && detectRecovery(artifact, obs);
      if (rec && underAttemptLimit(recoveryAttempts, rec)) {
        recoveryCode = rec.code;
        stepStatus = "recovered";
        log.info("recovery.apply", { stepId: step.id, code: rec.code, remedy: rec.remedy.kind });
        await applyRecovery(rec, opts.surface, log);
        continue;
      }

      if (step.optional) {
        stepStatus = "skipped";
        break;
      }

      const r = fail(
        "checkpoint_failed",
        step.id,
        step.checkpoint.description,
        obs ? describeObservation(obs) : "could not observe the surface",
        `Checkpoint failed after ${step.action}: ${step.checkpoint.description}`
      );
      await captureFailure(opts.surface, log, r);
      log.saveResult(r);
      return r;
    }

    trace.push({
      stepId: step.id,
      action: step.action,
      risk: step.risk,
      startedAt: new Date(stepStarted).toISOString(),
      durationMs: Date.now() - stepStarted,
      status: stepStatus,
      recoveryCode,
    });
    log.info("step.done", { stepId: step.id, action: step.action, status: stepStatus });
  }

  /* ---------------------------------------------------------- final checkpoint */
  const successOk = await assertCheckpoint(artifact.successCheckpoint, opts.surface);
  if (!successOk) {
    const obs = await safeObserve(opts.surface);
    const outcome = obs && detectBusinessOutcome(artifact, obs);
    if (outcome) return finishOutcome(outcome, artifact, outputs, trace, evidence, started, log);

    const r = fail(
      "checkpoint_failed",
      null,
      artifact.successCheckpoint.description,
      obs ? describeObservation(obs) : "could not observe the surface",
      "Final success checkpoint did not hold"
    );
    await captureFailure(opts.surface, log, r);
    log.saveResult(r);
    return r;
  }

  /* ---------------------------------------------------------- declared outputs */
  const missing = artifact.outputs.filter((o) => outputs[o.name] === undefined).map((o) => o.name);
  if (missing.length > 0) {
    const r = fail(
      "checkpoint_failed",
      null,
      `all declared outputs present: ${artifact.outputs.map((o) => o.name).join(", ")}`,
      `missing: ${missing.join(", ")}`,
      "Capability completed but did not produce its declared outputs"
    );
    await captureFailure(opts.surface, log, r);
    log.saveResult(r);
    return r;
  }

  const ok: ReplayResult = {
    status: "ok",
    capability: artifact.name,
    revision: artifact.revision,
    outputs,
    trace,
    evidence,
    durationMs: Date.now() - started,
  };
  log.info("replay.ok", { outputs: Object.keys(outputs), durationMs: ok.durationMs });
  log.saveResult(ok);
  return ok;
}

/* ==================================================================== helpers */

function validateInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, string | number | boolean>
): string | null {
  for (const p of artifact.inputs) {
    const v = inputs[p.name];
    if (v === undefined || v === "") {
      if (p.required) return `Missing required input "${p.name}" (${p.description})`;
      continue;
    }
    if (p.type === "number" && Number.isNaN(Number(v))) {
      return `Input "${p.name}" must be a number, got "${String(v)}"`;
    }
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) {
      return `Input "${p.name}" does not match required pattern ${p.pattern}`;
    }
  }
  const declared = new Set(artifact.inputs.map((p) => p.name));
  const extra = Object.keys(inputs).filter((k) => !declared.has(k));
  if (extra.length) return `Unknown input(s): ${extra.join(", ")}`;
  return null;
}

function applyOverlay(step: Step, override: Partial<ElementDescriptor> | undefined): Step {
  if (!override || !step.target) return step;
  return { ...step, target: { ...step.target, ...override } as ElementDescriptor };
}

function toTarget(d: ElementDescriptor): ResolveTarget {
  return {
    role: d.role,
    name: d.name,
    nameMatch: d.nameMatch,
    index: d.index,
    within: d.within,
    frame: d.frame,
    fallbacks: d.fallbacks,
  };
}

function resolveValue(
  v: Value | undefined,
  inputs: Record<string, string | number | boolean>
): string {
  if (!v) return "";
  if (v.kind === "literal") return v.value;
  const raw = inputs[v.param];
  if (raw === undefined) throw new Error(`Step references undeclared input "${v.param}"`);
  return String(raw);
}

async function executeStep(
  step: Step,
  artifact: CapabilityArtifact,
  inputs: Record<string, string | number | boolean>,
  outputs: Record<string, string | number | boolean>,
  opts: ReplayOptions,
  log: EvidenceLog,
  overlayBaseUrl?: string
): Promise<void> {
  const { surface, policy } = opts;

  switch (step.action) {
    case "navigate": {
      let url = resolveValue(step.value, inputs);
      // Tenant overlays can move the entry point without re-recording the flow.
      if (overlayBaseUrl && artifact.application.baseUrl) {
        url = url.replace(artifact.application.baseUrl, overlayBaseUrl);
      }
      const verdict = policy.checkUrl(url);
      if (!verdict.allow) throw new Error(`Policy denied navigation: ${verdict.reason}`);
      log.info("step.navigate", { stepId: step.id, url });
      await surface.open(url);
      await surface.waitForSettled(8000);
      return;
    }
    case "click": {
      if (!step.target) throw new Error(`Step ${step.id}: click requires a target`);
      await surface.click(toTarget(step.target));
      await surface.waitForSettled(8000);
      return;
    }
    case "type": {
      if (!step.target) throw new Error(`Step ${step.id}: type requires a target`);
      await surface.type(toTarget(step.target), resolveValue(step.value, inputs));
      return;
    }
    case "press": {
      await surface.press(resolveValue(step.value, inputs) || "Enter");
      await surface.waitForSettled(8000);
      return;
    }
    case "read": {
      if (!step.target) throw new Error(`Step ${step.id}: read requires a target`);
      if (!step.outputKey) throw new Error(`Step ${step.id}: read requires an outputKey`);
      const text = await surface.read(toTarget(step.target));
      const decl = artifact.outputs.find((o) => o.name === step.outputKey);
      outputs[step.outputKey] = decl?.type === "number" ? parseMoney(text) : text;
      log.info("step.read", {
        stepId: step.id,
        outputKey: step.outputKey,
        // Value flows through the redactor via log.event.
        value: outputs[step.outputKey],
      });
      return;
    }
    case "select":
      throw new Error("select is declared in the schema but not implemented on this surface");
    case "wait_for": {
      if (!step.checkpoint) throw new Error(`Step ${step.id}: wait_for requires a checkpoint`);
      return;
    }
  }
}

/** "$8,241.55" -> 8241.55. Declared-number outputs get a number, not a string. */
function parseMoney(text: string): number {
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

async function assertCheckpoint(cp: Checkpoint, surface: Surface): Promise<boolean> {
  const deadline = Date.now() + cp.timeoutMs;
  for (;;) {
    try {
      switch (cp.kind) {
        case "url-matches": {
          const url = await surface.currentLocation();
          if (new RegExp(cp.value ?? "").test(url)) return true;
          break;
        }
        case "text-present": {
          const obs = await surface.observe();
          const hay = [obs.title, ...obs.notices, ...obs.tree.map((n) => `${n.name} ${n.value ?? ""}`)]
            .join(" ")
            .toLowerCase();
          if (hay.includes((cp.value ?? "").toLowerCase())) return true;
          break;
        }
        case "element-visible": {
          if (!cp.descriptor) return false;
          const r = await surface.resolve(toTarget(cp.descriptor));
          if (r.found) return true;
          break;
        }
        case "element-absent": {
          if (!cp.descriptor) return false;
          const r = await surface.resolve(toTarget(cp.descriptor));
          if (!r.found) return true;
          break;
        }
      }
    } catch {
      /* transient; retry until the deadline */
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

/**
 * Business-outcome detection is a cheap synchronous check against the current observation,
 * not another timed wait. By the time we call this we already know the checkpoint failed,
 * and waiting again would just add latency to every not-found lookup.
 */
function detectBusinessOutcome(artifact: CapabilityArtifact, obs: Observation) {
  for (const rule of artifact.businessOutcomes) {
    if (matchesObservation(rule.detect, obs)) return rule;
  }
  return undefined;
}

function detectRecovery(artifact: CapabilityArtifact, obs: Observation): RecoveryRule | undefined {
  for (const rule of artifact.recoveries) {
    if (matchesObservation(rule.detect, obs)) return rule;
  }
  return undefined;
}

function matchesObservation(cp: Checkpoint, obs: Observation): boolean {
  switch (cp.kind) {
    case "text-present": {
      const needle = (cp.value ?? "").toLowerCase();
      if (!needle) return false;
      const hay = [obs.title, ...obs.notices, ...obs.tree.map((n) => `${n.name} ${n.value ?? ""}`)]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    }
    case "url-matches":
      return new RegExp(cp.value ?? "").test(obs.location);
    case "element-visible":
      return obs.tree.some(
        (n) =>
          n.role === cp.descriptor?.role &&
          (!cp.descriptor?.name || n.name.includes(cp.descriptor.name))
      );
    case "element-absent":
      return !obs.tree.some(
        (n) =>
          n.role === cp.descriptor?.role &&
          (!cp.descriptor?.name || n.name.includes(cp.descriptor.name))
      );
  }
}

function underAttemptLimit(counts: Map<string, number>, rule: RecoveryRule): boolean {
  const n = (counts.get(rule.code) ?? 0) + 1;
  counts.set(rule.code, n);
  return n <= rule.maxAttempts;
}

async function applyRecovery(rule: RecoveryRule, surface: Surface, log: EvidenceLog): Promise<void> {
  switch (rule.remedy.kind) {
    case "click":
      await surface.click(toTarget(rule.remedy.target));
      await surface.waitForSettled(8000);
      return;
    case "reload":
      await surface.open(await surface.currentLocation());
      await surface.waitForSettled(8000);
      return;
    case "wait":
      log.info("recovery.wait", { ms: rule.remedy.ms });
      await sleep(rule.remedy.ms);
      return;
  }
}

function finishOutcome(
  rule: { code: string; description: string },
  artifact: CapabilityArtifact,
  outputs: Record<string, string | number | boolean>,
  trace: StepTrace[],
  evidence: { runId: string; logPath: string },
  started: number,
  log: EvidenceLog
): OutcomeResult {
  const r: OutcomeResult = {
    status: "outcome",
    capability: artifact.name,
    revision: artifact.revision,
    code: rule.code,
    description: rule.description,
    outputs,
    trace,
    evidence,
    durationMs: Date.now() - started,
  };
  log.info("replay.business_outcome", { code: rule.code, description: rule.description });
  log.saveResult(r);
  return r;
}

async function escalate(
  artifact: CapabilityArtifact,
  stepId: string,
  reason: string,
  opts: ReplayOptions,
  log: EvidenceLog,
  trace: StepTrace[],
  started: number,
  evidence: { runId: string; logPath: string }
): Promise<ReplayResult> {
  const shot = log.screenshotPath("escalation");
  await opts.surface.screenshot(shot);
  const obs = await safeObserve(opts.surface);
  if (obs) log.saveObservation(obs, "escalation");

  const req = await opts.escalation!.raise({
    capability: artifact.name,
    revision: artifact.revision,
    stepId,
    reason,
    runId: log.runId,
    location: obs?.location ?? "",
    screenshotPath: shot,
  });

  log.warn("escalation.raised", { interventionId: req.id, reason, handoffUrl: req.handoffUrl });

  const result: ReplayResult = {
    status: "escalated",
    capability: artifact.name,
    revision: artifact.revision,
    interventionId: req.id,
    reason,
    stepId,
    handoffUrl: req.handoffUrl,
    trace,
    evidence: { ...evidence, screenshotPath: shot },
    durationMs: Date.now() - started,
  };
  log.saveResult(result);
  return result;
}

async function safeObserve(surface: Surface): Promise<Observation | undefined> {
  try {
    return await surface.observe();
  } catch {
    return undefined;
  }
}

async function captureFailure(surface: Surface, log: EvidenceLog, r: FailedResult): Promise<void> {
  const shot = log.screenshotPath("failure");
  await surface.screenshot(shot);
  const obs = await safeObserve(surface);
  if (obs) log.saveObservation(obs, "failure");
  (r.evidence as { screenshotPath?: string }).screenshotPath = shot;
  log.error("replay.failed", {
    failure: r.failure,
    stepId: r.stepId,
    expected: r.expected,
    observed: r.observed,
  });
}

function describeObservation(obs: Observation): string {
  const notices = obs.notices.length ? ` notices=[${obs.notices.join(" | ")}]` : "";
  const heads = obs.tree
    .filter((n) => n.role === "heading")
    .slice(0, 3)
    .map((n) => n.name)
    .join(" / ");
  return `at ${obs.location} title="${obs.title}"${heads ? ` headings=[${heads}]` : ""}${notices}`;
}

function describeDescriptor(d: ElementDescriptor): string {
  return describeTarget(toTarget(d));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
