/**
 * Provider-agnostic LLM client.
 *
 * Deliberately thin. Two providers behind one interface, no framework. The agent loop needs
 * exactly one thing from a model — "given this observation, return the next action as JSON" —
 * and wrapping that in an agent framework would add a dependency, a lifecycle and a debugging
 * surface without buying anything the loop does not already do explicitly.
 *
 * Temperature is 0 and the response must be JSON. Discovery is inherently non-deterministic,
 * but that is a reason to constrain it, not to shrug.
 */

import { CodexCliClient } from "./codex-client.js";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmClient {
  readonly modelId: string;
  complete(system: string, messages: LlmMessage[], image?: { mimeType: "image/png"; data: Buffer }): Promise<string>;
}

class AnthropicClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    readonly modelId: string
  ) {}

  async complete(system: string, messages: LlmMessage[], image?: { mimeType: "image/png"; data: Buffer }): Promise<string> {
    const apiMessages = messages.map((message, index) => {
      if (!image || index !== messages.length - 1 || message.role !== "user") return message;
      return {
        role: message.role,
        content: [
          { type: "text", text: message.content },
          { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") } },
        ],
      };
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: 1400,
        temperature: 0,
        system,
        messages: apiMessages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    return json.content.map((c) => c.text ?? "").join("").trim();
  }
}

class OpenAiCompatibleClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    readonly modelId: string,
    private readonly baseUrl: string
  ) {}

  async complete(system: string, messages: LlmMessage[], image?: { mimeType: "image/png"; data: Buffer }): Promise<string> {
    const apiMessages = messages.map((message, index) => {
      if (!image || index !== messages.length - 1 || message.role !== "user") return message;
      return {
        role: message.role,
        content: [
          { type: "text", text: message.content },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data.toString("base64")}` } },
        ],
      };
    });
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        temperature: 0,
        max_tokens: 1400,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, ...apiMessages],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compatible ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return (json.choices[0]?.message.content ?? "").trim();
  }
}

export function createLlmClient(): LlmClient {
  const explicit = process.env.UNDERSTUDY_PROVIDER;
  const anth = process.env.ANTHROPIC_API_KEY;
  const oai = process.env.OPENAI_API_KEY;

  // Codex CLI is preferred when nothing else is configured, because it uses the developer's
  // existing local authentication. No key enters the repo, the environment, or the evidence,
  // which is a better posture for a project whose whole subject is handling regulated data.
  const provider =
    explicit ?? (anth ? "anthropic" : oai ? "openai" : CodexCliClient.isAvailable() ? "codex" : undefined);

  if (provider === "codex") return new CodexCliClient();

  if (provider === "anthropic") {
    if (!anth) throw new MissingKeyError("ANTHROPIC_API_KEY");
    return new AnthropicClient(anth, process.env.UNDERSTUDY_MODEL || "claude-sonnet-4-20250514");
  }
  if (provider === "openai") {
    if (!oai) throw new MissingKeyError("OPENAI_API_KEY");
    return new OpenAiCompatibleClient(
      oai,
      process.env.UNDERSTUDY_MODEL || "gpt-4o-mini",
      process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
    );
  }
  throw new MissingKeyError("ANTHROPIC_API_KEY or OPENAI_API_KEY (or install the Codex CLI)");
}

export class MissingKeyError extends Error {
  constructor(which: string) {
    super(
      `No model credentials found. Set ${which} in .env to run discovery.\n` +
        `Replay does not need a key — it never calls a model.`
    );
    this.name = "MissingKeyError";
  }
}

/**
 * Models wrap JSON in prose or fences even when told not to. Recovering from that in one
 * place is better than making the caller defensive.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error(`Model did not return JSON. Got: ${text.slice(0, 300)}`);
  }
}
