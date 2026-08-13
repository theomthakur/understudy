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

export interface DiscoveryInput {
  goal: string;
  startUrl: string;
  /** Declared up front so the recorder can parameterise, not guess. */
  inputs: InputParam[];
  outputs: OutputField[];
  /** Concrete values used for this discovery run. */
  inputValues: Record<string, string>;
  maxSteps?: number;
}

/** What the model returned, after validation. */
export interface ProposedAction {
  action: "click" | "type" | "press" | "read" | "navigate" | "done" | "give_up";
  reason: string;
  target?: {
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
}

export async function discover(
  input: DiscoveryInput,
  deps: { surface: Surface; policy: PolicyEngine; llm: LlmClient; log: EvidenceLog }
): Promise<DiscoveryResult> {
  const { surface, policy, llm, log } = deps;
  const maxSteps = input.maxSteps ?? Math.min(policy.config.maxSteps, 18);
  const actions: RecordedAction[] = [];
  const history: LlmMessage[] = [];

  log.info("discovery.start", { goal: input.goal, startUrl: input.startUrl, model: llm.modelId });

  const urlVerdict = policy.checkUrl(input.startUrl);
  if (!urlVerdict.allow) {
    log.error("policy.denied_start_url", { reason: urlVerdict.reason });
    return { success: false, goal: input.goal, actions, reason: urlVerdict.reason, model: llm.modelId };
  }

  await surface.open(input.startUrl);
  await surface.waitForSettled(8000);

  for (let i = 0; i < maxSteps; i++) {
    const obs = await surface.observe();
    log.saveObservation(obs, `step${String(i).padStart(2, "0")}`);

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

    const raw = await llm.complete(SYSTEM_PROMPT, history);
    history.push({ role: "assistant", content: raw });

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
      target: proposed.target?.name,
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
    const target = proposed.target ? toResolveTarget(proposed.target) : undefined;
    let strategy: string | undefined;
    let matchCount: number | undefined;
    let readValue: string | undefined;

    try {
      if (target) {
        const r = await surface.resolve(target);
        strategy = r.strategy;
        matchCount = r.matchCount;
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
          break;
      }
      await surface.waitForSettled(8000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

  log.warn("discovery.max_steps", { maxSteps });
  return {
    success: false,
    goal: input.goal,
    actions,
    reason: `Reached the step budget (${maxSteps}) without completing the goal`,
    model: llm.modelId,
  };
}

/* ---------------------------------------------------------------- validation */

const ACTIONS = new Set(["click", "type", "press", "read", "navigate", "done", "give_up"]);

function validateProposal(v: unknown): ProposedAction {
  if (!v || typeof v !== "object") throw new Error("Expected a JSON object.");
  const o = v as Record<string, unknown>;
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
