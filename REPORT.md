# Understudy — design write-up

## 1. Architecture

Understudy learns a task inside software that has no API, compiles the successful run into a reusable capability, and executes that capability later without a model.

There are two intentionally different paths:

```
natural-language goal
  → observe screenshot + numbered accessibility candidates
  → LLM proposes one candidate-bound action
  → policy validates and the Surface acts
  → Recorder compiles the successful run
  → draft capability → human review → approved catalog

typed capability invocation
  → validate inputs
  → apply tenant overlay
  → resolve semantic target → act → verify checkpoint
  → ok | declared business outcome | failed | escalated
  → redacted evidence
```

The discovery path is agentic: the model observes, reasons, and chooses the next action. It is bounded by action, step, and wall-clock budgets. A screenshot provides visual context, while numbered accessibility candidates constrain what the model may operate. The runtime ignores invented coordinates and selectors.

The production replay path is deterministic. It has no LLM client import, prompt, or model fallback. It executes the artifact’s ordered steps and classifies the observed state in a fixed order: declared business outcome, bounded recovery, checkpoint, then failure. Every curated replay records `modelInvocations: 0`.

`Surface` is the portability seam. Discovery, replay, policy, artifacts, and escalation depend on observe/resolve/act—not Playwright or the DOM. `WebSurface` implements this with accessibility roles, names, relational table cells, explicit frames, and a browser-request navigation guard. A desktop implementation would supply the same interface through Windows UI Automation or macOS Accessibility APIs.

The target is a deliberately hostile synthetic banking console: frameset navigation, nested layout tables, volatile ASP.NET-style IDs, no test IDs, tenant relabeling, and reproducible failure controls. It is local because the assignment’s important states—permission denial, missing record, session expiry, delayed controls, interstitial recovery, and hard failure—must be safe and deterministic.

## 2. Artifact schema

The artifact is a contract, not a macro recording. The Zod schema validates:

- identity: stable name, schema version, revision, product and supported surface;
- typed inputs and outputs, including sensitivity and input validation;
- ordered discriminated action steps;
- semantic element descriptors and ordered fallbacks;
- a checkpoint for every state-changing step and a final success checkpoint;
- declared business outcomes and bounded recovery rules;
- per-step risk, approval state, and policy snapshot;
- tenant overlays, discovery provenance, and an executable-contract hash.

Values are either literals or typed parameter references. During recording, a typed value equal to a declared discovery input becomes a parameter reference. The recorder does not generalize values merely because they look similar.

The real discovery run exposed a harder problem: the model read a balance cell by its literal currency text. That would pin replay to one member. The recorder now recognizes volatile value shapes, removes value-shaped fallbacks, and converts the target to the relational descriptor “the Balance column in the row containing SAVINGS.” The same artifact is tested against a different member and a second tenant.

Capabilities leave discovery as `draft`. Approval records reviewer identity and time and recomputes the artifact hash. An unapproved irreversible capability is refused; escalation is not a substitute for review.

## 3. Determinism & error handling

Replay performs the same ordered steps for the same artifact. Target resolution uses a confidence ladder: relational table invariant, exact role and accessible name, scoped role/name, then explicit fallbacks. Act-path resolution polls every 250 ms only within a bounded timeout, and evidence records when a late control required multiple attempts. Known visible business outcomes bypass that polling budget.

Each mutation is followed by a checkpoint. A click succeeding is not evidence that the intended state was reached. After every state-changing action, the browser-level navigation guard is rechecked before the executor continues. Redirects, frames, click-triggered navigation, and popups cannot leave the allowlist unnoticed.

The result contract has four arms: three terminal execution results and one non-terminal/pending handoff state.

- `ok`: final checkpoint holds and all declared outputs exist.
- `outcome`: the application produced a known business answer such as `MEMBER_NOT_FOUND`, `NO_SAVINGS_ACCOUNT`, `PERMISSION_DENIED`, or `SESSION_EXPIRED`.
- `failed`: invalid input, policy denial, target drift, unreachable application, surface error, exhausted recovery, checkpoint failure, or timeout, with expected-versus-observed detail and evidence.
- `escalated`: a human owns or abandoned a still-live intervention.

Recoveries are explicit artifact data with attempt limits; replay never asks a model to improvise. Runtime breakage may be offered to an operator. After release, replay makes exactly one deterministic re-resolution or checkpoint verification before continuing or returning the original failure with intervention linkage.

## 4. Heterogeneity & multi-tenant

Semantic accessibility descriptors work on conventional web pages, framesets, and native desktop accessibility trees. The target proves frames and nested tables rather than only a clean SPA. Coordinates are retained only as discovery evidence, never as the primary locator.

Tenant reuse is modeled as one base artifact plus small, reviewable overlays for entry URLs and descriptor relabeling. The same balance capability replays on Riverbend and Summitline, where “Member ID” becomes “Member Number,” without re-recording.

At production scale, API nodes would remain stateless while browser sessions are assigned to isolated workers. Artifacts belong in a versioned database; events in an append-only log; screenshots in encrypted object storage; and interventions in a durable lease queue. Workers scale by active session count, not tenant count. Tenant overlays absorb configuration drift; materially different workflows become separate artifact revisions.

The candidate deployment remains one container so a reviewer can run the full vertical slice. The architecture does not claim the in-memory broker or local evidence filesystem is a distributed production control plane.

## 5. Escalation & handoff

Escalation is a control transfer, not a notification. The broker state machine is:

```
automation → awaiting human → claimed by operator → released → automation
                              ↘ abandoned → automation
```

When policy reaches an approved irreversible step—or when enabled runtime failure cannot be resolved—the broker captures the reason, step, location, screenshot, run ID, and capability identity. The Surface cedes its lease, and all automation actions throw until control returns.

Locally, a second Playwright client can attach over loopback CDP to the same persistent Chromium context, proving that cookies, frames, page state, and the prepared form are unchanged. The Studio’s hosted operator adapter also performs a deliberately small click/type/press vocabulary against that exact paused Surface. It does not create a substitute session.

The operator must claim before acting. Human actions are audited without storing raw typed text. The operator note is retained as audit context but is never parsed or allowed to steer execution. Release returns the lease; replay verifies the guarded step’s declared checkpoint before marking it human-completed and continuing. Cede, claim, action, release, resume, and the final result are written to one evidence stream and one run directory. Timeout or abandonment also restores the Surface lease.

A production implementation needs authenticated operator identity, durable ownership with heartbeat and expiry, streaming or approved remote-session access, and recovery after worker loss. Those are explicit deployment gaps.

## 6. Safety

The model proposes; the runtime disposes. Discovery and replay share the same policy engine.

- URL policy performs exact-host or explicit suffix matching plus optional path prefixes.
- Browser request interception blocks redirects, frame navigation, click navigation, and popups before they leave the allowlist.
- The action vocabulary is allowlisted.
- Per-step risk is frozen into the reviewable artifact.
- Draft irreversible artifacts fail closed; approved irreversible steps follow the configured human policy.
- Step, run-time, recovery, resolution, and handoff waits are bounded.
- Exactly one actor owns the Surface.
- Inputs are validated before browser work.
- Sensitive inputs and outputs are registered with the redactor before evidence is written.
- Raw HTML, credentials, model keys, raw typed operator text, and raw transcripts are not persisted.

Sensitive currency output remains useful without leaking its value into the audit: replay records its type, a hash, and a masked proof. The local synthetic demo can display the fabricated value interactively. Step screenshots are opt-in and explicitly a demo feature; real financial deployment requires screenshot redaction, encryption, access control, and retention policy.

All target records are fabricated in `target-app/data.ts`. No real customer data, bank credentials, or third-party banking system is accessed.

## 7. Cuts

Depth was chosen over breadth.

There is no voice interface, customer CRM, employee task queue, decorative login, real bank integration, or large fabricated dashboard. None strengthens the required discovery → artifact → replay → escalation slice, and partially working breadth would weaken the submission.

The operator UI is intentionally small. It demonstrates the enforced same-session lease and verified resume; it does not pretend to be an institution-grade co-browsing product. Authentication and role-based access are documented production boundaries, not fake local controls.

The optional Capability Studio goes beyond the minimum operator surface only to make the existing execution, evidence, and control-transfer paths inspectable without model credentials. Its four sections are Overview, Run demo, Proof, and Human review; artifact details live beside evidence rather than in a separate workflow. It is a reviewer aid, not a second architecture or a claimed production employee console; the CLI remains the canonical discovery-to-replay path.

Only two stretch directions are pursued:

1. an agent-facing catalog that exposes approved capabilities as typed tool definitions; and
2. cross-tenant reuse through constrained overlays.

The committed evidence is curated by a script that regenerates named cases and asserts that directory labels, result status, business codes, failures, screenshots, handoff transitions, and file paths agree. The verifier also scans for known synthetic sensitive values. This prevents documentation or curation mistakes from contradicting the executable claim.
