/**
 * Checks that the committed evidence is actually what it claims to be.
 *
 * Evidence is the only part of this project a reviewer can check without running anything,
 * which means a stale or half-written run is worse than no run at all. This walks every
 * committed directory and asserts the things the README promises: the files exist, the log
 * parses, the result matches the log, replay never called a model, and nothing raw leaked
 * through the redactor.
 *
 * Run with `npm run verify:evidence`. Exits non-zero on any failure, so `npm run check`
 * fails the same way CI would.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["evidence/examples", "evidence/curated"];

/** Anything here appearing in a log means the redactor did not do its job. */
const MUST_NOT_APPEAR = [
  /<html/i,
  /<div\b/i,
  /password\s*[:=]\s*\S+/i,
  /"cookie"\s*:/i,
  /Bearer\s+[A-Za-z0-9._-]{16,}/,
  /\b(?:12345|22871|30099|44120)\b/,
  /\$?(?:8,241\.55|1,930\.08|402\.19)/,
  /Dana\s+Whitfield/i,
  /\b(?:SV|CK)-10024[12]\b/,
];

interface Problem {
  where: string;
  what: string;
}

const problems: Problem[] = [];
let runsChecked = 0;
let eventsChecked = 0;

function fail(where: string, what: string) {
  problems.push({ where, what });
}

function checkRun(dir: string, label: string) {
  runsChecked++;

  const eventsPath = join(dir, "events.jsonl");
  const resultPath = join(dir, "result.json");

  if (!existsSync(eventsPath)) return fail(label, "no events.jsonl");

  /* ---- the log parses, line by line, and carries the fields it promises ---- */
  const raw = readFileSync(eventsPath, "utf8").trim();
  if (raw.length === 0) return fail(label, "events.jsonl is empty");

  const lines = raw.split("\n");
  const events: any[] = [];
  lines.forEach((line, i) => {
    try {
      const e = JSON.parse(line);
      if (!e.ts) fail(label, `events.jsonl line ${i + 1} has no ts`);
      if (!e.event) fail(label, `events.jsonl line ${i + 1} has no event`);
      events.push(e);
      eventsChecked++;
    } catch {
      fail(label, `events.jsonl line ${i + 1} is not valid JSON`);
    }
  });

  /* ---- nothing raw survived the redactor ---- */
  for (const pattern of MUST_NOT_APPEAR) {
    if (pattern.test(raw)) fail(label, `events.jsonl matches ${pattern}, the redactor missed something`);
  }

  /* ---- a discovery run ends in an artifact, not a result, so it is checked differently ---- */
  const isDiscovery = events.some((e) => String(e.event).startsWith("discovery."));
  if (isDiscovery) {
    if (!events.some((e) => e.event === "discovery.done")) {
      fail(label, "discovery run never reached discovery.done");
    }
    const observations = readdirSync(dir).filter((n) => /^observation-.*\.json$/.test(n));
    if (observations.length === 0) {
      fail(label, "discovery run kept no observations, so there is no record of what the model saw");
    }
    for (const o of observations) {
      try {
        const observationRaw = readFileSync(join(dir, o), "utf8");
        JSON.parse(observationRaw);
        for (const pattern of MUST_NOT_APPEAR) {
          if (pattern.test(observationRaw)) fail(label, `${o} matches ${pattern}, the redactor missed something`);
        }
      } catch {
        fail(label, `${o} is not valid JSON`);
      }
    }
    return;
  }

  if (!existsSync(resultPath)) return fail(label, "no result.json");

  /* ---- the result parses and says one of the four things it is allowed to say ---- */
  let result: any;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return fail(label, "result.json is not valid JSON");
  }

  const STATUSES = ["ok", "outcome", "failed", "escalated"];
  if (!STATUSES.includes(result.status)) {
    fail(label, `result.status is "${result.status}", expected one of ${STATUSES.join(", ")}`);
  }
  if (!result.capability) fail(label, "result.json has no capability");
  if (typeof result.evidence?.logPath !== "string" || !existsSync(join(ROOT, result.evidence.logPath))) {
    fail(label, `result evidence.logPath is missing or does not resolve: ${String(result.evidence?.logPath)}`);
  }
  if (result.evidence?.screenshotPath && !existsSync(join(ROOT, result.evidence.screenshotPath))) {
    fail(label, `result evidence.screenshotPath does not resolve: ${result.evidence.screenshotPath}`);
  }

  /* ---- the result agrees with the log it came from ---- */
  const start = events.find((e) => e.event === "replay.start" || e.event === "discovery.start");
  if (start) {
    if (start.capability && result.capability && start.capability !== result.capability) {
      fail(label, `log says ${start.capability}, result says ${result.capability}`);
    }
    /* The whole claim of this project. A replay must never have called a model. */
    if (start.event === "replay.start" && typeof start.modelInvocations === "number" && start.modelInvocations !== 0) {
      fail(label, `replay reports ${start.modelInvocations} model invocations, must be 0`);
    }
  }

  /* ---- a stopped run has to show why ---- */
  if (result.status === "failed") {
    if (!result.failure) fail(label, "failed result has no failure code");
    if (!result.stepId) fail(label, "failed result does not say which step");
    if (!existsSync(join(dir, "failure.png"))) fail(label, "failed run has no failure.png");
  }
  if (result.status === "escalated" && !existsSync(join(dir, "escalation.png"))) {
    fail(label, "escalated run has no escalation.png");
  }

  /* ---- screenshots are real files, not empty placeholders ---- */
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".png"))) {
    if (statSync(join(dir, f)).size < 1024) fail(label, `${f} is under 1 KB, probably not a real screenshot`);
  }
}

for (const base of DIRS) {
  const full = join(ROOT, base);
  if (!existsSync(full)) {
    fail(base, "directory is missing");
    continue;
  }
  const runs = readdirSync(full).filter((n) => statSync(join(full, n)).isDirectory());
  if (runs.length === 0) fail(base, "no runs committed");
  for (const run of runs) checkRun(join(full, run), `${base}/${run}`);
}

/* ---- the flagship handoff must be one resumable run, not disconnected screenshots ---- */
const handoffDir = join(ROOT, "evidence/curated/replay-handoff");
if (!existsSync(handoffDir)) {
  fail("evidence/curated/replay-handoff", "curated handoff evidence is missing");
} else {
  try {
    const result = JSON.parse(readFileSync(join(handoffDir, "result.json"), "utf8"));
    const raw = readFileSync(join(handoffDir, "events.jsonl"), "utf8");
    if (result.status !== "ok") fail("evidence/curated/replay-handoff", `final status is ${result.status}, expected ok after resume`);
    const ordered = ["control.ceded", "control.claimed", "control.released", "escalation.resumed", "replay.ok"];
    let cursor = -1;
    for (const event of ordered) {
      const next = raw.indexOf(`\"event\":\"${event}\"`);
      if (next <= cursor) fail("evidence/curated/replay-handoff", `${event} is missing or out of order`);
      cursor = next;
    }
    if (!result.trace?.some((step: any) => step.status === "human" && step.interventionId)) {
      fail("evidence/curated/replay-handoff", "final trace does not link the human-completed step to its intervention");
    }
  } catch (error) {
    fail("evidence/curated/replay-handoff", `could not verify resumable handoff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ---- report ---- */
console.log(`evidence: ${runsChecked} runs, ${eventsChecked} events`);

if (problems.length === 0) {
  console.log("all committed evidence is complete, parseable, redacted, and internally consistent");
  process.exit(0);
}

console.error(`\n${problems.length} problem${problems.length > 1 ? "s" : ""}:`);
for (const p of problems) console.error(`  ${p.where}: ${p.what}`);
process.exit(1);
