# Understudy: design write-up

## 1. Architecture

Understudy learns a task in software that has no suitable API, turns the successful path into a capability, and runs that capability later without a model.

There are two connected paths:

```text
DISCOVERY: natural-language goal -> model observes and proposes -> policy checks
           -> Surface acts -> Recorder creates draft -> person approves

REPLAY:    typed invocation -> validate input and tenant -> run saved steps
           -> check results -> ok | outcome | failed | escalated
```

Discovery is the only path with a model. On each step, the model receives a screenshot for visual context and a numbered list of controls it may use. It cannot act through a selector, coordinate, or element that the runtime did not provide. Step count, action count, and total time are limited.

Replay is deliberately different. It has no model client, prompt, or model fallback. It validates the input, applies any tenant-specific labels, follows the saved steps, checks the resulting screen, and records evidence. Every committed replay reports `modelInvocations: 0`.

Both paths use the same four services:

- `PolicyEngine` checks hosts, routes, action types, risk, and time limits.
- `Surface` is the single interface for observing and operating a UI.
- `EvidenceLog` records what happened after registered sensitive values are redacted.
- `EscalationBroker` transfers ownership of the same live session to a person.

Only `WebSurface` knows that the current implementation uses Playwright. A future desktop implementation could provide the same observe, resolve, and act operations through Windows UI Automation or macOS Accessibility without changing discovery, replay, policy, or the artifact.

The target is a local synthetic banking console with frames, nested tables, changing IDs, no test IDs, tenant-specific labels, and controlled error switches. It is local so exceptional states can be tested safely and repeatedly.

## 2. Artifact schema

The artifact is a reviewed contract, not a raw macro recording. Its runtime-validated schema contains:

- name, schema version, revision, application, and supported UI type;
- typed inputs and outputs, including validation and sensitivity;
- ordered steps whose fields depend on the action type;
- accessible descriptions of each target and ordered fallback descriptions;
- checks after navigation and other state changes;
- known business outcomes and limited recovery rules;
- risk level, approval state, and a snapshot of the policy used;
- tenant-specific URL or label changes;
- discovery provenance and a hash of the executable contract.

A recorded value becomes a reusable parameter only when it matches an input that was explicitly declared before discovery. The recorder does not guess that similar-looking values should become parameters.

The genuine discovery run exposed an important issue. The model identified a savings balance by the currency value visible during that run. Saving that description would tie replay to one member. The recorder now removes value-shaped descriptions and saves the relationship instead: the Balance column in the row containing SAVINGS. Tests replay the same artifact for another member and for another tenant.

New capabilities are drafts. Approval records who reviewed the artifact and when, then recomputes the contract hash. An irreversible draft is refused before execution. Runtime escalation does not replace review.

## 3. Determinism & error handling

Replay always follows the artifact's order. It finds a target using a fixed confidence order: relational table description, exact accessible role and name, scoped role and name, then an explicitly saved fallback. The two committed capabilities do not use CSS, XPath, or coordinates. Target resolution polls only within a fixed timeout.

After navigation or another state-changing action, replay checks that the expected screen was reached. A successful click alone is not treated as success. Typing and reading do not claim that the page changed. After each state change, the browser navigation guard is checked again.

The caller receives one of four clear result types:

- `ok`: the final check passed and every declared output was returned.
- `outcome`: the application returned a known business answer, such as `MEMBER_NOT_FOUND`, `NO_SAVINGS_ACCOUNT`, `PERMISSION_DENIED`, or `SESSION_EXPIRED`.
- `failed`: input, policy, target, application, recovery, checkpoint, or time limit failed. The result identifies the step, expected state, observed state, and evidence.
- `escalated`: a person owns, or abandoned, a live intervention. This is a paused run, not a normal terminal result.

Recovery never improvises. The artifact may declare a small recovery, such as closing a known dialog or waiting briefly for a late control, with an attempt limit. If enabled, an unresolved runtime problem can be offered to a person. When the person returns control, replay finds the target again and checks the expected state before continuing.

## 4. Heterogeneity & multi-tenant

Accessible roles, names, frames, and table relationships work across modern pages and older web applications. The synthetic target proves frames and nested tables rather than only a clean single-page application. Coordinates are evidence from discovery, not replay locators.

Tenant reuse uses one base artifact plus small reviewed overlays. An overlay may change the entry URL or a visible label. The same balance capability runs on Riverbend and Summitline even though `Member ID` becomes `Member Number`. A label or configuration change belongs in an overlay; a materially different workflow requires a new artifact revision.

At production scale, API nodes could remain stateless while isolated browser workers own active sessions. Artifacts would move to a versioned database, events to an append-only store, screenshots to encrypted object storage, and interventions to a durable ownership queue. Workers would scale with active sessions rather than with the number of tenants.

Those production components are design boundaries, not claims about this submission. The candidate project remains one local process or one local container so the full behavior is easy to run and review.

## 5. Escalation & handoff

Handoff transfers control; it does not merely send a notification.

```text
automation -> waiting for person -> claimed by operator -> released -> automation
                                   \-> abandoned -> automation
```

When replay reaches an approved irreversible action, or an enabled runtime failure cannot be resolved, the broker records the reason, capability, step, location, screenshot, and run ID. Automation gives up its ownership lease. Any automation action attempted while a person owns the session throws an error.

The operator must claim the intervention before acting. The local evidence test can attach a second Playwright client to the same persistent browser through loopback CDP. This proves that cookies, frames, open pages, and prepared form state were not recreated in a substitute session. The Studio exposes a deliberately small click, type, and press interface against that same paused Surface.

Human actions are audited without storing raw typed text. The operator's note is stored as context but is never parsed as an instruction. After release, replay checks the guarded step's expected result before marking it complete. Transfer, claim, human action, release, resume, and final result remain in one evidence stream.

A production handoff service would also need authenticated operator identity, durable ownership with heartbeat and expiry, approved remote-session streaming, and recovery after a worker failure.

## 6. Safety

The model proposes an action; the runtime decides whether it is allowed and performs it.

- Discovery and replay use the same policy engine.
- Host checks use exact hosts or explicit suffixes and may restrict paths.
- Browser request interception blocks redirects, frame navigation, click navigation, and popups before they leave the allowed host.
- The action vocabulary is limited.
- Step risk is stored in the artifact.
- Draft irreversible capabilities fail closed.
- Steps, full runs, target resolution, recovery, and handoff waits have limits.
- Only one actor can own the Surface.
- Inputs are validated before browser work.
- Sensitive inputs and outputs are registered with the redactor before evidence is written.
- Raw HTML, credentials, model keys, operator-entered text, and full model transcripts are not persisted.

A sensitive currency result is useful to the caller but is stored in evidence only as its type, a hash, and a masked proof. The local synthetic Studio may display the fabricated value. A real financial deployment would also require screenshot redaction, encryption, access control, and a retention policy.

All records in `target-app/data.ts` are fabricated. No external bank, customer record, or credential is accessed.

## 7. Cuts

The submission focuses on the required vertical slice. It does not add a voice interface, CRM, employee queue, decorative login, real bank connection, or a large fake dashboard. Those features would not strengthen discovery, the artifact, deterministic replay, evidence, or handoff.

The operator interface is intentionally small. It proves same-session ownership and verified resume; it does not claim to be a production co-browsing system. Authentication and durable ownership are stated deployment gaps.

The Capability Studio is a reviewer aid over the same implementation. It has six sections: Overview, Guided demo, Proof, Human review, Design decisions, and Presentation. The Guided demo starts with an editable human-language goal and copies the real CLI command. It does not mislabel the committed discovery evidence as a new run. Design decisions includes the high-level architecture and eighteen decisions. Presentation is a fourteen-slide walkthrough. The CLI remains the full discovery, approval, and replay path.

Hosting is not included because the assignment does not require it. Docker remains an optional local run method only.

Two stretch directions are included:

1. approved capabilities are exposed to agents as typed tool definitions; and
2. one capability is reused across tenants through constrained overlays.

The evidence script rebuilds the named cases and checks that directory names, result types, business codes, failures, screenshots, handoff events, and paths agree. A second verifier scans for known synthetic sensitive values. This keeps the written claims tied to executable evidence.
