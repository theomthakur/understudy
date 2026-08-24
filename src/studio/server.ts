import express from "express";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArtifact, type CapabilityArtifact } from "../domain/artifact.js";
import { replay } from "../replay/replay.js";
import { WebSurface } from "../surface/web-surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "../policy/policy.js";
import { Redactor } from "../policy/redact.js";
import { EvidenceLog, newRunId } from "../evidence/logger.js";
import { EscalationBroker } from "../escalation/escalation.js";
import { startTargetServer, type TargetServer } from "../../target-app/server.js";
import type { HumanAction } from "../surface/surface.js";

const STUDIO_PORT = Number(process.env.PORT ?? process.env.STUDIO_PORT ?? 4317);
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 4471);
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;
const PUBLIC_DEMO = process.env.UNDERSTUDY_PUBLIC_DEMO === "1";

interface LiveIntervention {
  surface: WebSurface;
  broker: EscalationBroker;
  id: string;
  replayPromise: ReturnType<typeof replay>;
}

let liveIntervention: LiveIntervention | undefined;

async function loadArtifact(name = "member.read_savings_balance"): Promise<CapabilityArtifact> {
  return parseArtifact(JSON.parse(await readFile(resolve(`capabilities/${name}.json`), "utf8")));
}

function adaptOrigin(artifact: CapabilityArtifact): CapabilityArtifact {
  const adapted = structuredClone(artifact);
  const oldBase = adapted.application.baseUrl ?? TARGET_ORIGIN;
  adapted.application.baseUrl = TARGET_ORIGIN;
  for (const step of adapted.steps) {
    if (step.action === "navigate" && step.value.kind === "literal") {
      step.value.value = step.value.value.replace(oldBase, TARGET_ORIGIN);
    }
  }
  return adapted;
}

export interface StudioServer {
  origin: string;
  close(): Promise<void>;
}

export async function startStudioServer(port = STUDIO_PORT, startTarget = true): Promise<StudioServer> {
  const target: TargetServer | undefined = startTarget ? await startTargetServer(TARGET_PORT) : undefined;
  // Use the listener's actual loopback address. `localhost` may bind ::1 while a later
  // client lookup chooses 127.0.0.1, which otherwise leaves the embedded surface blank.
  const targetProxyOrigin = target?.origin ?? TARGET_ORIGIN;
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/studio-assets", express.static(resolve("public"), { etag: false, maxAge: 0 }));
  app.use("/evidence", express.static(resolve("evidence"), { etag: false, maxAge: 0 }));
  app.use("/legacy", (req, res) => proxyLegacyTarget(req, res, targetProxyOrigin));

  app.get("/", (_req, res) => res.redirect(302, "/studio"));
  app.get("/studio", (_req, res) => res.sendFile(resolve("public/studio.html")));
  app.get("/healthz", (_req, res) => res.json({ status: "ok", environment: "synthetic", publicDemo: PUBLIC_DEMO }));

  app.get("/api/studio/summary", async (_req, res) => {
    try {
      const artifact = await loadArtifact();
      const [capabilityFiles, evidenceEntries] = await Promise.all([
        readdir(resolve("capabilities"), { withFileTypes: true }),
        readdir(resolve("evidence/curated"), { withFileTypes: true }),
      ]);
      res.json({
        artifact,
        environment: "synthetic",
        targetOrigin: "/legacy",
        modelInvocationsOnReplay: 0,
        capabilities: capabilityFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length,
        evidenceCases: evidenceEntries.filter((entry) => entry.isDirectory()).length,
        knownOutcomes: artifact.businessOutcomes.length,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Could not load capability" });
    }
  });

  app.post("/api/studio/replay", async (req, res) => {
    const memberId = typeof req.body?.memberId === "string" ? req.body.memberId.trim() : "";
    const tenantId = req.body?.tenantId === "summitline" ? "summitline" : undefined;
    if (!/^\d{3,10}$/.test(memberId)) {
      res.status(422).json({ error: "memberId must be a 3–10 digit synthetic member number" });
      return;
    }
    const surface = new WebSurface({ headless: true });
    try {
      await surface.start();
      const result = await replay(adaptOrigin(await loadArtifact()), { memberId }, {
        surface,
        policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
        tenantId,
        evidenceRoot: "evidence/runs",
        captureStepScreenshots: true,
      });
      res.json({ result, completedSteps: result.trace.length, modelInvocations: 0, targetOrigin: TARGET_ORIGIN });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Replay could not run" });
    } finally {
      await surface.close();
    }
  });

  app.get("/api/studio/interventions", (_req, res) => {
    res.json({ interventions: liveIntervention?.broker.list() ?? [], controlHolder: liveIntervention?.broker.controlHolder ?? "automation" });
  });

  app.post("/api/studio/interventions/demo", async (_req, res) => {
    if (liveIntervention) {
      const previous = liveIntervention;
      const request = previous.broker.get(previous.id);
      if (request && request.state !== "released" && request.state !== "abandoned") {
        await previous.broker.abandon(previous.id, "Replaced by a new demonstration run");
      }
      await previous.replayPromise.catch(() => undefined);
      await previous.surface.close();
      liveIntervention = undefined;
    }
    const surface = new WebSurface({ headless: PUBLIC_DEMO, slowMoMs: PUBLIC_DEMO ? 0 : 100 });
    await surface.start();
    const log = new EvidenceLog(newRunId("replay"), new Redactor(), "evidence/runs");
    const broker = new EscalationBroker(surface, log, `http://localhost:${port}/studio`);
    const artifact = adaptOrigin(await loadArtifact("member.open_sub_account"));
    const replayPromise = replay(artifact, { memberId: "12345" }, {
      surface,
      policy: new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] }),
      escalation: broker,
      evidenceRoot: "evidence/runs",
      captureStepScreenshots: true,
      handoffWaitMs: 120_000,
    });
    const intervention = await waitForIntervention(broker, replayPromise);
    if (!intervention) {
      const result = await replayPromise;
      await surface.close();
      res.status(500).json({ error: `Expected escalation, replay completed as ${result.status}` });
      return;
    }
    liveIntervention = { surface, broker, id: intervention.id, replayPromise };
    res.json({ intervention, controlHolder: broker.controlHolder });
  });

  app.post("/api/studio/interventions/:id/claim", (req, res) => {
    try {
      if (!liveIntervention || liveIntervention.id !== req.params.id) throw new Error("Intervention is not active");
      const intervention = liveIntervention.broker.claim(req.params.id, String(req.body?.operator ?? "candidate.reviewer"));
      res.json({ intervention, controlHolder: liveIntervention.broker.controlHolder });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Could not claim intervention" });
    }
  });

  app.post("/api/studio/interventions/:id/release", async (req, res) => {
    try {
      if (!liveIntervention || liveIntervention.id !== req.params.id) throw new Error("Intervention is not active");
      const current = liveIntervention;
      const intervention = await current.broker.release(req.params.id, String(req.body?.note ?? "Operator reviewed the guarded action."));
      const result = await current.replayPromise;
      const humanEvents = current.surface.collectHumanEvents();
      await current.surface.close();
      liveIntervention = undefined;
      res.json({ intervention, result, humanEvents, controlHolder: "automation" });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Could not release intervention" });
    }
  });

  app.post("/api/studio/interventions/:id/act", async (req, res) => {
    try {
      if (!liveIntervention || liveIntervention.id !== req.params.id) throw new Error("Intervention is not active");
      const action = req.body as HumanAction;
      if (!action || !["click", "type", "press"].includes(action.kind)) throw new Error("A valid human action is required");
      await liveIntervention.broker.humanAction(req.params.id, action);
      res.json({
        intervention: liveIntervention.broker.get(req.params.id),
        humanEvents: liveIntervention.surface.collectHumanEvents(),
        controlHolder: liveIntervention.broker.controlHolder,
      });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Could not perform operator action" });
    }
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolveServer) => {
    const instance = app.listen(port, process.env.HOST ?? "127.0.0.1", () => resolveServer(instance));
  });
  const address = server.address();
  if (address && typeof address !== "string") port = address.port;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      if (liveIntervention) {
        await liveIntervention.broker.abandon(liveIntervention.id, "Studio shutting down").catch(() => {});
        await liveIntervention.replayPromise.catch(() => {});
      }
      await liveIntervention?.surface.close();
      liveIntervention = undefined;
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await target?.close();
    },
  };
}

/** One public port, while Playwright still exercises the separately started legacy origin. */
function proxyLegacyTarget(req: express.Request, res: express.Response, targetOrigin: string): void {
  const targetPath = req.originalUrl.replace(/^\/legacy(?=\/|\?|$)/, "") || "/";
  const upstream = http.request(`${targetOrigin}${targetPath}`, {
    method: req.method,
    headers: { ...req.headers, host: `localhost:${TARGET_PORT}` },
  }, (upstreamResponse) => {
    const chunks: Buffer[] = [];
    upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamResponse.on("end", () => {
      const headers = { ...upstreamResponse.headers };
      if (typeof headers.location === "string" && headers.location.startsWith("/")) headers.location = `/legacy${headers.location}`;
      delete headers["content-length"];
      res.status(upstreamResponse.statusCode ?? 502);
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) res.setHeader(name, value);
      const body = Buffer.concat(chunks);
      if (String(headers["content-type"] ?? "").includes("text/html")) {
        const html = body.toString("utf8").replace(/(href|src|action)=(["'])\//g, "$1=$2/legacy/");
        res.send(Buffer.from(html));
      } else res.send(body);
    });
  });
  upstream.on("error", (error) => res.status(502).json({ error: `Synthetic target unavailable: ${error.message}` }));
  req.pipe(upstream);
}

async function waitForIntervention(
  broker: EscalationBroker,
  replayPromise: ReturnType<typeof replay>
) {
  let settled = false;
  void replayPromise.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !settled) {
    const intervention = broker.list().at(-1);
    if (intervention) return intervention;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = await startStudioServer();
  console.log(`Understudy Capability Studio: ${server.origin}/studio`);
  console.log(`Synthetic hostile target: ${TARGET_ORIGIN}`);
}
