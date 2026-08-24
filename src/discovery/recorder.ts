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
import { SCHEMA_VERSION, CapabilityArtifactSchema, computeArtifactHash } from "../domain/artifact.js";
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

  const successCheckpoint = buildSuccessCheckpoint(input, steps);

  const artifact: CapabilityArtifact = {
    schemaVersion: SCHEMA_VERSION,
    name: input.name,
    revision: 1,
    title: input.title,
    description: input.description,
    application: {
      productId: input.productId,
      vendor: "Acme Financial Systems (synthetic)",
      product: "Core Banking Console",
      versionRange: ">=7 <8",
      surface: "legacy-web",
      baseUrl: input.baseUrl,
    },
    policySnapshot: {
      allowedHosts: [new URL(input.baseUrl).hostname],
      allowedPathPrefixes: ["/"],
      allowedActions: ["navigate", "click", "type", "press", "read", "wait_for"],
      irreversiblePolicy: "escalate",
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
  const parsed = CapabilityArtifactSchema.parse(artifact);
  const artifactHash = computeArtifactHash(parsed);
  return CapabilityArtifactSchema.parse({ ...parsed, artifactHash });
}


/* ---------------------------------------------------------------- success marker */

/**
 * Choosing a durable success marker.
 *
 * The model is asked for "a distinctive phrase that proves the goal was reached", and on a
 * record screen the most distinctive thing visible is the record itself. In a real run it
 * chose a composite account-row value — genuinely distinctive, and specific to one
 * member, so the capability succeeded for the member it was recorded on and failed for
 * everyone else.
 *
 * This is the same failure as a value-shaped read target, one layer up, and it is worth
 * stating the general rule: **anything the model chooses by looking at the screen has to be
 * checked against the inputs and outputs of this particular run before it is frozen into a
 * capability.** The model cannot make that check, because it only ever sees one record.
 *
 * So: reject a marker that contains an input value, an extracted output, or a run of digits
 * that suggests record data, and fall back to something structural — a digit-free heading
 * from the final screen, or failing that the final URL.
 */
function buildSuccessCheckpoint(input: RecordInput, steps: Step[]): Checkpoint {
  const proposed = input.discovery.successText?.trim();
  const rejection = proposed ? volatileReason(proposed, input) : "no marker was captured";

  if (proposed && !rejection) {
    return {
      kind: "text-present",
      value: proposed,
      timeoutMs: 10_000,
      description: `Goal reached: "${proposed}" is visible`,
    };
  }

  // Fallback 1: a heading with no digits in it. Headings are labels, not data.
  const heading = input.discovery.finalObservation?.tree.find(
    (n) => n.role === "heading" && n.name && !/\d/.test(n.name)
  );
  if (heading) {
    return {
      kind: "text-present",
      value: heading.name,
      timeoutMs: 10_000,
      description:
        `Goal reached: heading "${heading.name}" is visible ` +
        `(recorder: the model's marker was rejected — ${rejection})`,
    };
  }

  // Fallback 2: the last checkpoint we already trust.
  const lastWithCheckpoint = [...steps].reverse().find((s) => s.checkpoint);
  if (lastWithCheckpoint?.checkpoint) {
    return {
      ...lastWithCheckpoint.checkpoint,
      description:
        `${lastWithCheckpoint.checkpoint.description} ` +
        `(recorder: reused as the success marker — ${rejection})`,
    };
  }

  return {
    kind: "url-matches",
    value: ".*",
    timeoutMs: 5_000,
    description: `Flow completed, but no durable success marker was available (${rejection})`,
  };
}

/** Returns why a marker is unsafe to freeze, or null if it is fine. */
function volatileReason(text: string, input: RecordInput): string | null {
  for (const [name, value] of Object.entries(input.inputValues)) {
    if (value && text.includes(value)) {
      return `it contains the input value for "${name}", so it would only match this record`;
    }
  }
  for (const a of input.discovery.actions) {
    if (a.readValue && a.readValue.length > 2 && text.includes(a.readValue)) {
      return `it contains a value this run extracted, which varies per record`;
    }
  }
  if (/[$£€]\s?[\d,]+(\.\d{1,2})?/.test(text)) return "it contains a currency amount";
  if (/\d{3,}/.test(text)) return "it contains a long digit run, which suggests record data";
  return null;
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
        target: target!,
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
        target: target!,
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

    case "read": {
      const g = target ? generaliseVolatileName(target) : { descriptor: undefined, note: undefined };
      return {
        id,
        action: "read",
        target: g.descriptor!,
        outputKey: a.proposed.outputKey!,
        risk: "safe",
        optional: false,
        discoveredBecause: g.note
          ? `${a.proposed.reason} [recorder: ${g.note}]`
          : a.proposed.reason,
      };
    }
  }
  return undefined;
}

/**
 * Volatile-value detection, and why the recorder owns it.
 *
 * A discovery model identifies a control by what it can see, and on a data cell what it can
 * see IS the data. In a real run the model targeted the savings balance as
 * a literal currency cell — correct for the member it was looking at, useless for every other
 * member. That is the classic record-and-replay failure: recording a value instead of a
 * locator. It passes the run that created it and fails the first run that matters.
 *
 * Catching it is the recorder's job, not the model's. The model's contribution is *which*
 * thing to read and *where* it sits; deciding how to address that durably is a recording
 * decision. So when a read target's name looks like data rather than a label, we keep the
 * structural part of the descriptor — crucially the `within` scope, which is what actually
 * identifies the row — and relax the name from an exact literal to the shape of the value.
 *
 * Deliberately narrow. It only fires on `read` targets and only for shapes that are
 * unambiguously data. Generalising a genuine label would be a worse bug than the one this
 * fixes.
 */
const VOLATILE_SHAPES: { name: string; test: RegExp; pattern: string }[] = [
  { name: "currency", test: /^[$£€]\s?-?[\d,]+(\.\d{1,2})?$/, pattern: "^[$£€]\\s?-?[\\d,]+(\\.\\d{1,2})?$" },
  { name: "number", test: /^-?[\d,]+(\.\d+)?$/, pattern: "^-?[\\d,]+(\\.\\d+)?$" },
  { name: "iso-date", test: /^\d{4}-\d{2}-\d{2}$/, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
];

function generaliseVolatileName(
  d: ElementDescriptor
): { descriptor: ElementDescriptor; note?: string } {
  if (!d.name) return { descriptor: d };
  const shape = VOLATILE_SHAPES.find((s) => s.test.test(d.name!));
  if (!shape) return { descriptor: d };

  // A fallback derived from a volatile name is the same record-pinning bug one rung down
  // the ladder: keeping a literal observed currency beneath a generalised primary would freeze
  // this run's record data into the artifact and contradict the generalisation above it.
  const fallbacks = d.fallbacks.filter(
    (fb) => !VOLATILE_SHAPES.some((s) => s.test.test(fb.value))
  );

  if (d.within?.role === "row" && d.within.hasText && shape.name === "currency") {
    return {
      descriptor: {
        ...d,
        name: undefined,
        fallbacks,
        tableCell: { rowLabel: d.within.hasText, columnLabel: "Balance" },
      },
      note: `recorded currency data became the relational cell ${d.within.hasText} × Balance`,
    };
  }

  return {
    descriptor: { ...d, name: shape.pattern, nameMatch: "regex", fallbacks },
    note:
      `recorded name "${d.name}" looked like ${shape.name} data rather than a label, so it was ` +
      `generalised to a ${shape.name} pattern; the row scope is what identifies this cell`,
  };
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
    tableCell: t.tableCell,
    recordedBounds: t.recordedBounds,
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
