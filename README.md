# Understudy

**An LLM discovers a UI task once. A typed capability performs it afterward with no model in the loop.**

Candidate project for the interface.ai computer-use assignment. The target banking console and every record in it are synthetic.

- Exact discovery and replay path: see **Reviewer quick start** below
- Optional visual walkthrough: `npm run app` → http://localhost:4317/studio
- Design write-up: [REPORT.md](REPORT.md)
- Curated evidence: [evidence/README.md](evidence/README.md)
- Main contract: [src/domain/artifact.ts](src/domain/artifact.ts)

“Understudy” comes from theatre: an understudy learns a role by observing it, then performs the rehearsed choreography when called. Here, the model learns the part; the saved capability performs the script without improvising.

## Reviewer quick start

Requirements: Node 18.18+ and npm.

Install once:

```bash
npm install
```

Start the hostile synthetic target in terminal 1:

```bash
npm run target
```

In terminal 2, run the agent on a natural-language goal. The explicit name keeps the committed reference artifact untouched:

```bash
npm run discover -- \
  --goal "Look up the supplied member and read the savings balance" \
  --name member.read_savings_balance_v2 \
  --input 'memberId:string:sensitive=^\d{3,10}$' \
  --value memberId=12345 \
  --output savingsBalance:currency:sensitive \
  --headed
```

Review and approve the resulting draft, then replay that exact artifact with a different input:

```bash
npx tsx src/cli.ts approve \
  --capability member.read_savings_balance_v2 \
  --by reviewer@example.invalid

npm run replay -- \
  --capability member.read_savings_balance_v2 \
  --memberId 22871 \
  --headed
```

Discovery requires the authenticated Codex CLI or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from `.env`. Replay does not require model credentials and has no model fallback.

## Optional visual walkthrough

For a no-credentials review of the committed artifact and genuine discovery evidence:

```bash
npm run app
```

Open http://localhost:4317/studio. This starts the Studio and the hostile synthetic target on one public port.

A focused five-minute path:

1. Read **Overview** for the discovery → review → replay contract.
2. In **Run demo**, invoke `member.read_savings_balance` with:
   - `22871` → successful typed balance;
   - `44120` → `NO_SAVINGS_ACCOUNT`;
   - `30099` → `PERMISSION_DENIED`;
   - `99999` → `MEMBER_NOT_FOUND`.
3. Open **Proof** to inspect the approved artifact and committed discovery/replay evidence together.
4. In **Human review**, start the guarded run, claim the same paused session, complete the explicit human action, and return control. Replay verifies the checkpoint before it finishes.
5. **Design decisions** is the register of the eighteen load-bearing choices, the alternative each replaced, and where each lives in the code. **Presentation** walks the whole submission in thirteen slides, including the architecture diagram, for review without leaving the browser.

Each section deep-links: `/studio#decisions` and `/studio#presentation` open those views directly.

Replay never needs model credentials. The Studio’s discovery tab shows a committed genuine model run rather than spending a reviewer’s token or requiring their account.

## The vertical slice

```
natural-language goal
  → LLM sees screenshot + numbered accessibility candidates
  → policy-approved actions against the real UI
  → successful transcript compiled into a draft capability
  → human approval
  → deterministic replay with typed inputs/outputs
  → ok | outcome | failed | escalated
  → redacted evidence and same-session human handoff
```

The saved read capability is replayed against a member other than the discovery member and against a second tenant. Its balance target is relational—`SAVINGS × Balance`—rather than a literal value, row number, CSS selector, or volatile ID.

## Additional CLI examples

A preset natural-language discovery (this records the preset name, so use it only when you intend to replace the local draft):

```bash
npm run discover -- --goal read_savings_balance --headed
```

A different free-form goal with an explicit reusable contract:

```bash
npm run discover -- \
  --goal "Look up the supplied member and read the savings balance" \
  --name member.read_savings_balance_v2 \
  --input 'memberId:string:sensitive=^\d{3,10}$' \
  --value memberId=12345 \
  --output savingsBalance:currency:sensitive \
  --headed
```

The model receives a screenshot and numbered candidates but may act only through a listed candidate ID. New recordings are drafts.

Approve only after reviewing the steps and risk:

```bash
npx tsx src/cli.ts approve \
  --capability member.read_savings_balance_v2 \
  --by reviewer@example.invalid
```

## Deterministic replay examples

With the target running:

```bash
npm run replay -- --capability member.read_savings_balance --memberId 22871
npm run replay -- --capability member.read_savings_balance --memberId 99999
npm run replay -- --capability member.read_savings_balance --memberId 12345 --tenant summitline
```

The replay path contains no model call or model fallback. It validates inputs before browser work, enforces browser-level navigation policy, follows the artifact’s ordered steps, classifies declared business outcomes before failures, applies only bounded recorded recoveries, and verifies checkpoints.

To exercise runtime-failure handoff:

```bash
npm run replay -- \
  --capability member.read_savings_balance \
  --memberId 12345 \
  --headed \
  --escalate-failures
```

## Agent-facing catalog

```bash
npm run catalog
```

This emits approved capabilities as tool definitions with JSON Schema input, declared output, possible business outcomes, and highest risk. A calling agent can choose a capability without reading or changing its deterministic steps.

## Verification

```bash
npm run check
```

This is self-contained: it starts and stops its own target, type-checks the project, runs browser and unit tests, and verifies all curated evidence. Do **not** start `npm run target` separately while running the suite.

The suite covers multimodal constrained discovery contracts, step/run budgets, parameterization, semantic resolution, frames, delayed controls, cross-member and cross-tenant replay, known outcomes, recovery, unreachable targets, browser navigation interception, redaction, approval, human lease enforcement, failure escalation, verified resume, and evidence consistency.

To regenerate the named evidence cases:

```bash
npm run curate:evidence
npm run verify:evidence
```

## Container and live demo

```bash
docker build -t understudy .
docker run --rm -p 4317:4317 understudy
```

Then open http://localhost:4317 and verify http://localhost:4317/healthz.

The included [render.yaml](render.yaml) deploys the same Docker image on Render. A container host is the recommended full-demo target because Chromium and the in-memory intervention lease must remain alive across several HTTP requests. Vercel is suitable for a static reviewer shell, but not this complete stateful browser/handoff process without moving the browser worker, lease state, and evidence storage to external services.

The public demo is intentionally single-session and synthetic. Production requires authenticated operators, a durable lease queue, isolated browser workers, encrypted object storage, a versioned artifact database, and institution retention/access policy.

## Repository map

```
src/discovery/              bounded LLM loop, multimodal prompt, free-form goal contract
src/domain/artifact.ts      typed capability schema and artifact hash
src/replay/replay.ts        deterministic executor and result classification
src/surface/                accessibility Surface seam and Playwright implementation
src/policy/                 host/action/risk controls and redaction
src/escalation/             same-session control lease and operator actions
src/catalog/                agent-facing tool definitions
src/studio/                 reviewer server and live demo APIs
target-app/                 hostile synthetic banking console
capabilities/               approved reusable artifacts
evidence/                   genuine discovery and curated replay cases
scripts/                    self-contained tests, curation, and evidence verification
```

## Configuration

```bash
UNDERSTUDY_PROVIDER=codex|anthropic|openai
UNDERSTUDY_MODEL=...
CODEX_MODEL=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=...
TARGET_PORT=4471
OPERATOR_PORT=4472
PORT=4317
HOST=127.0.0.1
UNDERSTUDY_VERBOSE=1
UNDERSTUDY_PUBLIC_DEMO=1
```

Fault injection used by tests and demonstrations:

```bash
curl "http://localhost:4471/__fault?kind=session|apperror|slow|interstitial&times=1"
```

No real bank data, credentials, or external banking system is used.
