# Evidence

`examples/` retains the genuine model-driven discovery transcript. `curated/` is regenerated
by an asserted script and contains every deterministic replay claim used in the submission:

| Run | Shows |
|---|---|
| `examples/01-discovery-live/` | the genuine LLM-driven discovery run: every observation the model saw, every action it proposed and why |
| `curated/replay-success/` | the same capability replayed deterministically for a different member, with no model involved |
| `curated/replay-*-{not-found,no-savings,permission-denied}/` | declared business outcomes rather than automation failures |
| `curated/replay-hard-failure/` | a real hard failure with expected vs observed and a screenshot |
| `curated/replay-handoff/` | an irreversible step completed by a human, verified, and resumed to final `ok` in one run |

Each directory contains:

- `events.jsonl` — append-only structured log, one JSON object per line
- `observation-*.json` — pruned control trees (roles and names only, never raw HTML)
- `result.json` — the final typed result
- `failure.png` / `escalation.png` — only when something stopped

Everything here has passed through the redactor. The pruned accessibility evidence retains
control roles and redacted labels; raw HTML and declared sensitive values are never persisted.
See REPORT.md §6.

`runs/` is transient output from your own runs and is gitignored.
