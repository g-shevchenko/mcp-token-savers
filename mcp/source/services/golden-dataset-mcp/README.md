# Golden Dataset MCP

Local-first MCP for reviewed benchmark cases, safe dataset runs, and aggregate-only measurement.

## Why

`golden-dataset-mcp` is the gate before changing retrieval ranking, language graph policies, repo hygiene rules, or router triggers. It turns real misses/partials/false positives into repeatable cases so improvements are proven instead of guessed.

v0.1.1 serializes stdio `tools/call` execution inside the service. This keeps pipelined client requests such as `import_retrieval_feedback` followed immediately by `run_dataset` from racing against local dataset writes.

## Data Policy

- Durable local cache: `$HOME/.hwai/golden-dataset-mcp`.
- Raw queries are never stored; optional `raw_query` and `corrected_query` inputs are hashed only.
- Request logs store counts and hashes, not path values, raw queries, code, prompts, or file bodies.
- Pantheon exports are aggregate-only.
- Expected paths may live in local dataset files because agents need benchmark truth, but they are excluded from request logs and Pantheon-safe exports.

## Tools

- `list_datasets`
- `add_case_from_feedback`
- `run_dataset`
- `run_retrieval_dataset`
- `import_retrieval_feedback`
- `compare_runs`
- `export_dataset_manifest`
- `get_artifact`
- `get_measurement_report`

## Local stdio

```bash
services/golden-dataset-mcp/scripts/local-stdio.sh
```

`local-stdio.sh` resolves `node` from `NODE_BIN`, `PATH`, then common Homebrew locations. Smoke tests include a reduced-PATH stdio check because MCP clients often do not inherit the interactive shell environment.

Defaults:

```bash
GOLDEN_DATASET_CACHE_DIR=$HOME/.hwai/golden-dataset-mcp
GOLDEN_DATASET_REQUEST_LOG_PATH=$GOLDEN_DATASET_CACHE_DIR/requests.jsonl
GOLDEN_DATASET_DATASETS_DIR=$GOLDEN_DATASET_CACHE_DIR/datasets
GOLDEN_DATASET_RUNS_DIR=$GOLDEN_DATASET_CACHE_DIR/runs
GOLDEN_DATASET_ARTIFACT_DIR=$GOLDEN_DATASET_CACHE_DIR/artifacts
```

## Proof

```bash
npm run build
npm run smoke
npm run benchmark
npm run measurement:report -- --format=pantheon
```

`run_dataset` and `run_retrieval_dataset` record aggregate token estimates per run. `compare_runs` gates on no failed-case regression, no Recall@5/Recall@10/MRR loss, and same-or-lower compact token usage when both runs provide comparable token estimates. The local golden benchmark includes a pipelined stdio import-then-run case to preserve chained automation behavior.

## Team/VPS stance

Keep dataset authoring and raw/local artifacts on developer machines or trusted Mini worktrees. Put only these surfaces on VPS/Pantheon for team use:

- package/entrypoint docs
- service health/catalog metadata
- aggregate daily metrics
- reviewed shared dataset files only after leakage review

Do not ship raw queries, code snippets, screenshots, trace files, local paths, or unreviewed case artifacts to a VPS dashboard.
