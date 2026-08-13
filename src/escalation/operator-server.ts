/**
 * Minimal operator surface.
 *
 * Explicitly mocked, per the brief's scope note: a real co-browsing console is out of scope.
 * What is real here is the *mechanism* — an operator can see the intervention with its
 * context, claim control of the live session, do the work, and hand control back, and every
 * transition is recorded.
 *
 * How the human actually drives the session:
 *   - headed mode  : they use the open browser window. Same context, same cookies, same
 *                    half-filled form. This is the honest demo and what `--headed` is for.
 *   - headless mode: we publish the CDP websocket endpoint. A real console would attach to
 *                    that same browser and stream it. We do not build that streaming UI.
 *
 * The seam is `EscalationBroker`. Swapping this HTML page for a production console changes
 * nothing above it.
 */

import express from "express";
import type { Server } from "node:http";
import type { EscalationBroker, InterventionRequest } from "./escalation.js";

export function startOperatorServer(
  broker: EscalationBroker,
  port: number
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/", (_req, res) => {
    const items = broker.list();
    res.send(page(`
      <h1>Operator queue</h1>
      <p class="muted">Control is currently held by: <b>${broker.controlHolder}</b></p>
      ${items.length === 0 ? "<p>No interventions.</p>" : ""}
      <ul>${items
        .map(
          (r) =>
            `<li><a href="/interventions/${r.id}">${r.id}</a> — ${esc(r.capability)} — <b>${r.state}</b> — ${esc(r.reason)}</li>`
        )
        .join("")}</ul>`));
  });

  app.get("/interventions/:id", (req, res) => {
    const r = broker.get(req.params.id);
    if (!r) return res.status(404).send(page("<h1>Not found</h1>"));
    res.send(page(detail(r)));
  });

  app.post("/interventions/:id/claim", (req, res) => {
    try {
      const operator = String(req.body.operator || "operator@example.invalid");
      broker.claim(req.params.id, operator);
      res.redirect(`/interventions/${req.params.id}`);
    } catch (e) {
      res.status(409).send(page(`<h1>Cannot claim</h1><pre>${esc(String(e))}</pre>`));
    }
  });

  app.post("/interventions/:id/release", async (req, res) => {
    try {
      await broker.release(req.params.id, String(req.body.note || ""));
      res.redirect(`/interventions/${req.params.id}`);
    } catch (e) {
      res.status(409).send(page(`<h1>Cannot release</h1><pre>${esc(String(e))}</pre>`));
    }
  });

  app.post("/interventions/:id/abandon", (req, res) => {
    broker.abandon(req.params.id, String(req.body.reason || "Operator abandoned"));
    res.redirect(`/interventions/${req.params.id}`);
  });

  /** JSON API, so a real console or a test can drive the same transitions. */
  app.get("/api/interventions", (_req, res) => res.json(broker.list()));
  app.post("/api/interventions/:id/claim", (req, res) => {
    try {
      res.json(broker.claim(req.params.id, String(req.body?.operator ?? "api")));
    } catch (e) {
      res.status(409).json({ error: String(e) });
    }
  });
  app.post("/api/interventions/:id/release", async (req, res) => {
    try {
      res.json(await broker.release(req.params.id, req.body?.note));
    } catch (e) {
      res.status(409).json({ error: String(e) });
    }
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function detail(r: InterventionRequest): string {
  const canClaim = r.state === "open";
  const canRelease = r.state === "claimed";
  return `
  <h1>Intervention ${r.id}</h1>
  <table>
    <tr><th>Capability</th><td>${esc(r.capability)}@${r.revision}</td></tr>
    <tr><th>Stopped at step</th><td>${esc(r.stepId ?? "-")}</td></tr>
    <tr><th>Why</th><td><b>${esc(r.reason)}</b></td></tr>
    <tr><th>Location</th><td>${esc(r.location)}</td></tr>
    <tr><th>State</th><td>${r.state}</td></tr>
    <tr><th>Run</th><td>${esc(r.runId)}</td></tr>
    <tr><th>Screenshot</th><td>${esc(r.screenshotPath ?? "-")}</td></tr>
    <tr><th>Live session</th><td>${
      r.liveSessionEndpoint
        ? `<code>${esc(r.liveSessionEndpoint)}</code><div class="muted">Attach a console to this endpoint, or use the open browser window in headed mode. Same session either way.</div>`
        : "<span class='muted'>headed mode — use the open browser window</span>"
    }</td></tr>
    ${r.claimedBy ? `<tr><th>Claimed by</th><td>${esc(r.claimedBy)}</td></tr>` : ""}
    ${r.operatorNote ? `<tr><th>Operator note</th><td>${esc(r.operatorNote)}</td></tr>` : ""}
  </table>

  ${
    canClaim
      ? `<form method="POST" action="/interventions/${r.id}/claim">
           <p><b>Take control of the live session.</b> The automation is paused and will not act until you release.</p>
           <input name="operator" placeholder="your name" value="operator@example.invalid" size="34">
           <button type="submit">Take control</button>
         </form>`
      : ""
  }
  ${
    canRelease
      ? `<form method="POST" action="/interventions/${r.id}/release">
           <p><b>You have control.</b> Do the manual steps in the live session, then hand back.</p>
           <input name="note" placeholder="what you did (recorded for audit)" size="60">
           <button type="submit">Hand control back</button>
         </form>
         <form method="POST" action="/interventions/${r.id}/abandon" style="margin-top:8px">
           <input name="reason" placeholder="reason" size="40">
           <button type="submit">Abandon run</button>
         </form>`
      : ""
  }
  <p style="margin-top:18px"><a href="/">Back to queue</a></p>`;
}

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>Understudy operator</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:32px;max-width:820px;color:#16181d}
    h1{font-size:19px;border-bottom:2px solid #14324f;padding-bottom:6px}
    table{border-collapse:collapse;margin:12px 0;width:100%}
    th{text-align:left;background:#eef1f5;padding:6px 10px;border:1px solid #cdd5e0;width:170px;font-size:13px}
    td{padding:6px 10px;border:1px solid #cdd5e0;font-size:13px}
    form{background:#f7f9fc;border:1px solid #cdd5e0;padding:12px;margin-top:14px}
    button{background:#1f5fa9;color:#fff;border:0;padding:6px 14px;cursor:pointer}
    code{background:#eef1f5;padding:2px 5px}
    .muted{color:#5b6775;font-size:12px}
  </style></head><body>${body}</body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
