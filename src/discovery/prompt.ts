/**
 * The discovery prompt.
 *
 * The model is given a control list, not a page. This is the most important decision in the
 * whole discovery path: the model can only reference controls the replay engine can also
 * resolve, because they are looking at the same representation. Show it HTML and it will
 * reach for CSS selectors, and the resulting artifact will not survive a re-render, let
 * alone a desktop surface.
 *
 * The prompt is also where parameterisation is established. The model is told which values
 * are parameters and instructed to type them verbatim, so the recorder can match the typed
 * text back to the parameter with certainty instead of inferring it afterwards.
 */

import type { InputParam, OutputField } from "../domain/artifact.js";
import type { Observation } from "../surface/surface.js";

export const SYSTEM_PROMPT = `You operate a business application the way a human operator would, by reading the controls on screen and acting on them.

You will be shown a screenshot plus numbered CANDIDATE CONTROLS described by accessibility role and visible label. Use the screenshot to understand layout and state, but you may only act through a candidate ID. You cannot see HTML, CSS, or element IDs, and you must not invent them.

Respond with EXACTLY ONE JSON object and nothing else. No prose, no markdown fences.

Shape:
{
  "action": "click" | "type" | "press" | "read" | "navigate" | "done" | "give_up",
  "reason": "one short sentence on why this is the right next action",
  "target": { "candidateId": "e001", "role": "...", "name": "...", "nameMatch": "exact" | "contains", "frame": "...", "within": { "role": "...", "name": "..." } },
  "text": "text to type, key to press, or url to navigate to",
  "outputKey": "for read: which declared output this fills",
  "successText": "for done: a distinctive phrase on screen that proves the goal was reached"
}

Rules:
- "target.candidateId" must be copied from the CANDIDATE CONTROLS list. Runtime resolution ignores invented coordinates and only permits one of these IDs.
- "target.role" and "target.name" must match that candidate exactly.
- Copy "frame" from the control's frame value in the list. Frames matter; this app uses them.
- Use "within" when the same label appears more than once and you need to scope it.
  "within": { "role": "row", "hasText": "SAVINGS" } means "inside the row that mentions SAVINGS".
  This is how you address a value in a table: scope to the row that contains a stable word,
  then match the cell you want. Do not rely on position or on the row's full text, because
  that text contains the very value you are trying to read and will differ for other records.
- When typing a value that came from the PARAMETERS list, type it verbatim. Do not reformat, pad, or abbreviate it.
- Use "read" to capture a value the goal asks you to return, and set "outputKey" to the declared output name.
- One action per response. Take the smallest sensible step and look again.
- Prefer the most direct route. Do not explore.
- If you have satisfied the goal, respond with "done" and give "successText": a phrase visible on
  the current screen that a later automated check could look for.
  It must be a LABEL, not DATA. It must NOT contain any name, number, balance, date, account
  number or ID belonging to this particular record, because the same capability will later run
  for different records. A section heading is usually the right answer.
- If you are blocked, stuck in a loop, or the goal cannot be met, respond with "give_up" and explain why in "reason".
- Some controls are refused for safety. If you are told an action was refused, do not retry it; choose another path or finish.`;

export interface ObservationPromptInput {
  goal: string;
  observation: Observation;
  inputs: InputParam[];
  inputValues: Record<string, string>;
  outputs: OutputField[];
  stepNumber: number;
  maxSteps: number;
  actionsSoFar: string[];
}

export const MAX_PROMPT_CANDIDATES = 90;

const ACTIONABLE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "menuitem", "option", "radio",
  "searchbox", "slider", "spinbutton", "switch", "tab", "textbox",
]);

export function renderObservation(i: ObservationPromptInput): string {
  const eligible = i.observation.tree.filter((n) => n.name || n.value);
  const indexed = eligible.map((node) => ({ node, originalIndex: i.observation.tree.indexOf(node) }));
  const prioritized = [
    ...indexed.filter(({ node }) => node.focusable || ACTIONABLE_ROLES.has(node.role)),
    ...indexed.filter(({ node }) => !node.focusable && !ACTIONABLE_ROLES.has(node.role)),
  ];
  const shown = prioritized.slice(0, MAX_PROMPT_CANDIDATES);
  const controls = shown
    .map(({ node: n, originalIndex }) => {
      const bits = [`role=${n.role}`, `name="${n.name}"`];
      if (n.value) bits.push(`value="${n.value}"`);
      if (n.disabled) bits.push("disabled");
      bits.push(`frame=${n.frame}`);
      return `  - [e${String(originalIndex + 1).padStart(3, "0")}] ${bits.join(" ")}`;
    })
    .join("\n");
  const budget = shown.length < eligible.length
    ? `\nCANDIDATE BUDGET: showing ${shown.length} of ${eligible.length}; ${eligible.length - shown.length} informational nodes omitted.`
    : `\nCANDIDATE BUDGET: showing all ${shown.length} candidates.`;

  const params = i.inputs
    .map((p) => `  - ${p.name} (${p.type}) = ${JSON.stringify(i.inputValues[p.name] ?? "")}  — ${p.description}`)
    .join("\n");

  const outs = i.outputs.map((o) => `  - ${o.name} (${o.type}) — ${o.description}`).join("\n");

  const notices = i.observation.notices.length
    ? `\nON-SCREEN MESSAGES:\n${i.observation.notices.map((n) => `  - ${n}`).join("\n")}`
    : "";

  const done = i.actionsSoFar.length
    ? `\nACTIONS ALREADY TAKEN:\n${i.actionsSoFar.map((a, n) => `  ${n + 1}. ${a}`).join("\n")}`
    : "";

  return `GOAL: ${i.goal}

PARAMETERS (type these verbatim where the flow asks for them):
${params || "  (none)"}

OUTPUTS TO CAPTURE (use "read" with the matching outputKey):
${outs || "  (none)"}

STEP ${i.stepNumber} of ${i.maxSteps}
CURRENT LOCATION: ${i.observation.location}
PAGE TITLE: ${i.observation.title}${notices}${done}

CANDIDATE CONTROLS:
${controls || "  (no interactive controls detected)"}${budget}

What is the single next action?`;
}
