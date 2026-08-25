# Understudy demo guide

This is the shortest complete path through the assignment. It takes about six minutes and uses only synthetic data.

## Start

```bash
npm install
npm run app
```

Open `http://localhost:4317/studio`. If the app was started with another `PORT`, use that port instead.

## Click-by-click walkthrough

1. Open **Guided demo** and keep **1 - Discovery input** selected.
   - Choose **Read a savings balance**.
   - Click **Play guided discovery**.
   - Watch the active stage move through observe, decide, act, and compile.
   - Say: "This animation replays the committed model evidence. It is not pretending to be a fresh model call."

2. Click **Inspect genuine discovery proof**.
   - Point out the saved observation, model decision, action, rationale, and completion events.
   - Return to **Guided demo**.
   - Use **Show and copy genuine command** only if the reviewer wants to run a new discovery with model access.

3. Select **2 - Deterministic replay**.
   - Choose `22871 - success` and `Riverbend - base artifact`.
   - Click **Run deterministic replay**.
   - Expected result: `$402.19`, four completed steps, and zero model decisions.

4. Show deliberate runtime handling.
   - Choose `99999 - not found` and run again.
   - Expected result: `MEMBER_NOT_FOUND`, shown as a business outcome rather than a crash.
   - Optional: `44120` returns `NO_SAVINGS_ACCOUNT`; `30099` returns `PERMISSION_DENIED`.

5. Show cross-tenant reuse.
   - Restore member `22871`.
   - Select **Summitline - Member Number overlay** and run again.
   - Expected result: the same `$402.19` output from the same approved capability, with the reviewed label override.

6. Open **Proof**.
   - Point out the human title and machine capability ID `member.read_savings_balance`.
   - Show the typed input/output contract, fixed execution plan, eight-case replay matrix, redacted event stream, and agent-callable catalog.
   - The hard-failure and recovery rows provide the richer failure evidence required by the brief.

7. Open **Human review** and click **Start safety demo**.
   - Click **Take control of live session**.
   - The takeover opens inside the Studio. Confirm that `candidate.reviewer` owns the exclusive lease and that the exact paused session is visible.
   - In the takeover window, click **Complete guarded action**.
   - Click **Verify and resume automation**.
   - Expected result: automation pauses before the irreversible confirmation, the human owns and acts in the same browser session, the action is audited, and deterministic replay resumes only after its checkpoint passes.

8. Finish with **Design decisions** or **Presentation**.
   - Use **Present fullscreen** for the ten-slide overview.
   - The architecture diagram shows that only discovery can call a model. Discovery and replay share the policy, surface, evidence, and handoff runtime.

## Assignment coverage

| Core requirement | Where to demonstrate it |
|---|---|
| Goal-driven agent loop | Guided demo animation plus genuine discovery events and copied live command |
| Structured capability artifact | Proof: typed contract, ordered plan, locators, checkpoint, version, approval, and hash |
| Deterministic replay | Guided demo replay: live execution with new inputs and zero model decisions |
| Runtime errors and outcomes | Replay presets plus Proof's recovery and hard-failure evidence |
| Safety and data handling | Proof: policy metadata, risk classes, redacted logs, and sensitive typed values |
| Human escalation and handoff | Human review: enforced pause, claim, same-session action, release, and verified resume |
| Heterogeneity and tenant reuse | Summitline replay plus the Surface abstraction and drift policy in Design decisions |
| Agent-callable interface | Proof: approved tool catalog with typed inputs, outputs, outcomes, revision, and risk |

## What is real and what is illustrated

- Real: the LLM discovery implementation and one committed model-driven run.
- Real: artifact recording, schema validation, approval hash, deterministic replay, business outcomes, recovery, failures, tenant override, evidence, and same-session handoff.
- Illustrated: the Guided demo discovery animation. It plays the committed evidence without consuming model tokens.
- Example only: **Check account status** has a runnable discovery command but no committed artifact.
- Safety fixture: `member.open_sub_account` is hand-authored and approved to demonstrate the irreversible-action handoff. It is not represented as a second genuine discovery run.

## Fresh model-driven discovery

The exact command is available from **Show and copy genuine command**. Start the synthetic target in one terminal, configure Codex CLI, Anthropic, or OpenAI as described in `README.md`, and run the copied command in another terminal. Review and approve the generated `_v2` artifact before replaying it.
