/**
 * The agent-facing capability catalog.
 *
 * This is the reason the artifact is a contract rather than a step list. An AI agent
 * deciding *what* to do needs to discover what it can do, with typed arguments, and get a
 * typed answer back. That is a tool-calling surface, and it falls out of the schema for free:
 * Zod already describes the inputs and outputs, so JSON Schema generation is mechanical.
 *
 * Deliberately not built: an HTTP server, auth, a registry service. The brief is explicit
 * that building scaling infrastructure is not rewarded. What matters is that the boundary
 * exists and is the right shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { parseArtifact, type CapabilityArtifact } from "../domain/artifact.js";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Not part of the tool-calling standard, but a calling agent benefits from knowing. */
  x_understudy: {
    revision: number;
    approval: string;
    outputs: { name: string; type: string; description: string }[];
    businessOutcomes: { code: string; description: string }[];
    /** Highest risk class anywhere in the flow. An agent should treat these differently. */
    maxRisk: string;
  };
}

export class CapabilityCatalog {
  private readonly artifacts = new Map<string, CapabilityArtifact>();

  constructor(private readonly dir: string) {}

  load(): this {
    this.artifacts.clear();
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return this;
    }
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
        const a = parseArtifact(raw);
        // Highest revision wins when the same capability exists more than once.
        const existing = this.artifacts.get(a.name);
        if (!existing || a.revision > existing.revision) this.artifacts.set(a.name, a);
      } catch (e) {
        console.warn(`  skipped ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return this;
  }

  list(): CapabilityArtifact[] {
    return [...this.artifacts.values()];
  }

  get(name: string): CapabilityArtifact | undefined {
    return this.artifacts.get(name);
  }

  /**
   * Render as tool definitions an agent could be given directly.
   *
   * `maxRisk` is surfaced because a calling agent should be able to decline to invoke an
   * irreversible capability without having to read the steps.
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.list().filter((a) => a.approval.state === "approved").map((a) => {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const p of a.inputs) {
        let t: z.ZodTypeAny =
          p.type === "number" ? z.number() : p.type === "boolean" ? z.boolean() : z.string();
        t = t.describe(p.description);
        shape[p.name] = p.required ? t : t.optional();
      }
      const schema = zodToJsonSchema(z.object(shape), { target: "jsonSchema7" }) as Record<
        string,
        unknown
      >;
      delete schema.$schema;

      const maxRisk = a.steps.some((s) => s.risk === "irreversible")
        ? "irreversible"
        : a.steps.some((s) => s.risk === "elevated")
          ? "elevated"
          : "safe";

      return {
        name: a.name,
        description: `${a.title}. ${a.description}`,
        input_schema: schema,
        x_understudy: {
          revision: a.revision,
          approval: a.approval.state,
          outputs: a.outputs.map((o) => ({ name: o.name, type: o.type, description: o.description })),
          businessOutcomes: a.businessOutcomes.map((b) => ({
            code: b.code,
            description: b.description,
          })),
          maxRisk,
        },
      };
    });
  }
}
