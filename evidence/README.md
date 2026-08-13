# Evidence

`examples/` holds committed runs demonstrating the end-to-end flow:

| Run | Shows |
|---|---|
| `discovery-*/` | the genuine LLM-driven discovery run: every observation the model saw, every action it proposed and why |
| `replay-ok-*/` | the same capability replayed deterministically, no model involved |
| `replay-outcome-*/` | a replay hitting a declared business outcome (`MEMBER_NOT_FOUND`) rather than failing |
| `replay-failed-*/` | a hard failure, with the step, expected vs observed, and a screenshot |
| `replay-escalated-*/` | an irreversible step routed to a human, with the control-transfer trail |

Each directory contains:

- `events.jsonl` — append-only structured log, one JSON object per line
- `observation-*.json` — pruned control trees (roles and names only, never raw HTML)
- `result.json` — the final typed result
- `failure.png` / `escalation.png` — only when something stopped

Everything here has passed through the redactor. Raw page text is never persisted; see
REPORT.md §6.

`runs/` is transient output from your own runs and is gitignored.
