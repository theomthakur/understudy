/**
 * Guardrails.
 *
 * Three separate concerns, kept separate on purpose because they fail differently:
 *
 *   1. Allowlist   — where the agent may operate at all. A hard boundary. Violating it is
 *                    never recoverable and never a business outcome; it is a policy denial.
 *   2. Risk class  — what kind of action this is. Safe actions run. Irreversible ones need
 *                    an approved artifact and, unattended, are refused outright.
 *   3. Redaction   — what may be written down. Applied at the logging boundary rather than
 *                    at call sites, because relying on every call site to remember is how
 *                    secrets end up in logs.
 *
 * The limits of this model are stated honestly in REPORT.md §6. In particular the allowlist
 * is enforced at the point of action, not at the network layer, so it constrains what the
 * agent *does*, not everything a page could do on its own.
 */

import type { Risk } from "../domain/artifact.js";

export interface PolicyConfig {
  /** Hostnames the agent may operate on. Exact host or leading-dot suffix match. */
  allowedHosts: string[];
  /** Path prefixes within those hosts. Empty means all paths. */
  allowedPathPrefixes: string[];
  /** Action kinds the agent may perform at all. */
  allowedActions: ("navigate" | "click" | "type" | "select" | "press" | "read" | "wait_for")[];
  /**
   * How to treat an irreversible step during unattended replay.
   *   refuse   - fail closed. The default.
   *   escalate - pause and hand to a human. Correct for production.
   *   allow    - only with an approved artifact.
   */
  irreversiblePolicy: "refuse" | "escalate" | "allow";
  /** Unattended replay of an artifact still in draft. */
  requireApprovalForIrreversible: boolean;
  maxSteps: number;
  maxRunMs: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  allowedHosts: ["localhost", "127.0.0.1"],
  allowedPathPrefixes: [],
  allowedActions: ["navigate", "click", "type", "select", "press", "read", "wait_for"],
  irreversiblePolicy: "escalate",
  requireApprovalForIrreversible: true,
  maxSteps: 40,
  maxRunMs: 180_000,
};

export type PolicyVerdict =
  | { allow: true }
  | { allow: false; reason: string; escalate: boolean };

export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  get config(): PolicyConfig {
    return this.cfg;
  }

  checkUrl(url: string): PolicyVerdict {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allow: false, reason: `Not a valid URL: ${url}`, escalate: false };
    }

    const host = parsed.hostname;
    const hostOk = this.cfg.allowedHosts.some((h) =>
      h.startsWith(".") ? host.endsWith(h) : host === h
    );
    if (!hostOk) {
      return {
        allow: false,
        reason: `Host "${host}" is not on the allowlist (${this.cfg.allowedHosts.join(", ")})`,
        escalate: false,
      };
    }

    if (this.cfg.allowedPathPrefixes.length > 0) {
      const pathOk = this.cfg.allowedPathPrefixes.some((p) => parsed.pathname.startsWith(p));
      if (!pathOk) {
        return {
          allow: false,
          reason: `Path "${parsed.pathname}" is outside the allowed prefixes`,
          escalate: false,
        };
      }
    }
    return { allow: true };
  }

  checkAction(action: string): PolicyVerdict {
    if (!this.cfg.allowedActions.includes(action as PolicyConfig["allowedActions"][number])) {
      return { allow: false, reason: `Action "${action}" is not permitted by policy`, escalate: false };
    }
    return { allow: true };
  }

  /**
   * Risk gate.
   *
   * Note the asymmetry: an unapproved irreversible step is refused rather than escalated,
   * because escalating it would let an unreviewed capability reach a human as if it were
   * routine. Review is the control; escalation is not a substitute for it.
   */
  checkRisk(risk: Risk, opts: { approved: boolean; attended: boolean }): PolicyVerdict {
    if (risk === "safe") return { allow: true };

    if (risk === "elevated") {
      if (opts.attended) return { allow: true };
      return this.cfg.irreversiblePolicy === "allow"
        ? { allow: true }
        : { allow: false, reason: "Elevated-risk step during unattended replay", escalate: true };
    }

    // irreversible
    if (this.cfg.requireApprovalForIrreversible && !opts.approved) {
      return {
        allow: false,
        reason: "Irreversible step in an artifact that has not been approved",
        escalate: false,
      };
    }
    switch (this.cfg.irreversiblePolicy) {
      case "allow":
        return { allow: true };
      case "escalate":
        return { allow: false, reason: "Irreversible step requires a human decision", escalate: true };
      case "refuse":
        return { allow: false, reason: "Irreversible steps are refused by policy", escalate: false };
    }
  }

  /**
   * Classify an action observed during discovery.
   *
   * Deliberately conservative and deliberately crude: anything that looks like a commit,
   * a confirmation, or a destructive verb is treated as irreversible. Over-classifying
   * costs a review; under-classifying costs a wrongly-opened account.
   */
  static classifyRisk(action: string, controlName: string | undefined): Risk {
    const n = (controlName ?? "").toLowerCase();
    if (action === "read" || action === "wait_for" || action === "navigate") return "safe";

    const irreversible =
      /\b(confirm|submit|approve|post|transfer|delete|remove|close account|open sub-?account|disburse|issue|void|reverse)\b/;
    if (irreversible.test(n)) return "irreversible";

    const elevated = /\b(save|update|apply|create|add|edit|change)\b/;
    if (elevated.test(n)) return "elevated";

    return "safe";
  }
}
