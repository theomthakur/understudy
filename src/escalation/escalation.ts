/**
 * Human-in-the-loop escalation and control transfer.
 *
 * The requirement that shapes this: the human must operate *the same live session* the
 * automation was using, not a fresh one. That single constraint rules out the obvious
 * design (notify a human, they log in separately and redo it) and forces the automation to
 * be pausable rather than merely abortable.
 *
 * So the control-transfer model is an explicit state machine on the session, not a flag:
 *
 *     AUTOMATION ──raise()──▶ AWAITING_HUMAN ──claim()──▶ HUMAN ──release()──▶ AUTOMATION
 *          ▲                                                │
 *          └──────────────── abandon() ─────────────────────┘
 *
 * Two rules make it safe:
 *   1. Exactly one party holds control. The automation checks `isAutomationInControl()`
 *      before every action, so a resumed run can never race a human who is still typing.
 *   2. Transitions are recorded as evidence. "Who was in control when this happened" is a
 *      question you will be asked about a banking system, so it is answerable from the log.
 *
 * What is real here vs mocked is stated plainly in REPORT.md §5. The broker, the state
 * machine, the transitions and the audit trail are real. The operator *console* is a
 * deliberately minimal HTTP surface — in headed mode the human uses the actual browser
 * window; in headless mode we publish the CDP endpoint so a real console could attach to
 * the same browser. Building a co-browsing UI was out of scope by the brief.
 */

import { randomUUID } from "node:crypto";
import type { HumanAction, ResolveTarget, Surface } from "../surface/surface.js";
import type { EvidenceLog } from "../evidence/logger.js";

export type ControlHolder = "automation" | "awaiting_human" | "human";

export interface InterventionRequest {
  id: string;
  capability: string;
  revision: number;
  stepId: string | null;
  reason: string;
  runId: string;
  location: string;
  screenshotPath?: string;
  raisedAt: string;
  /** Where a human goes to take control. */
  handoffUrl: string;
  state: "open" | "claimed" | "released" | "abandoned";
  claimedBy?: string;
  claimedAt?: string;
  releasedAt?: string;
  /** What the human said they did. Recorded for audit, not parsed. */
  operatorNote?: string;
  /** Live-session attach point, when the surface can expose one. */
  liveSessionEndpoint?: string;
}

export interface RaiseInput {
  capability: string;
  revision: number;
  stepId: string | null;
  reason: string;
  runId: string;
  location: string;
  screenshotPath?: string;
}

/**
 * Owns control of a session and the interventions raised against it.
 *
 * In production this would be backed by a queue and a real operator console. The interface
 * would not change: raise, claim, release. That is the seam.
 */
export class EscalationBroker {
  private control: ControlHolder = "automation";
  private readonly requests = new Map<string, InterventionRequest>();
  private waiters = new Map<string, (r: InterventionRequest) => void>();

  constructor(
    private readonly surface: Surface,
    private log: EvidenceLog,
    private readonly operatorBaseUrl: string
  ) {}

  /** Keep control-transfer events in the replay's audit stream, not a parallel log. */
  useEvidenceLog(log: EvidenceLog): void {
    this.log = log;
  }

  get controlHolder(): ControlHolder {
    return this.control;
  }

  list(): InterventionRequest[] {
    return [...this.requests.values()];
  }

  get(id: string): InterventionRequest | undefined {
    return this.requests.get(id);
  }

  humanEvents(): unknown[] {
    return this.surface.collectHumanEvents();
  }

  /**
   * Automation is stuck. Pause, cede control, and publish enough context for a human to act.
   *
   * Context deliberately includes the screenshot and the current location: an operator who
   * has to ask "where am I and why did it stop" before they can help is being handed a
   * ticket, not an intervention.
   */
  async raise(input: RaiseInput): Promise<InterventionRequest> {
    const id = randomUUID().slice(0, 8);
    const req: InterventionRequest = {
      id,
      ...input,
      raisedAt: new Date().toISOString(),
      handoffUrl: `${this.operatorBaseUrl}/interventions/${id}`,
      state: "open",
      liveSessionEndpoint: getLiveEndpoint(this.surface),
    };
    this.requests.set(id, req);

    await this.surface.cedeControl();
    this.control = "awaiting_human";

    this.log.warn("control.ceded", {
      interventionId: id,
      from: "automation",
      to: "awaiting_human",
      reason: input.reason,
      stepId: input.stepId,
    });
    return req;
  }

  /** A human takes the live session. */
  claim(id: string, operator: string): InterventionRequest {
    const req = this.mustGet(id);
    if (req.state !== "open") throw new Error(`Intervention ${id} is ${req.state}, not open`);
    req.state = "claimed";
    req.claimedBy = operator;
    req.claimedAt = new Date().toISOString();
    this.control = "human";
    this.log.warn("control.claimed", { interventionId: id, operator });
    return req;
  }

  /** One explicit operator action against the exact paused page and browser context. */
  async humanAction(id: string, action: HumanAction): Promise<void> {
    const req = this.mustGet(id);
    if (req.state !== "claimed" || this.control !== "human") {
      throw new Error(`Intervention ${id} must be claimed before an operator can act`);
    }
    await this.surface.humanAct(action);
    this.log.warn("control.human_action", {
      interventionId: id,
      operator: req.claimedBy,
      action: action.kind,
      target: action.kind === "press" ? undefined : { role: action.target.role, name: action.target.name },
      key: action.kind === "press" ? action.key : undefined,
      textLength: action.kind === "type" ? action.text.length : undefined,
      location: await this.surface.currentLocation(),
    });
  }

  async humanClick(id: string, target: ResolveTarget): Promise<void> {
    await this.humanAction(id, { kind: "click", target });
  }

  /**
   * The human is done. Control returns to automation and the waiting run continues.
   *
   * `note` is stored verbatim as audit evidence. It is not parsed and never influences
   * control flow — a human note steering the automation would be a very effective way to
   * smuggle an instruction past the policy layer.
   */
  async release(id: string, note?: string): Promise<InterventionRequest> {
    const req = this.mustGet(id);
    if (req.state !== "claimed") throw new Error(`Intervention ${id} is ${req.state}, not claimed`);
    req.state = "released";
    req.releasedAt = new Date().toISOString();
    req.operatorNote = note;

    // Let the owning client receive navigation/audit events triggered by the operator's
    // final action before the lease flips back. Cross-client CDP delivery is asynchronous.
    await this.surface.waitForSettled(1_000);
    const humanEvents = this.surface.collectHumanEvents();
    await this.surface.resumeControl();
    this.control = "automation";

    this.log.warn("control.released", {
      interventionId: id,
      operator: req.claimedBy,
      note,
      durationMs: req.claimedAt ? Date.parse(req.releasedAt) - Date.parse(req.claimedAt) : undefined,
      humanEvents,
    });

    this.waiters.get(id)?.(req);
    this.waiters.delete(id);
    return req;
  }

  async abandon(id: string, reason: string): Promise<InterventionRequest> {
    const req = this.mustGet(id);
    req.state = "abandoned";
    req.operatorNote = reason;
    await this.surface.resumeControl();
    this.control = "automation";
    this.log.error("control.abandoned", { interventionId: id, reason });
    this.waiters.get(id)?.(req);
    this.waiters.delete(id);
    return req;
  }

  /**
   * Block the automation until a human hands control back.
   *
   * Bounded, because a run that waits forever holds a browser session open indefinitely,
   * and in a real deployment that is a resource leak with a compliance flavour.
   */
  waitForRelease(id: string, timeoutMs: number): Promise<InterventionRequest> {
    const existing = this.mustGet(id);
    if (existing.state === "released" || existing.state === "abandoned") {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        void this.abandon(id, `No operator responded within ${timeoutMs}ms`).then(resolve);
      }, timeoutMs);

      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  private mustGet(id: string): InterventionRequest {
    const r = this.requests.get(id);
    if (!r) throw new Error(`No such intervention: ${id}`);
    return r;
  }
}

function getLiveEndpoint(surface: Surface): string | undefined {
  const s = surface as Surface & { liveSessionEndpoint?: () => string | undefined };
  return typeof s.liveSessionEndpoint === "function" ? s.liveSessionEndpoint() : undefined;
}
