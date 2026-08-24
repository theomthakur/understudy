const state = {
  view: "overview",
  mode: "replay",
  running: false,
  handoff: "idle",
  interventionId: null,
  targetOrigin: "/legacy",
};

const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll(".view")];
const navButtons = [...document.querySelectorAll("[data-view]")];
const iframe = $("#legacy-frame");
const runButton = $("#run-capability");
const memberInput = $("#member-id");
const timeline = $("#timeline");
const output = $("#run-output");
const surfaceAddress = $("#surface-address");
const toast = $("#toast");

const pageMeta = {
  overview: ["Candidate Project", "Capability overview"],
  studio: ["Working Demo", "Deterministic replay"],
  evidence: ["Artifact & Evidence", "Proof"],
  interventions: ["Control Transfer", "Human review"],
};

function showView(name) {
  state.view = name;
  views.forEach((view) => view.classList.toggle("active", view.dataset.name === name));
  navButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const meta = pageMeta[name] || pageMeta.overview;
  $(".page-kicker").textContent = meta[0];
  $(".page-title").textContent = meta[1];
  window.scrollTo({ top: 0, behavior: "auto" });
}

navButtons.forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));

function notify(headline, detail) {
  toast.querySelector("strong").textContent = headline;
  toast.querySelector("span").textContent = detail;
  toast.classList.add("visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

document.querySelectorAll(".quick-value").forEach((button) => {
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

const discoverySteps = [
  ["Observe live surface", "Screenshot and numbered accessibility candidates captured"],
  ["Model chooses input", "Structured decision can reference only a listed candidate"],
  ["Model submits search", "The runtime—not the model—operates the live control"],
  ["Compile capability", "Recorder removes volatile data and adds typed contracts"],
];

function renderTimeline(steps, completed = steps.length, outcomeIndex = -1, trace = []) {
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
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $("#mode-title").textContent = mode === "replay" ? "Invoke saved capability" : "Genuine LLM discovery";
  $("#mode-description").textContent = mode === "replay" ? "Approved path · deterministic · no model decisions" : "Evidence path · genuine model-driven computer use";
  $("#goal-label").textContent = mode === "replay" ? "Capability" : "Natural-language goal";
  $("#goal-box").textContent = mode === "replay" ? "member.read_savings_balance · revision 1" : "Look up a member and return the current SAVINGS balance.";
  $("#parameter-field").style.display = mode === "replay" ? "block" : "none";
  runButton.textContent = mode === "replay" ? "Run deterministic replay →" : "Open discovery proof →";
  $("#model-zero").style.display = mode === "replay" ? "flex" : "none";
  renderTimeline(mode === "replay" ? replaySteps : discoverySteps);
  if (mode === "discovery") {
    iframe.src = targetUrl("12345");
    surfaceAddress.textContent = "Committed discovery · synthetic input [redacted]";
    output.innerHTML = `<div class="output-label">Artifact compiled</div><div class="output-value">4 steps</div><div class="output-sub">Typed contract · relational locator · bounded recovery rules</div>`;
  } else {
    iframe.src = targetUrl(memberInput.value || "22871");
    surfaceAddress.textContent = targetUrl(memberInput.value || "22871");
    output.innerHTML = `<div class="output-label">Ready for deterministic replay</div><div class="output-value">0 model calls</div><div class="output-sub">Choose a synthetic scenario and invoke the saved capability</div>`;
  }
}

document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));

async function runReplay() {
  if (state.mode === "discovery") {
    showView("evidence");
    notify("Discovery evidence opened", "The committed event stream is from a genuine model-driven run.");
    return;
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

renderTimeline(replaySteps);
loadStudioData();
