# test-results-mcp

JSON-ledger MCP for durable test/feature pass-fail contracts between AI agents.

Implements a structured JSON ledger where each acceptance criterion is `{passes: false}` until proven, and only a verifier role may flip it `passes: true` after end-to-end verification with cited evidence.

## Why

Multi-agent AI coding workflows benefit from a durable, machine-readable contract between test-author, implementer, verifier, and fixer roles. Markdown evidence files get re-read every iteration — expensive in tokens. A JSON ledger:

- Standardizes the contract schema across agents
- Reduces verifier→fixer handoff to compact tool calls (one `list_failing()` returns a few hundred bytes vs reading a multi-KB evidence file)
- Provides an immutability contract: only a verifier role may flip `passes`, only with cited evidence

Inspired by published AI-engineering research on long-running coding agents: structured JSON contracts outperform prose markdown for multi-session agent workflows.

## Status

v0.2.0 — 4 of 5 planned tools.

| Tool | Status |
|---|---|
| `init_feature_list(task_id, features[])` | ✅ |
| `mark_pass(task_id, feature_id, evidence_ref)` | ✅ |
| `list_failing(task_id)` | ✅ |
| `get_feature(task_id, feature_id)` | ✅ |
| `compare_runs(task_id, run_a, run_b)` | planned |

## Semantics

### Immutability lock

- `init_feature_list` refuses to overwrite an existing ledger for the same `task_id`. To start fresh, use a new `task_id`.
- `mark_pass` refuses to re-mark a feature that's already `passes: true`. The ledger is durable; the value of `passes` is the durable signal. A second pass attempt is a caller bug.

### Verifier role semantics

Only the verifier role should call `mark_pass` — the durable pattern requires that pass-flipping happen in a fresh-context, read-only-tools subagent. `mark_pass` requires a non-empty `evidence_ref` (URL, file path, or artifact ID) and clears any prior `last_attempt_error`.

### Fixer role semantics

The fixer calls `list_failing(task_id)` to know what's still broken (compact `{id, description, last_attempt_error}[]`), then `get_feature(task_id, feature_id)` to drill into one.

## Schema

```json
{
  "task_id": "kebab-case-task-id",
  "created_at": "2026-05-20T18:00:00.000Z",
  "schema_version": 1,
  "features": [
    {
      "id": "AC1",
      "description": "Acceptance criterion text",
      "evidence_required": ["test passes", "screenshot diff < 1%"],
      "passes": false,
      "passed_at": null,
      "evidence_ref": null,
      "last_attempt_error": null
    }
  ]
}
```

`evidence_required` is optional. All other fields are required. The ledger is written to `<rootDir>/.agent/tasks/<task_id>/feature_list.json`.

## Build + smoke

```bash
npm install
npm run build
npm run smoke
```

The smoke script (`scripts/smoke-local.sh`) runs **11 checks** against the built `dist/index.js`:

1. `init_feature_list` creates a ledger
2. `feature_list.json` is written to `.agent/tasks/<id>/`
3. `init` immutability lock (re-init throws)
4. `mark_pass` flips false→true with evidence; siblings untouched
5. `mark_pass` immutability (re-mark blocked)
6. `mark_pass` rejects missing task
7. `mark_pass` rejects empty `evidence_ref`
8. `list_failing` returns compact failing list (no `passes`/`passed_at` keys)
9. `get_feature` single-feature drill-down
10. `get_feature` rejects missing `feature_id`
11. End-to-end: mark all → `list_failing` returns `[]`

## Data policy

- Pure filesystem ops; no network, no telemetry
- Writes only under caller-provided `rootDir` (default `process.cwd()`)
- `task_id` enforced kebab-case
- Schema version 1; ledger stored at `<rootDir>/.agent/tasks/<task_id>/feature_list.json`

## License

MIT
