# test-results-mcp

JSON-ledger MCP for durable test/feature pass-fail contracts between AI agents.

Implements a structured JSON ledger where each acceptance criterion is `{passes: false}` until proven, and only a verifier role may flip it `passes: true` after end-to-end verification with cited evidence.

## Why

Multi-agent AI coding workflows benefit from a durable, machine-readable contract between test-author, implementer, verifier, and fixer roles. Markdown evidence files get re-read every iteration — expensive in tokens. A JSON ledger:

- Standardizes the contract schema across agents
- Reduces verifier→fixer handoff to compact tool calls (one `list_failing()` returns a few hundred bytes vs reading a multi-KB evidence file)
- Provides an immutability contract: only a verifier role may flip `passes`, only with cited evidence

Inspired by published AI-engineering research on long-running coding agents: structured JSON contracts outperform prose markdown for multi-session agent workflows. The model is observed to be less likely to inappropriately overwrite JSON than Markdown when both are presented as durable contracts.

## Status

v0.1.0 — initial scaffold (May 2026).

| Tool | Status |
|---|---|
| `init_feature_list(task_id, features[])` | ✅ implemented + smoke-tested |
| `mark_pass(task_id, feature_id, evidence_ref)` | planned |
| `list_failing(task_id)` | planned |
| `get_feature(task_id, feature_id)` | planned |
| `compare_runs(task_id, run_a, run_b)` | planned |

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

`evidence_required` is optional. All other fields are required. The ledger is written to `.agent/tasks/<task_id>/feature_list.json` (relative to the configured root directory).

## Constraints

- `task_id` must be kebab-case (lowercase alphanumeric + hyphens, no slashes/dots/spaces)
- `features` array must have at least one entry
- The ledger is immutable once created: a second `init_feature_list` call for the same `task_id` throws `already exists` (use a new task_id or remove the existing ledger first)

## Build + smoke

```bash
npm install
npm run build
npm run smoke
```

The smoke script (`scripts/smoke-local.sh`) runs 6 checks against the built `dist/index.js`:

1. `init_feature_list` creates a ledger with correct defaults
2. `feature_list.json` is written to `.agent/tasks/<id>/`
3. `evidence_required` is preserved when provided
4. Immutability lock throws on re-init
5. Empty features array is rejected
6. Invalid task_id (with slashes/dots/spaces) is rejected

## Data policy

- Durable local writes: the ledger is written under the caller-provided `rootDir` (default `process.cwd()`)
- No telemetry, no network calls — pure filesystem ops
- Raw task descriptions and acceptance criteria are stored as-is in the ledger (the ledger IS the durable contract); callers concerned about sensitive content should hash before passing to `init_feature_list`

## License

MIT
