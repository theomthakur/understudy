/**
 * Evidence.
 *
 * Every run — discovery or replay — gets a directory under evidence/runs/<runId>/ containing:
 *
 *   events.jsonl     structured, append-only, one JSON object per line
 *   observation-*.json  pruned control trees at interesting moments
 *   failure.png      screenshot, only on failure or escalation
 *   result.json      the final typed result
 *
 * JSONL rather than a single JSON document because a run that crashes still leaves readable
 * evidence up to the crash, which is exactly when you need it most.
 *
 * Everything written here passes through the redactor first. That is enforced in `event()`
 * rather than trusted to callers.
 */

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../policy/redact.js";
import type { Observation } from "../surface/surface.js";

export type EventLevel = "info" | "warn" | "error";

export interface RunEvent {
  ts: string;
  level: EventLevel;
  event: string;
  [key: string]: unknown;
}

export class EvidenceLog {
  readonly dir: string;
  readonly eventsPath: string;
  private observationSeq = 0;

  constructor(
    readonly runId: string,
    private readonly redactor: Redactor,
    rootDir = "evidence/runs"
  ) {
    this.dir = join(rootDir, runId);
    mkdirSync(this.dir, { recursive: true });
    this.eventsPath = join(this.dir, "events.jsonl");
  }

  event(level: EventLevel, event: string, data: Record<string, unknown> = {}): void {
    const record: RunEvent = this.redactor.redact({
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    });
    appendFileSync(this.eventsPath, JSON.stringify(record) + "\n", "utf8");
    if (level !== "info" || process.env.UNDERSTUDY_VERBOSE) {
      const tag = level === "error" ? "ERR " : level === "warn" ? "WARN" : "    ";
      console.log(`${tag} ${event} ${compact(record)}`);
    }
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.event("info", event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.event("warn", event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.event("error", event, data);
  }

  addSecret(value: string | undefined): void {
    this.redactor.addSecret(value);
  }

  /**
   * Persist an observation.
   *
   * Only the control tree and notices are written. Raw HTML is deliberately never stored:
   * on a banking screen the page body is full of regulated data, and there is no version of
   * "we saved the whole DOM for debugging" that is safe here.
   */
  saveObservation(obs: Observation, label: string): string {
    const name = `observation-${String(++this.observationSeq).padStart(2, "0")}-${label}.json`;
    const path = join(this.dir, name);
    const safe = this.redactor.redact({
      location: obs.location,
      title: obs.title,
      notices: obs.notices,
      capturedAt: obs.capturedAt,
      controls: obs.tree.map((n) => ({
        role: n.role,
        name: n.name,
        value: n.value,
        frame: n.frame,
        disabled: n.disabled,
      })),
    });
    writeFileSync(path, JSON.stringify(safe, null, 2), "utf8");
    return path;
  }

  saveResult(result: unknown): string {
    const path = join(this.dir, "result.json");
    writeFileSync(path, JSON.stringify(this.redactor.redact(result), null, 2), "utf8");
    return path;
  }

  screenshotPath(label = "failure"): string {
    return join(this.dir, `${label}.png`);
  }
}

function compact(r: RunEvent): string {
  const { ts, level, event, ...rest } = r;
  const s = JSON.stringify(rest);
  return s === "{}" ? "" : s.length > 220 ? s.slice(0, 217) + "..." : s;
}

export function newRunId(prefix: "discover" | "replay"): string {
  const t = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${t}-${r}`;
}
