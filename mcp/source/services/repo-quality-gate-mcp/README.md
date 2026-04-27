# HWAI Repo Quality Gate MCP

Local-first advisory quality gate for clean new work budgets.

It checks changed/untracked code and docs against repo-specific budgets, scans aggregate context pressure, creates aggregate snapshots, compares snapshots, and proposes a review plan. Generated-like paths such as root-level `dist/`, `coverage/`, `node_modules/`, `.cache/`, `.artifacts/`, lockfiles, snapshots, and live snapshots are excluded from new-work budgets unless `include_generated=true`. `.claude/worktrees/*` branch clones are always skipped from new-work budgets and aggregate snapshots because they are parallel workspaces, not maintained repo content. Imported seed skill/template files under `templates/hwai_internal_seed/skills/imported/*` are skipped by default so maintained-repo quality budgets are not mixed with vendored template debt; pass `include_imported_templates: true` when deliberately auditing imported packages. It never blocks, deletes, moves, archives, or rewrites files by itself.

Aggregate snapshots include `candidate_files_seen`, `max_files`, `selection_policy`, and `scan_truncated`. The repo walk first gathers candidate paths with skipped generated worktrees/imported templates removed, then prioritizes non-generated code/docs ahead of low-signal `other` and generated-like files before applying `max_files`. If `check_context_budget` still truncates, it returns an advisory `scan_truncated` warning so agents do not treat an incomplete pass as a complete repo-size budget.

## Tools

- `check_new_code_budget`
- `check_new_docs_budget`
- `check_context_budget`
- `create_quality_snapshot`
- `compare_quality_snapshot`
- `propose_quality_gate_plan`
- `get_artifact`
- `get_measurement_report`

## Local stdio

```bash
services/repo-quality-gate-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/repo-quality-gate-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/repo-quality-gate-mcp/requests.jsonl
```

## Proof loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/repo-quality-gate-local-benchmark.json
npm run measurement:report -- --date=2026-04-26 --format=pantheon
```

## Data policy

- Raw code and doc bodies are not written to request logs.
- Pantheon exports are aggregate-only.
- Tool outputs may include repo-relative paths for local review; Pantheon-safe exports do not.
- All gates are advisory in v0.1.
- Agents still read exact files and run proof loops before edits.
