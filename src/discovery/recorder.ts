/**
 * Recorder: a successful discovery run becomes a capability artifact.
 *
 * This is not a transcript dump, and the difference is the point of the whole system.
 * A transcript says "the model clicked the thing called Search". An artifact says
 * "this capability takes a memberId, types it into the control labelled Member ID, clicks
 * Search, verifies the member profile heading appears, reads the savings balance, and
 * returns it — and here is what to do when the member does not exist."
 *
 * Four things the recorder adds that the raw run does not contain:
 *
 * 1. Parameterisation. Typed text that matches a declared input value becomes a param
 *    reference. Because the agent was told to type parameters verbatim, this is an exact
 *    match rather than a guess.
 *
 * 2. Checkpoints. Every state-changing action gets an assertion derived from what actually
 *    appeared after it. Without this, replay clicks blindly and reports success for a run
 *    that silently went nowhere.
 *
 * 3. Fallbacks. The primary locator is role+name. The recorder adds a weaker ladder beneath
 *    it, ordered and annotated, so a small relabelling degrades instead of failing.
 *
 * 4. Error handling. Business outcomes and recoveries are attached from a per-application
 *    knowledge base. This is deliberate: the happy-path run never sees "no such member", so
 *    those rules cannot be learned from it. Pretending otherwise would mean shipping
 *    capabilities that only work when nothing goes wrong.
 */

import type {
  BusinessOutcomeRule,
  CapabilityArtifact,
  Checkpoint,
  ElementDescriptor,
  InputParam,
  OutputField,
  RecoveryRule,
  Step,
  TenantOverlay,
} from "../domain/artifact.js";
import { SCHEMA_VERSION, CapabilityArtifactSchema } from "../domain/artifact.js";
import type { DiscoveryResult, RecordedAction } from "./agent.js";
import type { ResolveTarget } from "../surface/surface.js";

export interface RecordInput {
  name: string;
  title: string;
  description: string;
  productId: string;
  baseUrl: string;
  startUrl: string;
  inputs: InputParam[];
  outputs: OutputField[];
  inputValues: Record<string, string>;
  discovery: DiscoveryResult;
  runId: string;
  /** Per-application error knowledge. See the note above on why this is not learned. */
  businessOutcomes?: BusinessOutcomeRule[];
  recoveries?: RecoveryRule[];
  tenantOverlays?: TenantOverlay[];
}

export function record(input: RecordInput): CapabilityArtifact {
  const steps: Step[] = [];

  // Step 0 is always an explicit navigate. The discovery run started with an implicit open,
  // and a capability that depends on the caller already being in the right place is not
  // self-contained.
  steps.push({
    id: "s0",
    action: "navigate",
    value: { kind: "literal", value: input.startUrl },
    risk: "safe",
    optional: false,
    checkpoint: {
      kind: "url-matches",
      value: escapeRegex(new URL(input.startUrl).pathname || "/"),
      timeoutMs: 10_000,
      description: `Entry page ${new URL(input.startUrl).pathname} is loaded`,
    },
    discoveredBecause: "Entry point for the flow",
  });

  input.discovery.actions.forEach((a, i) => {
    const step = toStep(a, i + 1, input);
    if (step) steps.push(step);
  });

  const successCheckpoint: Checkpoint = input.discovery.successText
    ? {
        kind: "text-present",
        value: input.discovery.successText,
        timeoutMs: 10_000,
        description: `Goal reached: "${input.discovery.successText}" is visible`,
      }
    : {
        kind: "url-matches",
        value: ".*",
        timeoutMs: 5_000,
        description: "Flow completed (no distinctive success marker was captured)",
      };

  const artifact: CapabilityArtifact = {
    schemaVersion: SCHEMA_VERSION,
    name: input.name,
    revision: 1,
    title: input.title,
    description: input.description,
    application: {
      productId: input.productId,
      surface: "legacy-web",
      baseUrl: input.baseUrl,
    },
    inputs: input.inputs,
    outputs: input.outputs,
    steps,
    successCheckpoint,
    businessOutcomes: input.businessOutcomes ?? [],
    recoveries: input.recoveries ?? [],
    tenantOverlays: input.tenantOverlays ?? [],
    approval: { state: "draft" },
    provenance: {
      recordedAt: new Date().toISOString(),
      goal: input.discovery.goal,
      model: input.discovery.model,
      discoveryRunId: input.runId,
      stepCount: steps.length,
      transcriptRef: `evidence/runs/${input.runId}/events.jsonl`,
    },
  };

  // Parse rather than cast: a recorder bug should fail here, loudly, not at replay time on
  // someone else's machine.
  return CapabilityArtifactSchema.parse(artifact);
}

/* ---------------------------------------------------------------- step building */

function toStep(a: RecordedAction, n: number, input: RecordInput): Step | undefined {
  const id = `s${n}`;
  const action = a.proposed.action;
  if (action === "done" || action === "give_up") return undefined;

  const target = a.executedTarget ? hardenDescriptor(a.executedTarget) : undefined;

  switch (action) {
    case "navigate":
      return {
        id,
        action: "navigate",
        value: { kind: "literal", value: a.proposed.text ?? "" },
        risk: "safe",
        optional: false,
        checkpoint: locationCheckpoint(a),
        discoveredBecause: a.proposed.reason,
      };

    case "type": {
      const typed = a.typedText ?? "";
      return {
        id,
        action: "type",
        target,
        value: parameterise(typed, input.inputValues),
        risk: a.risk,
        optional: false,
        // No checkpoint: typing does not change page state, and asserting after every
        // keystroke would add seconds to every replay for no safety gain.
        discoveredBecause: a.proposed.reason,
      };
    }

    case "click":
      return {
        id,
        action: "click",
        target,
        risk: a.risk,
        optional: false,
        checkpoint: locationCheckpoint(a),
        discoveredBecause: a.proposed.reason,
      };

    case "press":
      return {
        id,
        action: "press",
        value: { kind: "literal", value: a.proposed.text || "Enter" },
        risk: a.risk,
        optional: false,
        checkpoint: locationCheckpoint(a),
        discoveredBecause: a.proposed.reason,
      };

    case "read":
      return {
        id,
        action: "read",
        target,
        outputKey: a.proposed.outputKey,
        risk: "safe",
        optional: false,
        discoveredBecause: a.proposed.reason,
      };
  }
  return undefined;
}

/**
 * Turn a literal typed value into a parameter reference where it matches a declared input.
 *
 * Exact match only. A substring match would be worse than useless: a member id of "1" would
 * parameterise every "1" in every field on the form.
 */
function parameterise(
  typed: string,
  inputValues: Record<string, string>
): { kind: "literal"; value: string } | { kind: "param"; param: string } {
  for (const [name, value] of Object.entries(inputValues)) {
    if (value !== "" && typed === value) return { kind: "param", param: name };
  }
  return { kind: "literal", value: typed };
}

/**
 * Add the fallback ladder.
 *
 * Order is confidence order, and each rung is annotated so a reviewer can see the system
 * degrading rather than finding a pile of interchangeable selectors. Notably we do NOT
 * record a CSS selector or an id: the target app's ids carry row indexes, so they look
 * stable and are not. Recording one would make replay pass today and fail on the day a row
 * is inserted, which is the worst possible failure mode.
 */
function hardenDescriptor(t: ResolveTarget): ElementDescriptor {
  const fallbacks: ElementDescriptor["fallbacks"] = [];

  if (t.name) {
    fallbacks.push({
      kind: "role-name",
      value: t.name,
      note: "same role, relaxed to substring match — survives a relabel or added suffix",
    });
    if (t.role === "textbox" || t.role === "searchbox" || t.role === "combobox") {
      fallbacks.push({
        kind: "label",
        value: t.name,
        note: "label association — works when the accessible name is computed differently",
      });
    }
    if (t.role === "button" || t.role === "link") {
      fallbacks.push({
        kind: "text",
        value: t.name,
        note: "visible text — last resort, may match non-interactive elements",
      });
    }
  }

  return {
    role: t.role,
    name: t.name,
    nameMatch: t.nameMatch,
    index: t.index,
    within: t.within,
    frame: t.frame,
    fallbacks,
  };
}

/**
 * Derive a checkpoint from what actually appeared after the action.
 *
 * Prefers a URL assertion because it is cheap and unambiguous. Falls back to the page title,
 * which is weaker but still better than assuming the click worked — which is the single most
 * common cause of a replay that reports success having done nothing.
 */
function locationCheckpoint(a: RecordedAction): Checkpoint {
  const loc = a.observationAfter.location;
  try {
    const path = new URL(loc).pathname;
    if (path && path !== "/") {
      return {
        kind: "url-matches",
        value: escapeRegex(path),
        timeoutMs: 10_000,
        description: `Navigated to ${path}`,
      };
    }
  } catch {
    /* not a URL; fall through */
  }
  const title = a.observationAfter.title;
  return {
    kind: "text-present",
    value: title || "",
    timeoutMs: 10_000,
    description: title ? `Page "${title}" is showing` : "Page changed",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
