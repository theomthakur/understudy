# Understudy

**A model discovers a flow once. It becomes a typed capability. Every run after that is
deterministic, with no model in the loop.**

Built for the interface.ai take-home. Design write-up: **[REPORT.md](REPORT.md)**.

An understudy learns the part by watching, then performs it without the star.

---

## What it does

Give it a goal in natural language and a legacy back-office app with no API. An LLM works out
how to do it by reading the accessibility tree — the same thing a screen reader shows a human —
and driving the UI. The successful run is recorded as a **capability artifact**: typed inputs,
typed outputs, semantic locators, checkpoints, and declared business outcomes. After that the
capability replays deterministically, and an AI agent can invoke it by name with typed arguments.

```
goal ──▶ LLM discovery ──▶ capability artifact ──▶ deterministic replay ──▶ typed result
                                    │                       │
                                    │                       ├─ ok        outputs
                                    │                       ├─ outcome   MEMBER_NOT_FOUND
                                    │                       ├─ failed    step, expected, observed
                                    └── reviewed, approved   └─ escalated human takes the session
```

---

## Quick start

```bash
npm install                    # also installs the Chromium Playwright needs
cp .env.example .env           # add a model key for discovery only
```

**Replay needs no API key.** It never calls a model. Only the discovery run does.

### 1. Start the stand-in back-office app

```bash
npm run target
```

A deliberately legacy credit-union console on `http://localhost:4471`: frameset, nested layout
tables, no test IDs, ASP.NET-style ids that carry row indexes. All data is synthetic.

| Member | What it exercises |
|---|---|
| `12345` | happy path, two accounts |
| `22871` | happy path, different balance — proves parameterisation |
| `30099` | restricted record → `PERMISSION_DENIED` |
| `99999` | does not exist → `MEMBER_NOT_FOUND` |

### 2. Discovery — the LLM run

```bash
npm run discover -- --goal read_savings_balance
npm run discover -- --goal read_savings_balance --headed    # watch it work
```

Writes `capabilities/member.read_savings_balance.json` and evidence to `evidence/runs/<runId>/`.

> **No model key?** `npm run seed` writes a hand-authored artifact of the same shape so you can
> exercise everything below. It is clearly marked as hand-authored in its `provenance`, and
> `npm run discover` overwrites it with the genuinely discovered one.

### 3. Replay — the production path, no model

```bash
npm run replay -- --capability member.read_savings_balance --memberId 12345
# ok  member.read_savings_balance@1  outputs={"savingsBalance":8241.55}  1180ms
```

**The same capability with a different input.** No re-recording:

```bash
npm run replay -- --capability member.read_savings_balance --memberId 22871
# ok  ... outputs={"savingsBalance":402.19}
```

### 4. The interesting part — error and exceptional states

```bash
# Business outcome, not a crash. Exit code 0; the caller branches on `code`.
npm run replay -- --capability member.read_savings_balance --memberId 99999
# outcome  member.read_savings_balance@1  code=MEMBER_NOT_FOUND

npm run replay -- --capability member.read_savings_balance --memberId 30099
# outcome  ... code=PERMISSION_DENIED

# Injected session timeout mid-run
curl "http://localhost:4471/__fault?kind=session&times=1"
npm run replay -- --capability member.read_savings_balance --memberId 12345
# outcome  ... code=SESSION_EXPIRED

# Injected interstitial — recovered automatically, run continues
curl "http://localhost:4471/__fault?kind=interstitial&times=1"
npm run replay -- --capability member.read_savings_balance --memberId 12345
# ok  ...   (see evidence for recovery.apply)

# Contract violation, caught before the browser is touched
npm run replay -- --capability member.read_savings_balance --memberId abc
# FAILED  ... invalid_input
```

### 5. Human escalation, taking over the live session

```bash
npm run discover -- --goal open_sub_account          # ends at an irreversible step
tsx src/cli.ts approve --capability member.open_sub_account
npm run replay -- --capability member.open_sub_account --memberId 12345 --headed
```

Replay reaches the irreversible confirmation, **pauses, and cedes control**. Open the operator
queue it prints (`http://localhost:4472`), claim the intervention, do the step in the browser
window that is already open — same session, same cookies — then hand control back.

The automation physically cannot act while you hold control; it throws if it tries.

### 6. Agent-facing catalog

```bash
npm run catalog
```

Emits the saved capabilities as tool definitions with JSON Schema inputs, declared outputs,
possible business-outcome codes, and the highest risk class in the flow — so a calling agent can
decline an irreversible capability without reading its steps.

---

## Tests

```bash
npm run target        # in one terminal
npm test              # in another
```

35 tests, no model key required.

| File | Covers |
|---|---|
| `tests/surface.test.ts` | a11y parsing, resolving by role+name with no test IDs, crossing a frameset, fallback rescue, control-transfer enforcement |
| `tests/replay.test.ts` | determinism, parameterisation, all three business outcomes, recovery, invalid input, hard failure detail, allowlist, escalation round-trip, cross-tenant reuse |
| `tests/recorder.test.ts` | parameterisation correctness, checkpoint attachment, fallback ladder, risk classification, host-allowlist bypasses, redaction |

---

## Layout

```
src/domain/artifact.ts      the capability schema — the focal point, read this first
src/domain/result.ts        ok | outcome | failed | escalated
src/surface/surface.ts      the seam: observe / resolve / act. No browser types.
src/surface/web-surface.ts  Playwright + accessibility tree. The only file that knows about a browser.
src/replay/replay.ts        deterministic execution and the classification loop
src/discovery/              LLM loop, prompt, and the recorder that hardens a run into an artifact
src/policy/                 allowlist, risk gates, redaction
src/escalation/             control-transfer state machine + minimal operator surface
src/catalog/                artifacts as agent-invocable tools
target-app/                 the stand-in legacy console
evidence/                   committed example runs
```

---

## Configuration

```bash
ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY (+ OPENAI_BASE_URL for any compatible endpoint)
UNDERSTUDY_MODEL=            # optional override
UNDERSTUDY_VERBOSE=1         # stream all events to stdout
TARGET_PORT=4471
OPERATOR_PORT=4472
```

Fault injection against the target app, used by the error-path demos and tests:

```bash
curl "http://localhost:4471/__fault?kind=session|apperror|slow|interstitial&times=1"
```

Two tenants of the same vendor product are available via `?tenant=riverbend` (base) and
`?tenant=summitline` (variant), which is how the cross-tenant reuse claim in REPORT.md §4 is
demonstrated.
