/**
 * The discovery agent: observe → decide → act, with a model in the loop.
 *
 * This runs once per capability. It is the expensive, slow, non-deterministic path, and
 * everything about its design assumes that: it is heavily constrained, every action goes
 * through the same policy engine replay uses, and its output is not the answer but a
 * *recording* that becomes the answer.
 *
 * Three constraints worth calling out:
 *
 * 1. The model never sees HTML. It sees the same accessibility-tree observation the replay
 *    engine works from. That is not a token-saving trick — it means the model can only
 *    describe controls in terms the replay engine can also resolve. If the model could see
 *    CSS, it would reference CSS, and the artifact would be unreplayable on a surface that
 *    has none.
 *
 * 2. The model proposes; the policy engine disposes. Every proposed action is checked before
 *    execution, with the same PolicyEngine used in production. A model that decides to click
 *    "Confirm and Open" during discovery gets stopped by the same gate that would stop it at
 *    replay time.
 *
 * 3. Parameterisation is decided at record time, not inferred later. The agent is told which
 *    input values are parameters, so when it types "12345" the recorder knows that was the
 *    memberId parameter rather than a literal. Guessing this after the fact is where naive
 *    record-and-replay systems produce artifacts that only work for one input.
 */

import type { InputParam, OutputField, Risk } from "../domain/artifact.js";
import { PolicyEngine } from "../policy/policy.js";
import type { Observation, ResolveTarget, Surface } from "../surface/surface.js";
import type { EvidenceLog } from "../evidence/logger.js";
import { extractJson, type LlmClient, type LlmMessage } from "./llm.js";
import { SYSTEM_PROMPT, renderObservation } from "./prompt.js";
import type { EscalationBroker } from "../escalation/escalation.js";
import { createHash } from "node:crypto";

export interface DiscoveryInput {
  goal: string;
  startUrl: string;
  /** Declared up front so the recorder can parameterise, not guess. */
  inputs: InputParam[];
  outputs: OutputField[];
  /** Concrete values used for this discovery run. */
  inputValues: Record<string, string>;
  maxSteps?: number;
  /** Wall-clock budget for the complete observe/decide/act run. */
  maxRunMs?: number;
}

/** What the model returned, after validation. */
export interface ProposedAction {
  action: "click" | "type" | "press" | "read" | "navigate" | "done" | "give_up";
  reason: string;
  target?: {
    candidateId: string;
    role: string;
    name?: string;
    nameMatch?: "exact" | "contains";
    frame?: string;
    within?: { role: string; name?: string; hasText?: string };
  };
  text?: string;
  /** For read: which declared output this satisfies. */
  outputKey?: string;
  /** For done: how a replay should verify it got here. */
  successText?: string;
}

/** One executed step, kept in order. The recorder turns these into artifact steps. */
export interface RecordedAction {
  index: number;
  proposed: ProposedAction;
  /** Resolved target as actually executed, including the frame we found it in. */
  executedTarget?: ResolveTarget;
  /** Which resolution strategy won. Weak strategies are a signal the artifact is fragile. */
  strategy?: string;
  matchCount?: number;
  risk: Risk;
  /** Literal text typed, before parameterisation. */
  typedText?: string;
  readValue?: string;
  observationAfter: { location: string; title: string; notices: string[] };
}

export interface DiscoveryResult {
  success: boolean;
  goal: string;
  actions: RecordedAction[];
  /** Set when the model declared done. */
  successText?: string;
  finalObservation?: Observation;
  reason?: string;
  model: string;
  interventionId?: string;
}

export async function discover(
  input: DiscoveryInput,
  deps: {
    surface: Surface;
    policy: PolicyEngine;
    llm: LlmClient;
    log: EvidenceLog;
    escalation?: EscalationBroker;
    /** Zero records the intervention and returns; positive values allow operator resume. */
    escalationWaitMs?: number;
  }
): Promise<DiscoveryResult> {
  const { surface, policy, llm, log } = deps;
  surface.setNavigationGuard((url) => policy.checkUrl(url));
  let maxSteps = input.maxSteps ?? Math.min(policy.config.maxSteps, 18);
  const maxRunMs = Math.max(1, input.maxRunMs ?? policy.config.maxRunMs);
  const startedAt = Date.now();
  const actions: RecordedAction[] = [];
  const history: LlmMessage[] = [];
  let previousLocation: string | undefined;
  let previousActionCount = 0;
  let stalledIterations = 0;
  let lastObservation: Observation | undefined;

  log.info("discovery.start", { goal: input.goal, startUrl: input.startUrl, model: llm.modelId, runId: log.runId });

  const urlVerdict = policy.checkUrl(input.startUrl);
  if (!urlVerdict.allow) {
    log.error("policy.denied_start_url", { reason: urlVerdict.reason });
    return { success: false, goal: input.goal, actions, reason: urlVerdict.reason, model: llm.modelId };
  }

  await surface.open(input.startUrl);
  await surface.waitForSettled(8000);

  for (let i = 0; ; i++) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= maxRunMs) {
      const reason = `Reached the discovery time budget (${maxRunMs}ms) without completing the goal`;
      log.warn("discovery.timeout", { maxRunMs, elapsedMs, step: i + 1 });
      return { success: false, goal: input.goal, actions, reason, model: llm.modelId };
    }
    if (i >= maxSteps) {
      log.warn("discovery.max_steps", { maxSteps });
      const reason = `Reached the step budget (${maxSteps}) without completing the goal`;
      if (!deps.escalation) {
        return { success: false, goal: input.goal, actions, reason, model: llm.modelId };
      }
      const obs = lastObservation ?? await surface.observe();
      const raised = await escalateDiscovery(input, reason, i, obs, deps);
      if (!raised.resumed) {
        return { success: false, goal: input.goal, actions, reason, model: llm.modelId, interventionId: raised.interventionId };
      }
      history.push({ role: "user", content: "An operator adjusted the application state. Re-observe and continue." });
      // A human intervention buys a small, bounded continuation rather than resetting the
      // original budget. Repeated exhaustion requires another explicit intervention.
      maxSteps += 3;
      stalledIterations = 0;
    }
    const obs = await surface.observe();
    lastObservation = obs;
    log.saveObservation(obs, `step${String(i).padStart(2, "0")}`);
    log.info("discovery.observed", {
      step: i + 1,
      location: obs.location,
      title: obs.title,
      candidateCount: obs.tree.length,
      noticeCount: obs.notices.length,
    });

    if (previousLocation !== undefined) {
      const progressed = actions.length > previousActionCount || obs.location !== previousLocation;
      stalledIterations = progressed ? 0 : stalledIterations + 1;
      if (stalledIterations >= 3 && deps.escalation) {
        const raised = await escalateDiscovery(
          input, `No successful action or location change for ${stalledIterations} observations`, i + 1, obs, deps
        );
        if (!raised.resumed) {
          return { success: false, goal: input.goal, actions, reason: raised.reason, model: llm.modelId, interventionId: raised.interventionId };
        }
        history.push({ role: "user", content: "An operator adjusted the application state. Re-observe and continue." });
        stalledIterations = 0;
      }
    }
    previousLocation = obs.location;
    previousActionCount = actions.length;

    history.push({
      role: "user",
      content: renderObservation({
        goal: input.goal,
        observation: obs,
        inputs: input.inputs,
        inputValues: input.inputValues,
        outputs: input.outputs,
        stepNumber: i + 1,
        maxSteps,
        actionsSoFar: actions.map((a) => `${a.proposed.action} ${a.proposed.target?.name ?? ""}`.trim()),
      }),
    });

    const screen = await surface.screenshotBuffer();
    log.info("discovery.model_invoked", {
      step: i + 1,
      model: llm.modelId,
      screenshotSha256: createHash("sha256").update(screen).digest("hex"),
      candidateCount: obs.tree.length,
    });
    const raw = await llm.complete(SYSTEM_PROMPT, history, { mimeType: "image/png", data: screen });
    history.push({ role: "assistant", content: raw });
    const elapsedAfterModelMs = Date.now() - startedAt;
    if (elapsedAfterModelMs >= maxRunMs) {
      const reason = `Reached the discovery time budget (${maxRunMs}ms) without completing the goal`;
      log.warn("discovery.timeout", { maxRunMs, elapsedMs: elapsedAfterModelMs, step: i + 1, phase: "model" });
      return { success: false, goal: input.goal, actions, reason, model: llm.modelId };
    }

    let proposed: ProposedAction;
    try {
      proposed = validateProposal(extractJson(raw));
    } catch (e) {
      log.warn("discovery.bad_proposal", { detail: String(e), raw: raw.slice(0, 300) });
      history.push({
        role: "user",
        content: `That was not a valid action object. ${String(e)} Reply with a single JSON object only.`,
      });
      continue;
    }

    log.info("discovery.proposed", {
      step: i + 1,
      action: proposed.action,
      targetCandidate: proposed.target?.candidateId,
      targetRole: proposed.target?.role,
      reason: proposed.reason,
    });

    if (proposed.action === "done") {
      const finalObs = await surface.observe();
      log.info("discovery.done", { reason: proposed.reason });
      return {
        success: true,
        goal: input.goal,
        actions,
        successText: proposed.successText,
        finalObservation: finalObs,
        model: llm.modelId,
      };
    }
    if (proposed.action === "give_up") {
      log.warn("discovery.gave_up", { reason: proposed.reason });
      if (deps.escalation) {
        const raised = await escalateDiscovery(input, proposed.reason, i + 1, obs, deps);
        if (raised.resumed) {
          history.push({ role: "user", content: "An operator adjusted the application state. Re-observe and continue." });
          stalledIterations = 0;
          continue;
        }
        return { success: false, goal: input.goal, actions, reason: raised.reason, model: llm.modelId, interventionId: raised.interventionId };
      }
      return { success: false, goal: input.goal, actions, reason: proposed.reason, model: llm.modelId };
    }

    /* ---------------------------------------------------- policy, same engine as replay */
    const actionVerdict = policy.checkAction(proposed.action);
    if (!actionVerdict.allow) {
      history.push({ role: "user", content: `Refused: ${actionVerdict.reason}. Choose a different action.` });
      log.warn("policy.action_denied", { action: proposed.action, reason: actionVerdict.reason });
      continue;
    }

    const risk = PolicyEngine.classifyRisk(proposed.action, proposed.target?.name);
    // Discovery is attended by definition — a person kicked it off and is watching — but
    // irreversible actions still stop, because "the operator was watching" is not consent
    // to open an account.
    const riskVerdict = policy.checkRisk(risk, { approved: false, attended: false });
    if (!riskVerdict.allow && risk === "irreversible") {
      log.warn("policy.irreversible_blocked_in_discovery", {
        control: proposed.target?.name,
        reason: riskVerdict.reason,
      });
      history.push({
        role: "user",
        content:
          `Refused: "${proposed.target?.name}" is classified irreversible and cannot be performed during discovery. ` +
          `If the goal is complete up to that point, respond with action "done". Otherwise choose a non-destructive path.`,
      });
      continue;
    }

    /* ---------------------------------------------------- execute */
    const target = proposed.target ? toResolveTarget(resolveCandidate(proposed.target, obs)) : undefined;
    let strategy: string | undefined;
    let matchCount: number | undefined;
    let readValue: string | undefined;

    try {
      if (target) {
        const r = await surface.resolve(target);
        strategy = r.strategy;
        matchCount = r.matchCount;
        if (r.bounds) target.recordedBounds = r.bounds;
        if (!r.found) {
          history.push({
            role: "user",
            content: `No control matched role="${target.role}" name="${target.name ?? ""}". Look at the control list again and pick one that is listed.`,
          });
          log.warn("discovery.target_not_found", { role: target.role, name: target.name });
          continue;
        }
        if (r.matchCount > 1) {
          // Recorded rather than silently accepted: an ambiguous descriptor is exactly the
          // kind of thing that replays fine today and breaks when a row is added.
          log.warn("discovery.ambiguous_target", {
            role: target.role,
            name: target.name,
            matchCount: r.matchCount,
          });
        }
      }

      switch (proposed.action) {
        case "navigate": {
          const url = proposed.text ?? "";
          const v = policy.checkUrl(url);
          if (!v.allow) {
            history.push({ role: "user", content: `Refused: ${v.reason}` });
            continue;
          }
          await surface.open(url);
          break;
        }
        case "click":
          await surface.click(target!);
          break;
        case "type":
          await surface.type(target!, proposed.text ?? "");
          break;
        case "press":
          await surface.press(proposed.text || "Enter");
          break;
        case "read":
          readValue = await surface.read(target!);
          if (input.outputs.find((output) => output.name === proposed.outputKey)?.sensitive) {
            log.addSecret(readValue);
          }
          break;
      }
      await surface.waitForSettled(8000);
      await surface.assertPolicyBoundary();
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try {
        await surface.assertPolicyBoundary();
      } catch (boundary) {
        msg = boundary instanceof Error ? boundary.message : String(boundary);
      }
      log.warn("discovery.action_failed", { action: proposed.action, detail: msg });
      history.push({ role: "user", content: `That action failed: ${msg}. Try a different approach.` });
      continue;
    }

    const after = await surface.observe();
    actions.push({
      index: actions.length,
      proposed,
      executedTarget: target,
      strategy,
      matchCount,
      risk,
      typedText: proposed.action === "type" ? proposed.text : undefined,
      readValue,
      observationAfter: { location: after.location, title: after.title, notices: after.notices },
    });
    log.info("discovery.executed", {
      step: i + 1,
      action: proposed.action,
      strategy,
      matchCount,
      location: after.location,
    });
  }

}

async function escalateDiscovery(
  input: DiscoveryInput,
  reason: string,
  step: number,
  observation: Observation,
  deps: {
    surface: Surface;
    log: EvidenceLog;
    escalation?: EscalationBroker;
    escalationWaitMs?: number;
  }
): Promise<{ resumed: boolean; reason: string; interventionId: string }> {
  const shot = deps.log.screenshotPath(`discovery-escalation-${step}`);
  await deps.surface.screenshot(shot);
  const request = await deps.escalation!.raise({
    capability: `discovery:${input.goal.slice(0, 72)}`,
    revision: 0,
    stepId: `discovery-${step}`,
    reason,
    runId: deps.log.runId,
    location: observation.location,
    screenshotPath: shot,
  });
  deps.log.warn("discovery.escalated", {
    interventionId: request.id,
    step,
    reason,
    observation: { location: observation.location, title: observation.title, candidateCount: observation.tree.length },
  });
  const waitMs = deps.escalationWaitMs ?? 0;
  if (waitMs <= 0) return { resumed: false, reason, interventionId: request.id };
  const settled = await deps.escalation!.waitForRelease(request.id, waitMs);
  if (settled.state === "released") {
    deps.log.info("discovery.escalation_resumed", { interventionId: request.id, step });
    return { resumed: true, reason, interventionId: request.id };
  }
  return { resumed: false, reason, interventionId: request.id };
}

/* ---------------------------------------------------------------- validation */

const ACTIONS = new Set(["click", "type", "press", "read", "navigate", "done", "give_up"]);

/**
 * Strict structured output requires every field to be present, so absent fields arrive as
 * explicit nulls. Normalising them here keeps the rest of the code free of null checks that
 * only exist because of a provider's schema dialect.
 */
function denull(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v)
      ? denull(v as Record<string, unknown>)
      : v;
  }
  return out;
}

function validateProposal(raw: unknown): ProposedAction {
  if (!raw || typeof raw !== "object") throw new Error("Expected a JSON object.");
  const o = denull(raw as Record<string, unknown>);
  const action = String(o.action ?? "");
  if (!ACTIONS.has(action)) {
    throw new Error(`Unknown action "${action}". Allowed: ${[...ACTIONS].join(", ")}.`);
  }
  const p: ProposedAction = {
    action: action as ProposedAction["action"],
    reason: String(o.reason ?? ""),
  };
  if (o.target && typeof o.target === "object") {
    const t = o.target as Record<string, unknown>;
    if (!t.role) throw new Error("target.role is required when a target is given.");
    p.target = {
      candidateId: String(t.candidateId ?? ""),
      role: String(t.role),
      name: t.name === undefined ? undefined : String(t.name),
      nameMatch: t.nameMatch === "contains" ? "contains" : "exact",
      frame: t.frame === undefined ? undefined : String(t.frame),
      within:
        t.within && typeof t.within === "object"
          ? (() => {
              const w = t.within as Record<string, unknown>;
              return {
                role: String(w.role ?? ""),
                name: w.name === undefined ? undefined : String(w.name),
                hasText: w.hasText === undefined ? undefined : String(w.hasText),
              };
            })()
          : undefined,
    };
  }
  if (p.target && !/^e\d{3}$/.test(p.target.candidateId)) {
    throw new Error("target.candidateId must be a listed candidate such as e001.");
  }
  if (o.text !== undefined) p.text = String(o.text);
  if (o.outputKey !== undefined) p.outputKey = String(o.outputKey);
  if (o.successText !== undefined) p.successText = String(o.successText);

  if ((p.action === "click" || p.action === "type" || p.action === "read") && !p.target) {
    throw new Error(`Action "${p.action}" requires a target.`);
  }
  if (p.action === "type" && p.text === undefined) throw new Error(`"type" requires text.`);
  if (p.action === "read" && !p.outputKey) throw new Error(`"read" requires outputKey.`);
  return p;
}

function resolveCandidate(target: NonNullable<ProposedAction["target"]>, observation: Observation): NonNullable<ProposedAction["target"]> {
  const index = Number(target.candidateId.slice(1)) - 1;
  const candidate = observation.tree[index];
  if (!candidate) throw new Error(`Candidate ${target.candidateId} is not in the current observation.`);
  return {
    ...target,
    role: candidate.role,
    name: candidate.name,
    nameMatch: "exact",
    frame: candidate.frame,
  };
}

function toResolveTarget(t: NonNullable<ProposedAction["target"]>): ResolveTarget {
  return {
    role: t.role,
    name: t.name,
    nameMatch: t.nameMatch ?? "exact",
    within: t.within,
    frame: t.frame ? { strategy: "name", value: t.frame } : { strategy: "main" },
    fallbacks: [],
  };
}
