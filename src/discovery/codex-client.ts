/**
 * Codex CLI as an LLM client.
 *
 * Why this exists: the discovery run has to be genuine, and requiring a raw API key puts a
 * paid dependency in front of anyone who wants to reproduce it. The Codex CLI is already
 * authenticated on the developer's machine against their own account, so this path produces
 * a real model-driven run with **no credentials in the repo, no key in the environment, and
 * nothing to leak**. That is a better security posture than the API-key path, not just a
 * cheaper one.
 *
 * Two details worth noting:
 *
 * - `--output-schema` makes the CLI return structured JSON that matches our action shape, so
 *   we are not parsing prose. That is the same discipline as `response_format: json_object`
 *   on the API path, and it is why the same `extractJson` fallback is still here as a net.
 *
 * - `--sandbox read-only` and `--ephemeral`. The planner is a decision-maker, not an agent
 *   with hands. It must not be able to touch the filesystem or persist state between calls;
 *   the only thing that acts on the world is our own `Surface`, behind our own policy engine.
 *   Letting the planner shell out would put an unpoliced actuator next to a policed one.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmMessage } from "./llm.js";

/**
 * JSON Schema mirroring the action shape in `agent.ts`.
 *
 * Written for OpenAI's *strict* structured-output mode, which has a rule worth knowing:
 * every key in `properties` must also appear in `required`. Optionality is expressed by
 * making the type nullable, not by omitting it from `required`. Getting this wrong returns
 * a 400 rather than degrading, which is arguably the right behaviour — a schema the model
 * cannot satisfy exactly is not a constraint, it is a suggestion.
 */
const nullableString = { type: ["string", "null"] } as const;

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "target", "text", "outputKey", "successText"],
  properties: {
    action: {
      type: "string",
      enum: ["click", "type", "press", "read", "navigate", "done", "give_up"],
    },
    reason: { type: "string" },
    target: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["role", "name", "nameMatch", "frame", "within"],
      properties: {
        role: { type: "string" },
        name: nullableString,
        nameMatch: { type: ["string", "null"], enum: ["exact", "contains", null] },
        frame: nullableString,
        within: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["role", "name", "hasText"],
          properties: {
            role: { type: "string" },
            name: nullableString,
            hasText: nullableString,
          },
        },
      },
    },
    text: nullableString,
    outputKey: nullableString,
    successText: nullableString,
  },
} as const;

export class CodexCliClient implements LlmClient {
  readonly modelId: string;
  private readonly useNpx: boolean;

  /**
   * Defaults to `npx @openai/codex@latest` rather than a locally installed `codex`.
   *
   * Not arbitrary: a system install can be pinned to a version whose configured default
   * model the account is no longer entitled to, which fails at request time with a
   * confusing 400 rather than at startup. Pulling the latest avoids a class of error that
   * has nothing to do with this project. Set `CODEX_USE_NPX=0` to use a local binary.
   */
  constructor() {
    this.useNpx = process.env.CODEX_USE_NPX !== "0";
    this.modelId = `codex-cli:${process.env.CODEX_MODEL ?? "account-default"}`;
  }

  static isAvailable(): boolean {
    if (process.env.CODEX_USE_NPX !== "0") return true; // npx will fetch it on demand
    try {
      execFileSync(process.env.CODEX_BIN ?? "codex", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async complete(system: string, messages: LlmMessage[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "understudy-planner-"));
    const schemaPath = join(dir, "action.schema.json");
    const outPath = join(dir, "action.json");

    try {
      await writeFile(schemaPath, JSON.stringify(ACTION_SCHEMA), "utf8");

      // The CLI is single-shot, so the conversation is flattened into one prompt. The
      // history matters — it is how the agent avoids repeating a refused action — so it is
      // included rather than dropped.
      const prompt = [
        system,
        "",
        "=== CONVERSATION SO FAR ===",
        ...messages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`),
        "",
        "Respond with the single next action as JSON matching the provided schema.",
      ].join("\n");

      const command = this.useNpx ? "npx" : (process.env.CODEX_BIN ?? "codex");
      const args = [
        ...(this.useNpx ? ["-y", "@openai/codex@latest"] : []),
        "exec",
        prompt,
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--config",
        'model_reasoning_effort="low"',
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
      ];
      if (process.env.CODEX_MODEL) args.push("--model", process.env.CODEX_MODEL);

      const { stdout, stderr } = await run(command, args);

      try {
        return await readFile(outPath, "utf8");
      } catch {
        // Fall back to stdout. The CLI usually writes the structured file, but a run that
        // errored late may only have prose, and `extractJson` upstream can often still
        // recover an action from it.
        const diag = `${stderr}\n${stdout}`.trim().slice(-1500);
        if (!diag) throw new Error("Codex produced no output");
        return diag;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else
        reject(
          new Error(
            `codex exited with ${signal ?? code}: ${`${result.stderr}\n${result.stdout}`.trim().slice(-1200)}`
          )
        );
    });
  });
}
