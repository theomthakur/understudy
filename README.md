# Understudy

Understudy lets a model learn a task in a user interface once, saves the successful task as a reviewed capability, and runs that capability later without a model making decisions.

This repository is a candidate project for the interface.ai computer-use assignment. The banking application and every record in it are synthetic.

## Start here

There is one system with two ways to inspect it:

- The **CLI is the complete implementation path**. It runs genuine model-driven discovery, creates the artifact, supports approval, and replays the saved capability.
- The **Capability Studio is the reviewer path**. It explains the same flow, runs deterministic replay live, exposes the artifact and evidence, and demonstrates human handoff without requiring model credentials.

The Studio is not a separate product and does not replace the CLI.

### Local reviewer links

Start the Studio first:

```bash
npm install
npm run app
```

Then use these links:

| Page | Link | What it shows |
| --- | --- | --- |
| Overview | http://localhost:4317/studio | The complete goal-to-proof flow |
| Guided demo | http://localhost:4317/studio#studio | Natural-language discovery input and live deterministic replay |
| Proof | http://localhost:4317/studio#evidence | Approved artifact, genuine discovery evidence, replay evidence, and result types |
| Human review | http://localhost:4317/studio#interventions | Enforced transfer of the same live browser session to a person |
| Design decisions | http://localhost:4317/studio#decisions | High-level architecture and all eighteen important design choices |
| Presentation | http://localhost:4317/studio#presentation | Fourteen-slide walkthrough ending with a thank-you slide |

The main repository documents are:

- [REPORT.md](REPORT.md): design write-up in the seven sections requested by the assignment
- [evidence/README.md](evidence/README.md): evidence layout and named test cases
- [src/domain/artifact.ts](src/domain/artifact.ts): executable capability schema

## Five-minute reviewer flow

1. Open **Overview** and read the five stages: goal, discovery, review, replay, proof.
2. Open **Guided demo**. The first tab shows the normal human-language goal. It can be edited, and the button copies the exact live discovery command.
3. Click **Inspect committed discovery proof**. This is a genuine saved model run of the default goal, not a simulated animation.
4. Return to **Guided demo**, choose **Deterministic replay**, and run these synthetic cases:

   - `22871`: successful typed balance
   - `44120`: `NO_SAVINGS_ACCOUNT`
   - `30099`: `PERMISSION_DENIED`
   - `99999`: `MEMBER_NOT_FOUND`

5. Open **Human review**, start the safety demo, take control of the paused session, complete the guarded action, and return control. Replay checks the expected screen before continuing.
6. Use **Design decisions** for the high-level architecture and tradeoffs. Use **Presentation** for the guided explanation.

## Where the human-language query goes

The normal-language goal is the input to discovery. The default example is:

> Look up the member with the given member ID, open their profile, and read the current balance of their SAVINGS account. Capture it as the output 'savingsBalance'.

It appears in the first tab of **Guided demo**. The Studio copies a command that runs the real discovery loop from the repository. Live discovery stays in the CLI because it needs access to a supported model provider and writes a new draft artifact. Keeping that operation explicit prevents a reviewer from accidentally spending model tokens or overwriting the committed reference artifact.

The Studio separately exposes the committed genuine discovery run. It never labels that saved evidence as a new run of edited text.

## Complete discovery and replay path

Requirements: Node 18.18 or newer and npm.

Install dependencies:

```bash
npm install
```

Start the hostile synthetic target in terminal 1:

```bash
npm run target
```

In terminal 2, run discovery from a natural-language goal. The explicit `_v2` name protects the committed reference artifact.

```bash
npm run discover -- \
  --goal "Look up the member with the given member ID, open their profile, and read the current balance of their SAVINGS account. Capture it as the output 'savingsBalance'." \
  --name member.read_savings_balance_v2 \
  --input 'memberId:string:sensitive=^\d{3,10}$' \
  --value memberId=12345 \
  --output savingsBalance:currency:sensitive \
  --headed
```

Discovery requires one of the supported model configurations: an authenticated Codex CLI, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. The model sees a screenshot and a numbered list of available controls. It may choose only one of those controls. The runtime checks policy and performs the action.

A successful run creates a draft capability. Review its saved steps and risk, then approve it:

```bash
npx tsx src/cli.ts approve \
  --capability member.read_savings_balance_v2 \
  --by reviewer@example.invalid
```

Replay the same artifact with a different member:

```bash
npm run replay -- \
  --capability member.read_savings_balance_v2 \
  --memberId 22871 \
  --headed
```

Replay requires no model credentials. The replay engine has no prompt, model call, or model fallback.

## System flow

```text
natural-language goal + typed input/output contract
  -> model observes the UI and proposes a listed control
  -> policy checks the proposed action
  -> the shared Surface performs it
  -> Recorder turns the successful path into a draft artifact
  -> a person reviews and approves the artifact
  -> an agent invokes the approved capability with typed input
  -> deterministic replay resolves, acts, and checks each saved step
  -> ok | known business outcome | failed | escalated
  -> redacted evidence
```

Discovery and replay share four services: policy, UI access through `Surface`, evidence and redaction, and the human handoff broker. Only discovery can access a model.

The target is intentionally difficult: frames, nested tables, volatile IDs, no test IDs, tenant-specific labels, and reproducible error switches. This tests the behavior the assignment asks about without touching a real banking system.

## What the saved artifact contains

The artifact is more than a recorded click list. It includes:

- a stable name, schema version, and revision;
- typed inputs and outputs with validation and sensitivity flags;
- ordered action steps;
- accessible target descriptions and reviewed fallback strategies;
- checks after page or state changes;
- known business outcomes such as member not found;
- limited, predeclared recovery rules;
- risk, approval, and policy information;
- tenant-specific label overrides;
- discovery provenance and a contract hash.

The real discovery run initially identified the balance using its displayed currency value. The recorder recognized that the value would change for another member and replaced it with a relationship: the Balance column in the row containing SAVINGS. The same artifact is tested with another member and with Summitline, where `Member ID` is labeled `Member Number`.

## Additional replay examples

With `npm run target` already running:

```bash
npm run replay -- --capability member.read_savings_balance --memberId 22871
npm run replay -- --capability member.read_savings_balance --memberId 99999
npm run replay -- --capability member.read_savings_balance --memberId 12345 --tenant summitline
```

To offer an unresolved runtime failure to a person:

```bash
npm run replay -- \
  --capability member.read_savings_balance \
  --memberId 12345 \
  --headed \
  --escalate-failures
```

To see approved capabilities as agent-callable tool definitions:

```bash
npm run catalog
```

## Verification

Run the complete check from a clean terminal:

```bash
npm run check
```

Do not start `npm run target` separately for this command. The test script starts and stops its own target.

The check performs TypeScript validation, 58 unit and browser tests, and evidence verification. It covers discovery limits, parameterization, frames, semantic target resolution, different members and tenants, known outcomes, recovery, unreachable targets, navigation blocking, approval, redaction, human control ownership, verified resume, and consistency of the committed evidence.

To rebuild and verify the named evidence cases:

```bash
npm run curate:evidence
npm run verify:evidence
```

## Optional local Docker run

Docker is not required for submission. It is only another local way to run the same Studio and target together.

```bash
docker build -t understudy .
docker run --rm -p 4317:4317 understudy
```

Open http://localhost:4317/studio and check http://localhost:4317/healthz.

There is no hosted deployment configuration in this repository. Hosting was not requested by the assignment, so the submission keeps the runnable local path as the source of truth.

## Repository map

```text
src/discovery/              bounded model loop, prompt, and goal contract
src/domain/artifact.ts      capability schema and artifact hash
src/replay/replay.ts        deterministic executor and result classification
src/surface/                shared UI interface and Playwright web implementation
src/policy/                 allowed hosts, actions, risk controls, and redaction
src/escalation/             same-session control ownership and operator actions
src/catalog/                agent-facing tool definitions
src/studio/                 reviewer server and live demo APIs
target-app/                 hostile synthetic banking console
capabilities/               approved reusable artifacts
evidence/                   genuine discovery and curated replay cases
scripts/                    tests, evidence generation, and verification
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

Fault switches used by tests and demonstrations:

```bash
curl "http://localhost:4471/__fault?kind=session|apperror|slow|interstitial&times=1"
```

No real bank data, credentials, or external banking system is used.
