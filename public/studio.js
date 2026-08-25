const state = {
  view: "overview",
  mode: "discovery",
  running: false,
  discoveryRunning: false,
  handoff: "idle",
  interventionId: null,
  targetOrigin: "/legacy",
};

const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll(".view")];
const navButtons = [...document.querySelectorAll("[data-view]")];
const iframe = $("#legacy-frame");
const runButton = $("#run-capability");
const discoveryGoal = $("#discovery-goal");
const capabilityBox = $("#capability-box");
const inspectDiscovery = $("#inspect-discovery");
const copyDiscovery = $("#copy-discovery");
const discoveryMemberInput = $("#discovery-member-id");
const discoveryCommandPanel = $("#discovery-command-panel");
const discoveryCommandPreview = $("#discovery-command-preview");
const memberInput = $("#member-id");
const timeline = $("#timeline");
const output = $("#run-output");
const surfaceAddress = $("#surface-address");
const surfaceStage = $("#surface-stage");
const toast = $("#toast");

const pageMeta = {
  overview: ["Candidate Project", "Capability overview"],
  studio: ["Working Demo", "Guided demo"],
  evidence: ["Artifact & Evidence", "Proof"],
  interventions: ["Control Transfer", "Human review"],
  decisions: ["Design Rationale", "Design decisions"],
  presentation: ["Guided Walkthrough", "Presentation"],
};

function showView(name) {
  state.view = name;
  views.forEach((view) => view.classList.toggle("active", view.dataset.name === name));
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const meta = pageMeta[name] || pageMeta.overview;
  $(".page-kicker").textContent = meta[0];
  $(".page-title").textContent = meta[1];
  if (name === "overview") history.replaceState(null, "", location.pathname);
  else history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0, behavior: "auto" });
}

navButtons.forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.modeGo) setMode(button.dataset.modeGo);
  showView(button.dataset.go);
}));

function notify(headline, detail) {
  toast.querySelector("strong").textContent = headline;
  toast.querySelector("span").textContent = detail;
  toast.classList.add("visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

document.querySelectorAll(".quick-value[data-value]").forEach((button) => {
  button.addEventListener("click", () => {
    memberInput.value = button.dataset.value;
    memberInput.focus();
  });
});

const replaySteps = [
  ["Open approved entrypoint", "Browser-level origin and route guard enabled"],
  ["Enter invocation parameter", "Resolve Member ID and insert the sensitive input reference"],
  ["Submit member search", "Cross the legacy frameset and verify the member profile"],
  ["Extract savings balance", "Resolve the relational SAVINGS × Balance table cell"],
];

const DISCOVERY_PLANS = {
  balance: {
    steps: [
      ["Observe live surface", "Screenshot and numbered accessibility candidates captured"],
      ["Model chooses input", "Select Member ID from the controls offered by the runtime"],
      ["Model submits search", "The runtime types the sample value and operates Search"],
      ["Read result and compile", "Capture SAVINGS × Balance and build the typed draft"],
    ],
    stages: [
      ["Observing the search screen", "Screenshot captured · 6 accessible controls found", "Observation", "6 controls", "search"],
      ["Model selected Member ID", "Candidate e1 · textbox · parameter memberId", "Model decision", "type(e1, memberId)", "search"],
      ["Runtime submitted the search", "Candidate e2 · button · Member Profile checkpoint", "Action and check", "Profile reached", "profile"],
      ["Recorder compiled the flow", "Literal balance removed · SAVINGS × Balance saved", "Draft capability", "4 replay steps", "profile"],
    ],
  },
  status: {
    steps: [
      ["Observe live surface", "Screenshot and numbered accessibility candidates captured"],
      ["Model chooses input", "Select Member ID from the controls offered by the runtime"],
      ["Model submits search", "The runtime types the sample value and operates Search"],
      ["Read result and compile", "Capture CHECKING × Status and build the typed draft"],
    ],
    stages: [
      ["Observing the search screen", "Screenshot captured · accessible controls numbered", "Observation", "Search controls", "search"],
      ["Model selected Member ID", "Textbox chosen from the constrained candidate list", "Model decision", "type(memberId)", "search"],
      ["Runtime submitted the search", "Member Profile checkpoint confirmed", "Action and check", "Profile reached", "profile"],
      ["Recorder would compile the flow", "CHECKING × Status becomes the typed output target", "Illustrated preview", "4 replay steps", "profile"],
    ],
  },
  subaccount: {
    steps: [
      ["Observe live surface", "Screenshot and numbered accessibility candidates captured"],
      ["Model chooses input", "Select Member ID from the controls offered by the runtime"],
      ["Model submits search", "The runtime types the sample value and operates Search"],
      ["Model finds the guarded action", "Open Sub-Account is classified before it can run"],
      ["Stop and compile", "Save the reversible path and require a person at confirmation"],
    ],
    stages: [
      ["Observing the search screen", "Screenshot captured · accessible controls numbered", "Observation", "Search controls", "search"],
      ["Model selected Member ID", "Textbox chosen from the constrained candidate list", "Model decision", "type(memberId)", "search"],
      ["Runtime submitted the search", "Member Profile checkpoint confirmed", "Action and check", "Profile reached", "profile"],
      ["Risk policy inspected the next action", "Open Sub-Account leads to an irreversible confirmation", "Policy decision", "Human gate required", "profile"],
      ["Recorder would compile the guarded path", "Automation stops before confirmation and transfers control", "Illustrated preview", "Guarded draft", "profile"],
    ],
  },
};

/**
 * Each preset is a complete discovery contract, not just prose. The copied
 * command has to match the goal text, so name, inputs and outputs travel
 * together with it. Only the balance goal has a committed proof run; the
 * other two are honest, runnable goals against the same target that a
 * reviewer has not paid tokens to execute.
 */
const GOAL_PRESETS = {
  balance: {
    label: "Read a savings balance",
    goal: "Look up the member with the given member ID, open their profile, and read the current balance of their SAVINGS account. Capture it as the output 'savingsBalance'.",
    name: "member.read_savings_balance_v2",
    input: "memberId:string:sensitive=^\\d{3,10}$",
    output: "savingsBalance:currency:sensitive",
    contractOutput: "savingsBalance: sensitive currency",
    risk: "Safe",
    proof: true,
    note: "Committed proof exists for this goal. Play the guided run, or open <b>Inspect genuine discovery proof</b> to see the saved model events.",
  },
  status: {
    label: "Check account status",
    goal: "Look up the member with the given member ID, open their profile, and read the status of their CHECKING account. Capture it as the output 'accountStatus'.",
    name: "member.read_checking_status_v1",
    input: "memberId:string:sensitive=^\\d{3,10}$",
    output: "accountStatus:string",
    contractOutput: "accountStatus: string",
    risk: "Safe",
    proof: false,
    note: "A second read-only goal against the same screens. No committed run for this one, so the command is provided rather than a saved artifact.",
  },
  subaccount: {
    label: "Open a sub-account",
    goal: "Look up the member with the given member ID, open their profile, start a new sub-account for them, and continue to the confirmation screen without submitting it.",
    name: "member.open_sub_account_v2",
    input: "memberId:string:sensitive=^\\d{3,10}$",
    output: "",
    contractOutput: "none declared",
    risk: "Irreversible",
    proof: false,
    note: "This one reaches an irreversible step, so policy stops it for a person. That is the handoff shown on the <b>Human review</b> tab.",
  },
};
let activePreset = "balance";

function applyPreset(key) {
  const preset = GOAL_PRESETS[key];
  if (!preset) return;
  activePreset = key;
  discoveryGoal.value = preset.goal;
  $("#goal-example-note").innerHTML = preset.note;
  document.querySelectorAll("#goal-examples .quick-value").forEach((b) => b.classList.toggle("active", b.dataset.goal === key));
  $("#contract-output").textContent = preset.contractOutput;
  const risk = $("#contract-risk");
  risk.textContent = preset.risk;
  risk.className = preset.risk === "Safe" ? "badge success" : "badge warn";
  inspectDiscovery.hidden = !preset.proof || state.mode === "replay";
  discoveryCommandPanel.hidden = true;
  if (state.mode === "discovery" && !state.discoveryRunning) {
    const plan = DISCOVERY_PLANS[key];
    renderTimeline(plan.steps);
    output.className = "output-card";
    output.innerHTML = `<div class="output-label">Ready for discovery walkthrough</div><div class="output-value">${plan.steps.length} stages</div><div class="output-sub">Press Play to see this goal move through the interface</div>`;
  }
}

document.querySelectorAll("#goal-examples .quick-value").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.goal));
});

function renderTimeline(steps, completed = -1, outcomeIndex = -1, trace = []) {
  timeline.innerHTML = steps.map(([name, description], index) => {
    const done = index < completed;
    const stateClass = done ? "complete" : index === completed ? "running" : "";
    const outcomeClass = index === outcomeIndex ? "outcome" : "";
    const duration = trace[index]?.durationMs ? `${trace[index].durationMs}ms` : "";
    const strategy = trace[index]?.detail ? ` · ${trace[index].detail}` : "";
    return `<li class="timeline-step ${stateClass} ${outcomeClass}">
      <div class="timeline-dot">${done ? "✓" : index + 1}</div>
      <div class="timeline-copy"><strong>${name}<span class="timeline-time">${duration}</span></strong><span>${description}${strategy}</span></div>
    </li>`;
  }).join("");
}

function targetUrl(memberId) {
  return `${state.targetOrigin}/workspace?memberId=${encodeURIComponent(memberId)}&tenant=riverbend`;
}

function setMode(mode) {
  if (state.discoveryRunning) return;
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $("#mode-title").textContent = mode === "replay" ? "Invoke the approved capability" : "Give the model a goal";
  $("#mode-description").textContent = mode === "replay" ? "New input · fixed steps · no model decisions" : "Natural language in · reviewed capability out";
  $("#goal-label").textContent = mode === "replay" ? "Capability" : "Natural-language goal";
  discoveryGoal.hidden = mode === "replay";
  $("#goal-examples").hidden = mode === "replay";
  $("#goal-hint").hidden = mode === "replay";
  $("#goal-example-note").hidden = mode === "replay";
  $("#discovery-parameter-field").hidden = mode === "replay";
  capabilityBox.hidden = mode !== "replay";
  $("#parameter-field").hidden = mode !== "replay";
  runButton.textContent = mode === "replay" ? "Run deterministic replay →" : "Play guided discovery →";
  copyDiscovery.hidden = mode === "replay";
  discoveryCommandPanel.hidden = true;
  inspectDiscovery.hidden = mode === "replay" || !(GOAL_PRESETS[activePreset] ?? {}).proof;
  $("#model-zero").hidden = mode !== "replay";
  surfaceStage.hidden = true;
  $("#surface-panel").classList.remove("discovery-active");
  $("#execution-badge").textContent = mode === "replay" ? "Live engine" : "Ready";
  $("#execution-badge").className = "badge success";
  const note = $("#mode-note");
  note.classList.toggle("discovery-note", mode === "discovery");
  note.querySelector(".check").textContent = mode === "replay" ? "✓" : "i";
  note.querySelector("strong").textContent = mode === "replay" ? "Policy preflight passed." : "The animation is an evidence walkthrough.";
  $("#mode-note-detail").textContent = mode === "replay"
    ? " Origin, route, action type, and input contract are allowlisted."
    : " It shows the recorded stages without spending model tokens. Use the copied CLI command to run a new genuine discovery.";
  renderTimeline(mode === "replay" ? replaySteps : DISCOVERY_PLANS[activePreset].steps);
  if (mode === "discovery") {
    iframe.src = `${state.targetOrigin}/`;
    surfaceAddress.textContent = "Ready · synthetic discovery value [redacted]";
    output.innerHTML = `<div class="output-label">Ready for discovery walkthrough</div><div class="output-value">${DISCOVERY_PLANS[activePreset].steps.length} stages</div><div class="output-sub">Choose a prompt and press Play guided discovery</div>`;
  } else {
    iframe.src = targetUrl(memberInput.value || "22871");
    surfaceAddress.textContent = targetUrl(memberInput.value || "22871");
    output.innerHTML = `<div class="output-label">Ready for deterministic replay</div><div class="output-value">0 model calls</div><div class="output-sub">Choose a synthetic scenario and invoke the saved capability</div>`;
  }
}

document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));

async function runReplay() {
  if (state.mode === "discovery") {
    return playDiscovery();
  }
  if (state.running) return;
  const memberId = memberInput.value.trim();
  if (!/^\d{3,10}$/.test(memberId)) {
    notify("Check the member number", "Use one of the synthetic numeric scenarios shown below the field.");
    memberInput.focus();
    return;
  }
  state.running = true;
  runButton.disabled = true;
  runButton.textContent = "Running guarded replay…";
  output.className = "output-card";
  output.innerHTML = `<div class="output-label">Execution in progress</div><div class="output-value">Resolving legacy UI…</div><div class="output-sub">Policy checked · the model invocation count remains zero</div>`;
  renderTimeline(replaySteps, 0);

  try {
    const response = await fetch("/api/studio/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Replay could not start");
    const result = data.result;
    if (result.status === "ok") {
      renderTimeline(replaySteps, replaySteps.length, -1, result.trace);
      const balance = result.outputs.savingsBalance;
      output.className = "output-card";
      output.innerHTML = `<div class="output-label">Success · typed output</div><div class="output-value">${balance.display}</div><div class="output-sub">${balance.currency} · savingsBalance · ${result.durationMs}ms</div>`;
      iframe.src = targetUrl(memberId);
      surfaceAddress.textContent = targetUrl(memberId).replace(memberId, "[redacted]");
      notify("Replay completed", `The capability returned ${balance.display} with zero model calls.`);
    } else if (result.status === "outcome") {
      const stopped = Math.max(1, result.trace.length);
      renderTimeline(replaySteps, stopped, Math.min(stopped, replaySteps.length - 1), result.trace);
      output.className = "output-card outcome";
      output.innerHTML = `<div class="output-label">Known business outcome</div><div class="output-value">${result.code.replaceAll("_", " ")}</div><div class="output-sub">Declared result contract · not an automation crash</div>`;
      iframe.src = result.code === "NO_SAVINGS_ACCOUNT" ? targetUrl(memberId) : `${state.targetOrigin}/members/lookup?memberId=${encodeURIComponent(memberId)}`;
      surfaceAddress.textContent = `${state.targetOrigin}/…?memberId=[redacted]`;
      notify("Business outcome detected", result.description);
    } else {
      renderTimeline(replaySteps, Math.max(1, result.trace.length), -1, result.trace);
      output.className = "output-card fail";
      output.innerHTML = `<div class="output-label">Replay stopped safely</div><div class="output-value">${result.failure || result.status}</div><div class="output-sub">${result.message || "Inspect the saved evidence for details"}</div>`;
      notify("Replay stopped", result.message || "The engine failed closed and saved evidence.");
    }
  } catch (error) {
    output.className = "output-card fail";
    output.innerHTML = `<div class="output-label">Could not run</div><div class="output-value">Surface unavailable</div><div class="output-sub">${error.message}</div>`;
    notify("Replay could not run", error.message);
  } finally {
    state.running = false;
    runButton.disabled = false;
    runButton.textContent = "Run deterministic replay →";
  }
}

async function playDiscovery() {
  const goal = discoveryGoal.value.trim();
  const memberId = discoveryMemberInput.value.trim();
  if (!goal) {
    notify("Enter a goal", "Describe the UI task in normal language before starting the walkthrough.");
    discoveryGoal.focus();
    return;
  }
  if (!/^\d{3,10}$/.test(memberId)) {
    notify("Check the discovery value", "Use a 3–10 digit synthetic member number.");
    discoveryMemberInput.focus();
    return;
  }
  if (state.discoveryRunning) return;

  const preset = GOAL_PRESETS[activePreset] ?? GOAL_PRESETS.balance;
  const plan = DISCOVERY_PLANS[activePreset] ?? DISCOVERY_PLANS.balance;
  state.discoveryRunning = true;
  runButton.disabled = true;
  copyDiscovery.disabled = true;
  inspectDiscovery.disabled = true;
  discoveryGoal.disabled = true;
  discoveryMemberInput.disabled = true;
  document.querySelectorAll(".mode-button, #goal-examples .quick-value").forEach((button) => { button.disabled = true; });
  runButton.textContent = "Playing discovery…";
  $("#surface-panel").classList.add("discovery-active");
  surfaceStage.hidden = false;
  surfaceStage.classList.remove("complete");
  $("#execution-badge").textContent = preset.proof ? "Committed evidence playback" : "Illustrated preview";
  $("#execution-badge").className = preset.proof ? "badge info" : "badge warn";

  try {
    for (let index = 0; index < plan.stages.length; index += 1) {
      const [title, detail, label, value, target] = plan.stages[index];
      renderTimeline(plan.steps, index);
      $("#surface-stage-title").textContent = `${index + 1}/${plan.stages.length} · ${title}`;
      $("#surface-stage-detail").textContent = detail;
      output.className = "output-card progress";
      output.innerHTML = `<div class="output-label">${label}</div><div class="output-value">${value}</div><div class="output-sub">${detail}</div>`;
      iframe.src = target === "profile" ? targetUrl(memberId) : `${state.targetOrigin}/`;
      surfaceAddress.textContent = target === "profile"
        ? `${state.targetOrigin}/workspace?memberId=[redacted]`
        : `${state.targetOrigin}/ · observing controls`;
      iframe.classList.remove("discovery-transition");
      void iframe.offsetWidth;
      iframe.classList.add("discovery-transition");
      await delay(index === 0 ? 1100 : 900);
    }

    renderTimeline(plan.steps, plan.steps.length);
    surfaceStage.classList.add("complete");
    $("#surface-stage-title").textContent = "Discovery walkthrough complete";
    $("#surface-stage-detail").textContent = preset.proof
      ? "The saved model run compiled the approved reference capability"
      : "Run the copied command to create a genuine draft for this example";
    $("#execution-badge").textContent = "Complete";
    $("#execution-badge").className = "badge success";
    output.className = "output-card";
    output.innerHTML = preset.proof
      ? `<div class="output-label">Genuine discovery playback complete</div><div class="output-value">member.read_savings_balance</div><div class="output-sub">Typed input · typed output · 4 deterministic replay steps</div>`
      : `<div class="output-label">Illustrated preview complete</div><div class="output-value">${preset.name}</div><div class="output-sub">Copy and run the genuine command to create this draft</div>`;
    notify("Discovery walkthrough complete", preset.proof
      ? "The timeline replayed the committed model-driven discovery stages."
      : "This preview shows the intended stages; no model run is claimed for this example.");
  } catch (error) {
    output.className = "output-card fail";
    output.innerHTML = `<div class="output-label">Walkthrough stopped</div><div class="output-value">Could not continue</div><div class="output-sub">${error.message}</div>`;
    notify("Discovery walkthrough stopped", error.message);
  } finally {
    state.discoveryRunning = false;
    runButton.disabled = false;
    copyDiscovery.disabled = false;
    inspectDiscovery.disabled = false;
    discoveryGoal.disabled = false;
    discoveryMemberInput.disabled = false;
    document.querySelectorAll(".mode-button, #goal-examples .quick-value").forEach((button) => { button.disabled = false; });
    runButton.textContent = "Play again →";
  }
}

function discoveryCommand() {
  const goal = discoveryGoal.value.trim();
  const memberId = discoveryMemberInput.value.trim();
  const preset = GOAL_PRESETS[activePreset] ?? GOAL_PRESETS.balance;
  const quotedGoal = `'${goal.replaceAll("'", `'\"'\"'`)}'`;
  const outputLine = preset.output ? `\\\n  --output ${preset.output}` : "";
  return `npm run discover -- \\\n  --goal ${quotedGoal} \\\n  --name ${preset.name} \\\n  --input '${preset.input}' \\\n  --value memberId=${memberId}${outputLine} \\\n  --headed`;
}

copyDiscovery.addEventListener("click", async () => {
  const goal = discoveryGoal.value.trim();
  const memberId = discoveryMemberInput.value.trim();
  if (!goal || !/^\d{3,10}$/.test(memberId)) {
    notify("Complete the discovery input", "Enter a goal and a 3–10 digit synthetic member number first.");
    return;
  }
  const command = discoveryCommand();
  discoveryCommandPreview.textContent = command;
  discoveryCommandPanel.hidden = false;
  const copied = await copyText(command);
  $("#command-copy-state").textContent = copied ? "Copied" : "Select and copy below";
  notify(copied ? "Genuine discovery command copied" : "Genuine discovery command ready", "Run it from the repository after configuring a supported model provider.");
});

[discoveryGoal, discoveryMemberInput].forEach((input) => input.addEventListener("input", () => {
  discoveryCommandPanel.hidden = true;
}));

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

inspectDiscovery.addEventListener("click", () => {
  showView("evidence");
  notify("Committed discovery opened", "This evidence is from a genuine model-driven run of the default goal.");
});

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* fall through */ }
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  return copied;
}

runButton.addEventListener("click", runReplay);

function syntaxHighlight(value) {
  const json = JSON.stringify(value, null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return json.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(true|false|null)\b/g, (match, key, string, bool) => {
    if (key) return `<span class="key">${key}</span>`;
    if (string) return `<span class="string">${string}</span>`;
    if (bool) return `<span class="bool">${bool}</span>`;
    return match;
  });
}

async function loadStudioData() {
  try {
    const response = await fetch("/api/studio/summary");
    const data = await response.json();
    if (!response.ok) return;
    state.targetOrigin = data.targetOrigin;
    $("#artifact-code").innerHTML = syntaxHighlight(data.artifact);
    $("#artifact-created").textContent = new Date(data.artifact.provenance.recordedAt).toLocaleString();
    $("#artifact-step-count").textContent = `${data.artifact.steps.length} deterministic steps`;
    $("#artifact-hash").textContent = `sha256: ${data.artifact.artifactHash.slice(0, 12)}…`;
    $("#capability-count").textContent = String(data.capabilities);
    $("#evidence-count").textContent = `${data.evidenceCases} / ${data.evidenceCases}`;
    $("#outcome-count").textContent = String(data.knownOutcomes);
    iframe.src = targetUrl(memberInput.value);
    surfaceAddress.textContent = targetUrl(memberInput.value).replace(memberInput.value, "[redacted]");
  } catch { /* Static reviewer copy remains useful while the local engine starts. */ }
}

const handoffEmpty = $("#handoff-empty");
const handoffCard = $("#intervention-card");
const ownerLabel = $("#control-owner");
const claimButton = $("#claim-intervention");

$("#create-handoff").addEventListener("click", async () => {
  const button = $("#create-handoff");
  button.disabled = true;
  button.textContent = "Opening guarded session…";
  try {
    const response = await fetch("/api/studio/interventions/demo", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    state.handoff = "open";
    state.interventionId = data.intervention.id;
    handoffEmpty.style.display = "none";
    handoffCard.classList.add("active");
    ownerLabel.textContent = "Automation paused";
    $("#handoff-request").textContent = data.intervention.id;
    $("#handoff-step").textContent = data.intervention.stepId || "risk gate";
    $("#handoff-location").textContent = data.intervention.location.replace(/\d{3,10}/g, "[redacted]");
    $("#handoff-state").textContent = "Open";
    claimButton.textContent = "Take control of live session";
    claimButton.disabled = false;
    notify("Real intervention created", "Replay ceded its enforced control lease before the irreversible step.");
  } catch (error) {
    notify("Could not create intervention", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Start safety demo";
  }
});

claimButton.addEventListener("click", async () => {
  if (!state.interventionId) return;
  const action = state.handoff === "open" ? "claim" : state.handoff === "claimed" ? "act" : "release";
  const body = action === "claim"
    ? { operator: "candidate.reviewer" }
    : action === "act"
      ? { kind: "click", target: { role: "button", name: "Confirm and Open", nameMatch: "contains", frame: { strategy: "main" }, fallbacks: [] } }
      : { note: "Reviewer completed the guarded manual step." };
  const response = await fetch(`/api/studio/interventions/${state.interventionId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    notify("Control transfer failed", data.error);
    return;
  }
  if (action === "claim") {
    state.handoff = "claimed";
    claimButton.textContent = "Complete guarded action";
    ownerLabel.textContent = "Human operator in control";
    $("#handoff-state").textContent = "Claimed";
    $("#handoff-state").className = "badge warn";
    notify("Control transferred", "You now own the paused session. Complete the prepared action, then let replay verify it.");
  } else if (action === "act") {
    state.handoff = "acted";
    claimButton.textContent = "Verify and resume automation";
    $("#handoff-state").textContent = "Action completed";
    notify("Human action recorded", "The click ran in the same paused browser context; raw form values were not logged.");
  } else {
    state.handoff = "resolved";
    claimButton.textContent = "Intervention resolved";
    claimButton.disabled = true;
    ownerLabel.textContent = "Automation resumed";
    $("#handoff-state").textContent = "Released";
    $("#handoff-state").className = "badge success";
    if (data.result?.status === "ok") {
      notify("Replay resumed and completed", `${data.humanEvents.length} human action event(s) were audited; the final checkpoint passed.`);
    } else {
      notify("Control returned, verification failed", `Replay finished as ${data.result?.status || "unknown"}; inspect the evidence before retrying.`);
    }
  }
});

$("#dismiss-intervention").addEventListener("click", () => {
  state.handoff = "idle";
  state.interventionId = null;
  handoffCard.classList.remove("active");
  handoffEmpty.style.display = "grid";
  ownerLabel.textContent = "Automation owns session";
});

const slides = [...document.querySelectorAll(".slide")];
const slideDots = $("#deck-dots");
const slideCounter = $("#slide-counter");
let slideIndex = 0;

slides.forEach((_, index) => {
  const dot = document.createElement("button");
  dot.className = "deck-dot";
  dot.setAttribute("aria-label", `Slide ${index + 1}`);
  dot.addEventListener("click", () => showSlide(index));
  slideDots.appendChild(dot);
});
const dots = [...slideDots.children];

function showSlide(index) {
  slideIndex = Math.max(0, Math.min(slides.length - 1, index));
  slides.forEach((slide, i) => slide.classList.toggle("active", i === slideIndex));
  dots.forEach((dot, i) => dot.classList.toggle("active", i === slideIndex));
  slideCounter.textContent = `${slideIndex + 1} / ${slides.length}`;
  $("#slide-prev").disabled = slideIndex === 0;
  $("#slide-next").disabled = slideIndex === slides.length - 1;
}

$("#slide-prev").addEventListener("click", () => showSlide(slideIndex - 1));
$("#slide-next").addEventListener("click", () => showSlide(slideIndex + 1));
document.addEventListener("keydown", (event) => {
  if (state.view !== "presentation") return;
  if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;
  if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); showSlide(slideIndex + 1); }
  if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); showSlide(slideIndex - 1); }
  if (event.key === "Home") { event.preventDefault(); showSlide(0); }
  if (event.key === "End") { event.preventDefault(); showSlide(slides.length - 1); }
});
showSlide(0);

const initialView = location.hash.replace("#", "");
if (pageMeta[initialView] && initialView !== "overview") showView(initialView);
window.addEventListener("hashchange", () => {
  const name = location.hash.replace("#", "") || "overview";
  if (pageMeta[name] && name !== state.view) showView(name);
});

applyPreset("balance");
setMode("discovery");
loadStudioData();
