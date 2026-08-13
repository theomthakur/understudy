# Understudy — design write-up

An understudy learns the part by watching, then performs it without the star. That is the whole
system: a model discovers a flow once, the flow becomes a typed capability, and every
subsequent invocation runs deterministically with no model in the loop.

---

## 1. Architecture

Five modules, one seam that matters.

```
   goal + params                                    agent invocation
        │                                                  │
        ▼                                                  ▼
  ┌───────────┐   records    ┌──────────────┐   loads   ┌────────┐
  │ discovery │─────────────▶│  capability  │◀──────────│ replay │
  │  (LLM)    │              │   artifact   │           │ (no LLM)│
  └─────┬─────┘              └──────────────┘           └───┬────┘
        │                                                    │
        └────────────┬──────────────┬────────────────────────┘
                     ▼              ▼
                ┌─────────┐   ┌──────────┐
                │ policy  │   │ Surface  │◀── the seam
                └─────────┘   └────┬─────┘
                                   │
                          ┌────────┴────────┐
                     WebSurface        (DesktopSurface)
                    a11y tree via        platform a11y
                     Playwright            APIs — not built
                                   │
                            ┌──────┴──────┐
                            │ escalation  │ pause / cede / resume
                            └─────────────┘
```

**`Surface` is the only abstraction that earns its keep.** Everything above it — the artifact
schema, the replay engine, the policy layer, the discovery agent — is written against three
operations: *observe*, *resolve*, *act*. None of them import Playwright or know a browser
exists. A desktop implementation is a new class here and nothing else moves. That claim is the
load-bearing part of §4, so it is worth being precise: `src/surface/surface.ts` has no
browser-specific type in it, and `WebSurface` is the only file that imports Playwright.

**Key decisions and their trade-offs**

| Decision | Why | What it costs |
|---|---|---|
| **Perceive via accessibility tree, not DOM** | It is what a human operator perceives, it survives markup with no test IDs, and it is the one representation that also exists on desktop | Loses information a DOM would give — computed styles, exact geometry. Fine here; it would not be fine for a pixel-level task. |
| **Discovery and replay share one policy engine** | A model that tries something dangerous during discovery is stopped by the same code that would stop it in production. Two policy implementations would drift, and the one that drifts is the one nobody tests. | Discovery is slightly more constrained than a pure exploration agent would be. Deliberate. |
| **Local stand-in app rather than a public demo site** | The interesting failures here are runtime states, not layout drift. I need to *cause* a permission denial, a session timeout, a not-found. No public site allows that, and automating one for this would be a terms-of-service problem. | The app is mine, so it cannot surprise me. Mitigated by making it genuinely hostile: frameset, nested layout tables, no test IDs, index-bearing ASP.NET-style ids. |
| **TypeScript + Zod** | One schema definition yields the type, runtime validation, and the JSON Schema the agent-facing catalog needs. Given the artifact is the focal point, having one source of truth for it mattered more than language preference. | Node's browser-automation ecosystem is good; its desktop-automation ecosystem is weaker than Python's. If desktop were the first target rather than the second, I would revisit. |
| **No agent framework** | The loop needs one thing from a model: given this observation, return the next action as JSON. A framework would add a dependency, a lifecycle, and a debugging surface for something that is forty lines. | Reimplementing anything a framework would have given later. Accepted; there is one graph. |
| **Single process, synchronous** | The brief says building scaling infrastructure is not rewarded. A queue here would be ceremony. | Not production-shaped. The seams that would matter (broker, catalog) are interfaces, so adding a queue behind them is not a rewrite. |

---

## 2. Artifact schema

`src/domain/artifact.ts`. Four properties drove the shape.

**It is a contract, not a recording.** A calling agent needs to know what the capability
requires, what it returns, and how success is judged. So `inputs`, `outputs` and
`successCheckpoint` are declared separately from `steps`, and steps reference inputs by name
rather than embedding literals. A step list alone is a macro; this is a function signature.

**Targeting is semantic, never syntactic.** A step stores `{ role, name, nameMatch, within,
frame }` plus an ordered fallback ladder. **It never stores a CSS selector or an element id**,
and in this app that is not squeamishness: the ids look like
`ctl00_MainPlaceHolder_grdAccounts_ctl03_lnkView`. That `ctl03` is a row index. Recording it
gives you a locator that passes today and silently targets the wrong account the day a row is
inserted — the worst failure mode available, because it is wrong rather than broken.

**`within.hasText` exists because of a specific problem, and it is the piece I would point at
first.** The accounts grid sits inside a nested layout table, so the outer `<td>` wrapping the
grid is *itself* a `cell`. "The cell containing a dollar amount" matches the wrapper before the
real one. The row cannot be addressed by name either, because a row's accessible name includes
the balance — the very value that varies per member. The answer is to scope to the row that
mentions a stable word and then match the cell:

```json
{ "role": "cell", "name": "^\\$[0-9,.]+$", "nameMatch": "regex",
  "within": { "role": "row", "hasText": "SAVINGS" } }
```

That is what a human does, and it holds for any member. It is also the thing that took the
longest to get right, and the reason the schema has a `within` at all.

**Business outcomes and recoveries live in the artifact, not in replay code.** `MEMBER_NOT_FOUND`
is data, with a detection rule and a code the caller branches on. Putting it in code would mean
every new application needs a code change; putting it in the artifact means it is reviewable
alongside the flow it belongs to.

**What is deliberately *not* in the artifact:** the model transcript. `provenance.transcriptRef`
points at the evidence file instead. The artifact is the reviewed, executable contract; the
transcript is how it came to exist. Conflating them would make artifacts unreviewable and would
tempt replay into reading model prose at run time.

**Versioning** is two-level: `schemaVersion` for the format, `revision` for the artifact's own
content, so a capability can be re-recorded or hand-corrected with history.

---

## 3. Determinism and error handling

**How replay is deterministic.** No model call on any path — not for decisions, not for
recovery, not for locating a control. Locators resolve through a fixed ladder in a fixed order.
Every state-changing step carries a checkpoint, so the engine asserts it arrived rather than
assuming the click worked. Inputs are validated against the declared contract before the
browser is touched, so a contract violation costs nothing. Same artifact, same inputs, same app
state produces the same steps and the same outputs; there is a test that runs a capability twice
and asserts the outputs are identical.

**The classification loop is the actual design.** After every step, before concluding anything
is wrong, the engine asks in this order:

1. **Is this a declared business outcome?** → return `outcome`, not an error
2. **Is this a known recoverable condition?** → remedy it, bounded, retry the step
3. **Did the checkpoint pass?** → continue
4. **Otherwise** → `failed`, with expected vs observed

**The ordering is the point.** Checking business outcomes first is what stops "no such member"
being reported as a broken capability. The brief calls conflating those two the most common
design mistake here, so it is a first-class type rather than a convention:

```ts
type ReplayResult = OkResult | OutcomeResult | FailedResult | EscalatedResult
```

`escalated` is a fourth arm rather than a failure because a run waiting on a human is neither
finished nor broken, and collapsing it into `failed` would lose the distinction between "this
needs a person" and "this is wrong".

**The three classes, concretely, all covered by tests:**

| Class | Example | Behaviour |
|---|---|---|
| Business outcome | member 99999 does not exist · member 30099 is restricted · session expired | `outcome` with a code the caller branches on |
| Recoverable | maintenance interstitial covering the profile | remedy applied, step retried, bounded by `maxAttempts`, run continues |
| Hard failure | a control that no longer exists · policy denial · invalid input | `failed` with the step id, what was expected, what was observed, plus a screenshot |

**Bounded recovery.** Every recovery rule has `maxAttempts`. Exceeding it produces
`recovery_exhausted` rather than looping — an unbounded self-healing loop is a worse failure
than the condition it was healing.

**Session expiry is terminal on purpose.** It looks recoverable, and it is not something
automation should fix by re-authenticating with stored credentials. It is reported to the
caller.

**On UI drift**, which the brief rightly ranks second: the fallback ladder degrades rather than
failing. Primary is role + exact name; beneath it, the same role with a substring match, then a
label association, then visible text — each annotated with why it is weaker. The winning
strategy is reported in the result, so a run that only passed via the third fallback shows up in
evidence as a warning about the next run. Losing that signal is how brittle capabilities stay
green until they suddenly do not.

---

## 4. Heterogeneity and multi-tenant

**Surface abstraction.** The seam is `observe / resolve / act` over an accessibility model, and
the reason it generalises is that a11y trees are not a browser feature — Windows UIA and macOS
AX expose the same role-and-name shape for native controls. So a desktop implementation supplies
`observe()` from the platform tree and `resolve()` from the same role/name descriptor, and **the
artifact schema does not change at all.** `application.surface` already carries
`web | legacy-web | desktop` so a capability declares what it was recorded against.

What genuinely would not port: the `frame` field, which is web-specific. On desktop the
equivalent is a window or pane, so the honest version is that `frame` should become a more
general `container` before a desktop surface ships. I left it web-shaped rather than inventing
an abstraction with one implementation, but that is the first thing I would change.

**Multi-tenant reuse.** Hundreds of tenants run the same vendor product with different branding.
Re-recording per tenant does not scale, so an artifact is one base flow plus small, explicit
overlays:

```json
"tenantOverlays": [
  { "tenantId": "summitline", "baseUrl": "...?tenant=summitline", "descriptorOverrides": {} }
]
```

An overlay can change the entry URL and patch individual step descriptors. Nothing else. **The
weakness is deliberate** — anything an overlay cannot express is a genuinely different flow and
should be a different artifact. A more powerful overlay language would absorb real divergence
into a pile of conditionals and make drift invisible.

In practice most branding drift never reaches the overlay at all, because the fallback ladder
handles it: Riverbend labels the field "Member ID", Summitline labels it "Member Number", and the
substring fallback matches both. There is a test that runs the base artifact unmodified against
the second tenant.

**Detecting drift** is the part I designed but did not build. The mechanism I would use is
already half-present: replay reports which strategy resolved each control. A capability that
starts resolving via fallback rather than primary on one tenant is drifting *before* it breaks.
Aggregate that per tenant and per product version and you get an early warning instead of a
Monday-morning outage. That is the highest-value next thing.

---

## 5. Escalation and handoff

**Detecting stuck.** Three sources, all of which route through one broker: an irreversible step
reached under a policy set to escalate; a recovery rule exhausted; a hard failure the caller
configured to escalate rather than fail.

**Control transfer is a state machine on the session, not a flag:**

```
AUTOMATION ──raise()──▶ AWAITING_HUMAN ──claim()──▶ HUMAN ──release()──▶ AUTOMATION
     ▲                                                 │
     └──────────────── abandon() ──────────────────────┘
```

Two rules make it safe. **Exactly one party holds control**, and `WebSurface` enforces it —
every action calls `assertControl()` and throws if a human holds the session, so a resumed run
cannot race an operator who is still typing. There is a test for this. And **every transition is
recorded as evidence**, because "who was in control when this happened" is a question you will be
asked about a banking system.

**Same session, not a new one — and this part is real, not mocked.** The browser is launched via
`chromium.launchServer()`, which yields a `wsEndpoint`. The automation connects to it as a
client. An operator console connects to the *same* endpoint with `chromium.connect()` and gets
the same browser, same context, same cookies, same half-filled form. In headed mode the human
simply uses the window that is already open. The endpoint is published on the intervention record.

**What is real vs mocked**, stated plainly because the brief asks:

| Real | Mocked |
|---|---|
| The broker, the state machine, all four transitions | The operator console's UI. It is a plain HTML page. |
| Enforcement that automation cannot act while a human holds control | Live video streaming of the session |
| The live-session endpoint, and the fact that it is the same browser | Auth, operator identity, queue routing |
| Context handed over: capability, step, reason, location, screenshot | |
| The audit trail, including the operator's note | |
| A bounded wait with automatic abandon on timeout | |

**The operator's note is stored and never parsed.** It is audit evidence. A human note that
could steer automation would be a very effective way to smuggle an instruction past the policy
layer.

---

## 6. Safety

Three separate concerns, kept separate because they fail differently.

**Allowlist.** Hosts and optional path prefixes, checked before every navigation in both
discovery and replay. Host matching is exact or explicit leading-dot suffix, so
`bank.example.evil.com` does not match `bank.example` — there is a test for precisely that,
because substring host matching is a classic bypass.

**Risk classification, frozen at record time.** Every step carries `safe | elevated |
irreversible`, decided during recording and stored in the artifact rather than inferred at run
time. That makes it *reviewable*: a human approving a capability can see which steps are
irreversible before it ever runs unattended. Classification is deliberately crude and
conservative — anything matching confirm, submit, transfer, delete, open account is
irreversible. Over-classifying costs a review; under-classifying opens an account.

**Approval gates unattended risk.** Artifacts are born `draft`. An irreversible step in a draft
artifact is **refused outright, not escalated**. That asymmetry is intentional: escalating an
unreviewed capability would put it in front of a human as though it were routine. Review is the
control; escalation is not a substitute for it. Approved artifacts escalate instead.

**Redaction is structural.** Everything written to evidence passes through `Redactor` inside
`EvidenceLog.event()`, not at call sites, because relying on every call site to remember is how
secrets end up in logs. Two layers: declared sensitive inputs matched literally (reliable), and
pattern detection for SSNs, card-like digit runs, bearer tokens, emails (unreliable). **Raw page
text is never persisted** — observations are stored as role/name control trees, and read values
only when the artifact declares them as outputs.

**Limits, honestly:**

- The allowlist constrains what the *agent* does, not what a page does. It is not a network
  control. A real deployment wants egress filtering underneath it.
- Pattern redaction finds shapes it knows. Free-text PII in a notes field will pass through. The
  declared-sensitive list is the reliable half; patterns are defence in depth.
- Risk classification is keyword-based. A button labelled "Proceed" that wires money is
  classified safe. In production this belongs in the per-application knowledge base as an
  explicit control list, not in a regex.
- Screenshots on failure may capture regulated data. They are the most useful debugging artifact
  and the biggest data-handling liability in the system. I kept them because a bank cannot debug
  without them, but they need retention limits and access control that I have not built.
- Nothing here is a defence against a compromised model deciding to be adversarial. The policy
  engine constrains *actions*; it does not reason about intent.

---

## 7. Cuts

**Deliberately not built:**

- **A real operator console.** Out of scope per the brief. The mechanism, the state machine and
  the live-session endpoint are real; the UI is a plain page.
- **A desktop surface.** The seam exists and is genuinely browser-free, but only `WebSurface`
  implements it. Claiming otherwise without a second implementation would be dishonest.
- **Queues, workers, multi-tenant plumbing.** The brief says building scaling infrastructure is
  not rewarded. The abstractions do not preclude it.
- **`select` action.** In the schema, throws if used. The target app has no select element and
  implementing it untested would be worse than the explicit gap.
- **Assisted LLM fallback on replay failure.** Tempting and listed as a stretch goal, but it
  weakens the central claim that replay is model-free. If I added it, it would be a separate,
  explicitly-flagged execution mode with a single-step bound and a policy check, never the
  default.

**What I would build next, in order:**

1. **Drift detection from resolution telemetry.** Replay already reports which strategy resolved
   each control. Aggregating that per tenant and version turns "this broke" into "this is
   degrading". Highest value for least work, and it is the thing that makes the multi-tenant
   story operational rather than theoretical.
2. **Confidence scoring and an approval workflow.** Replay N times, record a stability signal,
   gate `draft → approved` on it. The approval state already exists; nothing computes it.
3. **Generalise `frame` to `container`** so the desktop seam is honest rather than aspirational.
4. **A structured diff between artifact revisions**, so re-recording a capability produces a
   reviewable change rather than an opaque replacement.
5. **Retention and access control on screenshots**, which is the clearest gap between this and
   something that could touch real data.

**Time spent:** roughly a focused day. The scaffolding came together quickly with AI assistance,
as the brief anticipates; the time went into the artifact schema, the `within.hasText` targeting
problem, and getting the three-way result contract right. Those are the parts I would defend
line by line.
