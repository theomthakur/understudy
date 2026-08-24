/**
 * Stand-in back-office console for a credit union.
 *
 * Why a local app rather than a public demo site:
 *   1. The brief's interesting failures are runtime states, not layout drift. I need to be
 *      able to *cause* a "record not found", a permission denial, a session timeout and a
 *      transient slowdown on demand. No public site lets me do that.
 *   2. It lets the surface be legitimately hostile (frameset, table layout, no test IDs)
 *      rather than pretending a clean demo site is legacy.
 *   3. Two tenant variants of the same product cost almost nothing here, which is what the
 *      cross-tenant reuse story needs.
 *   4. No terms of service, no rate limits, and the reviewer can reproduce every run.
 *
 * Fault injection is via query params or the /__fault control endpoint, so a replay test can
 * deterministically produce each exceptional state.
 */

import express, { type Request, type Response } from "express";
import { pathToFileURL } from "node:url";
import { findMember, money, MEMBERS } from "./data.js";
import * as V from "./views.js";

const PORT = Number(process.env.TARGET_PORT ?? 4471);

/**
 * Two tenants running the same vendor product, configured and branded differently.
 * `riverbend` is the base; `summitline` is the variant used to demonstrate that one
 * recorded artifact can be applied across tenants.
 */
const TENANTS: Record<string, { label: string; searchLabel: string }> = {
  riverbend: { label: "Riverbend Credit Union", searchLabel: "Member ID" },
  summitline: { label: "Summitline FCU", searchLabel: "Member Number" },
};

type FaultKind = "none" | "session" | "apperror" | "slow" | "interstitial";
let activeFault: FaultKind = "none";
let faultBudget = 0; // how many more requests the fault applies to

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use(express.urlencoded({ extended: false }));

function tenantOf(req: Request): { key: string; label: string; searchLabel: string } {
  const key = String(req.query.tenant ?? "riverbend");
  const t = TENANTS[key] ?? TENANTS.riverbend!;
  return { key, ...t };
}

/** Consume one unit of the active fault budget, if any. */
function takeFault(): FaultKind {
  if (faultBudget > 0 && activeFault !== "none") {
    faultBudget -= 1;
    const f = activeFault;
    if (faultBudget === 0) activeFault = "none";
    return f;
  }
  return "none";
}

async function maybeSlow(kind: FaultKind): Promise<void> {
  if (kind === "slow") await new Promise((r) => setTimeout(r, 6000));
}

/** Fault control. Used by tests and by the "replay hits an exceptional state" evidence run. */
app.all("/__fault", (req: Request, res: Response) => {
  const kind = String(req.query.kind ?? "none") as FaultKind;
  const times = Number(req.query.times ?? 1);
  activeFault = kind;
  faultBudget = kind === "none" ? 0 : Math.max(1, times);
  res.type("text/plain").send(`fault=${activeFault} budget=${faultBudget}\n`);
});

app.get("/__health", (_req, res) => res.type("text/plain").send("ok\n"));

app.get("/__fixture-summary", (_req, res) => {
  const accounts = MEMBERS.flatMap((member) => member.accounts);
  res.json({
    members: MEMBERS.length,
    accounts: accounts.length,
    branches: countBy(MEMBERS.map((member) => member.branch)),
    accountTypes: countBy(accounts.map((account) => account.type)),
    accountStates: countBy(accounts.map((account) => account.status)),
    restrictedMembers: MEMBERS.filter((member) => member.restricted).length,
  });
});

app.get("/policy-probe", (_req, res) => {
  res.send(`<!doctype html><html><head><title>Policy Probe</title></head><body>
    <h1>Policy Probe</h1>
    <a href="https://example.com/forbidden">Leave approved application</a>
    <a href="https://example.com/popup" target="_blank">Open forbidden popup</a>
  </body></html>`);
});

app.get("/", (req, res) => {
  const t = tenantOf(req);
  const fault = activeFault === "slow" ? takeFault() : "none";
  res.send(V.searchPage(t.label, req.query.error ? String(req.query.error) : undefined, fault === "slow" ? 1800 : 0));
});

app.get("/frame/header", (req, res) => {
  const t = tenantOf(req);
  res.send(V.headerFrame(t.label, String(req.query.memberId ?? "")));
});

/** Search submit. Validation and not-found are *business outcomes*, not crashes. */
app.get("/members/lookup", async (req, res) => {
  const t = tenantOf(req);
  const fault = takeFault();
  await maybeSlow(fault);

  if (fault === "session") return res.send(V.sessionExpired(t.label));
  if (fault === "apperror") return res.status(500).send(V.appError(t.label));

  const raw = String(req.query.memberId ?? "").trim();

  if (raw === "") {
    return res.send(V.searchPage(t.label, "Member ID is required."));
  }
  if (!/^\d+$/.test(raw)) {
    return res.send(V.searchPage(t.label, "Member ID must be numeric."));
  }

  const member = findMember(raw);
  if (!member) {
    return res.send(V.searchPage(t.label, `No member found with ID ${raw}.`));
  }
  if (member.restricted) {
    return res.status(403).send(V.permissionDenied(t.label, raw));
  }

  res.redirect(`/workspace?memberId=${encodeURIComponent(raw)}&tenant=${encodeURIComponent(t.key)}`);
});

app.get("/workspace", (req, res) => {
  const t = tenantOf(req);
  res.send(V.workspaceFrameset(t.label, String(req.query.memberId ?? "")));
});

app.get("/frame/member", async (req, res) => {
  const t = tenantOf(req);
  const fault = takeFault();
  await maybeSlow(fault);
  if (fault === "session") return res.send(V.sessionExpired(t.label));
  if (fault === "apperror") return res.status(500).send(V.appError(t.label));

  const id = String(req.query.memberId ?? "");
  const member = findMember(id);
  if (!member) return res.send(V.searchPage(t.label, `No member found with ID ${id}.`));
  if (member.restricted) return res.status(403).send(V.permissionDenied(t.label, id));

  res.send(
    V.memberDetailFrame({
      tenant: t.label,
      memberId: member.memberId,
      fullName: `${member.firstName} ${member.lastName}`,
      branch: member.branch,
      joinedOn: member.joinedOn,
      maskedSsn: `***-**-${member.ssnLast4}`,
      accounts: member.accounts.map((a) => ({
        accountNumber: a.accountNumber,
        type: a.type,
        balance: money(a.balance),
        status: a.status,
      })),
      notice:
        fault === "interstitial"
          ? { kind: "warn", text: "Scheduled maintenance tonight 01:00-03:00. Dismiss to continue." }
          : undefined,
    })
  );
});

app.get("/accounts/:acct", async (req, res) => {
  const t = tenantOf(req);
  const fault = takeFault();
  await maybeSlow(fault);
  if (fault === "session") return res.send(V.sessionExpired(t.label));

  const memberId = String(req.query.memberId ?? "");
  const member = findMember(memberId);
  const acct = member?.accounts.find((a) => a.accountNumber === req.params.acct);
  if (!member || !acct) return res.status(404).send(V.appError(t.label));

  res.send(
    V.accountDetailFrame({
      tenant: t.label,
      memberId: member.memberId,
      accountNumber: acct.accountNumber,
      type: acct.type,
      balance: money(acct.balance),
      status: acct.status,
      openedOn: acct.openedOn,
    })
  );
});

/** Irreversible-action path: always goes through an explicit confirmation screen. */
app.post("/members/:id/subaccount", (req, res) => {
  const t = tenantOf(req);
  res.send(V.confirmSubAccount(t.label, req.params.id));
});

app.post("/members/:id/subaccount/confirm", (req, res) => {
  const t = tenantOf(req);
  const nickname = String(req.body?.nickname ?? "").trim();
  if (nickname === "") {
    return res.send(V.confirmSubAccount(t.label, req.params.id).replace(
      '<div class="warn"',
      '<div class="err" role="alert">Nickname is required.</div><div class="warn"'
    ));
  }
  const member = findMember(req.params.id);
  if (!member) return res.send(V.searchPage(t.label, `No member found with ID ${req.params.id}.`));

  res.send(
    V.chrome({
      title: "Sub-Account Opened",
      tenant: t.label,
      body: `<div class="panel">
        <h2>Sub-Account Opened</h2>
        <div class="ok" role="alert">Sub-account "${nickname}" opened for member ${member.memberId}.</div>
        <table class="grid">
          <tr><th>New Account</th><td id="ctl00_MainPlaceHolder_lblNewAccount">SV-${member.memberId}-02</td></tr>
          <tr><th>Status</th><td>OPEN</td></tr>
        </table>
        <p><a href="/frame/member?memberId=${encodeURIComponent(member.memberId)}">Back to Member Profile</a></p>
      </div>`,
    })
  );
});

app.use((_req, res) => res.status(404).send(V.appError("Riverbend Credit Union")));

export interface TargetServer {
  origin: string;
  close(): Promise<void>;
}

export async function startTargetServer(port = PORT): Promise<TargetServer> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const instance = app.listen(port, "localhost", () => resolve(instance));
  });
  const origin = `http://localhost:${port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = await startTargetServer(PORT);
  console.log(`target-app listening on ${target.origin}`);
  console.log(`  tenants:  ?tenant=riverbend (base) | ?tenant=summitline (variant)`);
  console.log(`  faults:   GET /__fault?kind=session|apperror|slow|interstitial&times=1`);
  console.log(`  members:  12345 ok · 22871 ok · 30099 restricted · 44120 no savings · 99999 not found`);
}
