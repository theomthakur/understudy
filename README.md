# Understudy

Understudy uses an LLM to discover a UI task once, saves the successful flow as a reviewed capability, and replays it later with no model in the decision loop. The target application and all banking data are synthetic.

## Quick review

Requirements: Node.js 20+ and npm. Browser installation is explicit so installing the package
does not unexpectedly download a large binary.

```bash
npm install
npm run setup:browser
npm run app
```

Open [http://localhost:4317/studio](http://localhost:4317/studio). The Studio provides one guided path through the natural-language goal, committed discovery evidence, live deterministic replay, human handoff, design decisions, and presentation.

Useful direct links:

- [Guided demo](http://localhost:4317/studio#studio): enter a goal, inspect the discovery flow, and run replay.
- [Proof](http://localhost:4317/studio#evidence): inspect the approved artifact and evidence.
- [Human review](http://localhost:4317/studio#interventions): exercise same-session control transfer.
- [Design](http://localhost:4317/studio#decisions): review the architecture and trade-offs.
- [Presentation](http://localhost:4317/studio#presentation): use the ten-slide walkthrough or fullscreen mode.

The Studio uses committed evidence and requires no model credentials. It does not present playback as a new model run.

For the exact six-minute click sequence and expected results, see [`DEMO.md`](DEMO.md).

## Run discovery and replay

Start the synthetic target in terminal 1:

```bash
npm run target
```

Discovery requires one provider. Use an authenticated Codex CLI with no extra configuration, or create `.env` with one of:

```bash
UNDERSTUDY_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
```

```bash
UNDERSTUDY_PROVIDER=openai
OPENAI_API_KEY=...
```

In terminal 2, run a real model-driven discovery. The `_v2` name keeps the committed reference artifact unchanged.

```bash
npm run discover -- \
  --goal "Look up the member with the given member ID, open their profile, and read the current balance of their SAVINGS account. Capture it as the output 'savingsBalance'." \
  --name member.read_savings_balance_v2 \
  --input 'memberId:string:sensitive=^\d{3,10}$' \
  --value memberId=12345 \
  --output savingsBalance:currency:sensitive \
  --headed
```

Review the generated JSON, then approve and replay it:

```bash
npx tsx src/cli.ts approve \
  --capability member.read_savings_balance_v2 \
  --by reviewer@example.invalid

npm run replay -- \
  --capability member.read_savings_balance_v2 \
  --memberId 22871 \
  --headed
```

Replay needs no model credentials. The saved artifact supplies the steps, target descriptions, waits, checkpoints, outputs, and known outcomes.

## Verify

```bash
npm run check
```

This runs TypeScript validation, the complete test suite, and committed-evidence verification. Do not run `npm run target` separately during this command because the test runner manages its own target.

Committed evidence is under [`evidence/`](evidence/). It includes one genuine model discovery run and replay cases for success, business outcomes, recovery, hard failure, a second tenant, and human handoff.

## Repository guide

```text
src/discovery/       model loop and artifact recorder
src/replay/          deterministic execution and result classification
src/domain/          capability and result contracts
src/surface/         shared UI abstraction and Playwright adapter
src/policy/          allowlists, risk controls, and redaction
src/escalation/      same-session ownership and handoff
capabilities/        reviewed artifacts
evidence/            discovery and replay proof
target-app/          hostile synthetic banking application
```

See [`REPORT.md`](REPORT.md) for the system diagram, design decisions, trade-offs, and deliberate cuts.

## License

Licensed under the MIT License. See [`LICENSE`](LICENSE).
