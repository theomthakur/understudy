/**
 * Redaction.
 *
 * Applied at the logging and artifact boundaries, never at call sites. Every piece of
 * evidence this system writes goes through `redact()`, so the guarantee is structural
 * rather than a convention people have to remember.
 *
 * Two categories:
 *   - Declared sensitive values. Anything bound to an input parameter marked `sensitive`,
 *     plus any configured secret. These are matched literally and replaced. This is the
 *     reliable half.
 *   - Pattern-detected. SSNs, long card-like digit runs, bearer tokens, emails. This is the
 *     unreliable half and REPORT.md says so: pattern matching finds the shapes it knows and
 *     will miss free-text PII. It is defence in depth behind the declared list, not the
 *     primary control.
 *
 * The design choice worth defending: raw page text is never persisted. Observations are
 * stored as role/name control trees, and read values are only kept when the artifact
 * explicitly declares them as an output. Anything else is a leak waiting to happen.
 */

/**
 * Operator/staff identity fields, exempt from redaction. See the note in `walk()`.
 * Deliberately a short, explicit list rather than a loose pattern.
 */
const IDENTITY_KEYS = /^(operator|claimedBy|reviewedBy|actor|performedBy)$/;

const PATTERNS: { name: string; re: RegExp; replacement: string }[] = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED:SSN]" },
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[REDACTED:CARD]" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi, replacement: "Bearer [REDACTED]" },
  {
    name: "apikey",
    re: /\b(sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{12,}\b/gi,
    replacement: "[REDACTED:KEY]",
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED:EMAIL]",
  },
];

export class Redactor {
  private literals: string[] = [];

  /** Register a value that must never appear in evidence. */
  addSecret(value: string | undefined): void {
    if (!value) return;
    const v = String(value);
    if (v.length < 3) return; // too short to match safely; would mangle everything
    if (!this.literals.includes(v)) this.literals.push(v);
  }

  addSecrets(values: (string | undefined)[]): void {
    for (const v of values) this.addSecret(v);
  }

  redact<T>(input: T): T {
    return this.walk(input) as T;
  }

  redactString(s: string): string {
    let out = s;
    // Declared literals first — they are exact and reliable.
    for (const lit of this.literals) {
      if (lit && out.includes(lit)) out = out.split(lit).join("[REDACTED]");
    }
    for (const p of PATTERNS) out = out.replace(p.re, p.replacement);
    return out;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.redactString(v);
    if (typeof v === "number" && this.literals.includes(String(v))) return "[REDACTED]";
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Keys that are sensitive by name get dropped entirely rather than pattern-matched.
        if (/^(password|passwd|secret|token|apiKey|api_key|authorization|cookie)$/i.test(k)) {
          out[k] = "[REDACTED]";
          continue;
        }
        // Accountability fields survive redaction, deliberately.
        //
        // These identify *staff*, not customers, and the whole purpose of a control-transfer
        // record is to answer "who was holding this session". Scrubbing the operator out of
        // the audit trail satisfies the redaction rule and destroys the thing the rule exists
        // to protect. Customer PII stays redacted; the person who acted does not.
        if (IDENTITY_KEYS.test(k) && typeof val === "string") {
          out[k] = val;
          continue;
        }
        out[k] = this.walk(val);
      }
      return out;
    }
    return v;
  }
}

/** Mask a value for display while keeping enough to correlate, e.g. "12***45". */
export function maskPartial(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.max(1, value.length - 4))}${value.slice(-2)}`;
}
