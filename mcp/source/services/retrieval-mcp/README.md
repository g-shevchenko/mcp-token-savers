# HWAI Retrieval MCP

Local-first MCP server that prepares precise codebase context before Claude Code, Codex, Cursor, or Windsurf spend frontier-model tokens.

It is not a reasoning replacement. It is a deterministic retrieval layer:

- local `rg` / file-path scoring
- line-anchored snippets
- ranked files with reasons
- related file hints
- optional client `context_hints` metadata
- raw artifact fallback
- metadata-only JSONL request logs
- feedback/outcome logs for misses and benchmark candidates
- daily measurement reports with token and USD counterfactual savings

## Why Local-First

`retrieval-mcp` should see the same worktree as the agent: current branch, uncommitted edits, and local files. Running it only on a VPS mirror would miss the state that matters most during coding.

The service is intentionally light: no Ollama, no embeddings, no vector database in current v2.

## Tools

- `retrieve_context` — query/task -> ranked files, snippets, related files, compact context, artifacts
- `find_files` — query/task -> ranked file candidates only
- `get_repo_map` — token-budgeted local repo map for architecture/onboarding orientation
- `get_artifact` — read raw retrieval artifacts when compact output is not enough
- `record_feedback` — record helpful/partial/miss outcomes so bad retrieval traces become upgrade candidates
- `get_measurement_report` — daily usage, savings, quality feedback, and Pantheon-safe aggregate export

## Trigger Policy

Use retrieval when:

- the target files are not obvious
- the question spans multiple modules
- a broad `rg` search would produce noisy output
- the agent needs context before a bug fix or implementation

Skip retrieval when:

- the exact file is already known
- the user asks a short conceptual question
- local file reads are cheaper and clearer
- the task needs final architecture judgment rather than search prep

Quality rule: before editing, read the exact files/lines returned by retrieval. If `confidence.uncertainty > 0.03` and results conflict, inspect artifacts or ask one clarification.

Self-learning rule: if retrieval was partial, wrong, or forced the frontier model to search manually, call `record_feedback` with the returned `call_id`, outcome, and the correct/missing paths. Do not patch ranking blindly; promote bad traces into benchmark cases first.

## Local Setup

```bash
cd services/retrieval-mcp
npm install
npm run build
npm run smoke
```

Full local e2e:

```bash
cd services/retrieval-mcp
npm run e2e
```

Golden benchmark:

```bash
cd services/retrieval-mcp
npm run benchmark
```

Trace candidate review:

```bash
cd services/retrieval-mcp
npm run trace:candidates
```

Team install docs:

- `services/retrieval-mcp/TEAM_ONBOARDING_RU.md`
- v2 research and update plan: `notes/retrieval_mcp_v2_research_and_update_plan_2026-04-23.md`

MCP stdio command for agents:

```bash
$HOME/.hwai/hwai-mcp-stack/mcp/source/services/retrieval-mcp/scripts/local-stdio.sh
```

`local-stdio.sh` writes shared durable measurement logs to:

```bash
$HOME/.hwai/retrieval-mcp/requests.jsonl
$HOME/.hwai/retrieval-mcp/feedback.jsonl
```

This is intentional: Claude Code, Codex, Cursor, and Windsurf all use the same local script, so the daily learning report can aggregate outcomes across agents on Greg MacBook.

Config default:

- When `RETRIEVAL_CACHE_DIR` is unset, the service now defaults to `$HOME/.hwai/retrieval-mcp` when `HOME` is available.
- This keeps `get_measurement_report`, direct local scripts, and the Codex daily learning loop aligned on the same durable shared logs instead of splitting between stdio-only cache and `/tmp`.

Attribution contract:

- Real agent calls should pass `metadata.surface` as `claude`, `codex`, `cursor`, or `windsurf`, plus `metadata.source` when useful.
- For backward compatibility, reports infer `metadata_surface` from legacy `metadata_source` values such as `codex` / `claude` / `cursor` / `windsurf` when the explicit surface is missing.
- Request logs also carry `traffic_class`: `production_like`, `proof`, `benchmark`, or `unknown`.
- Smoke/e2e/proof traces should use source values containing `smoke`, `e2e`, or `proof`; benchmark and golden-dataset traces should use source values containing `benchmark`, `golden`, or `dataset`.

Ripgrep resolution:

- `local-stdio.sh` resolves `node` / `npm` from `PATH` and common Homebrew locations. Set `NODE_BIN` or `NPM_BIN` if a client starts with an unusual environment.
- `retrieve_context` and `get_repo_map` use `rg` for fast local file discovery and content search.
- Stdio clients may start with a smaller `PATH` than an interactive shell. The server therefore checks `RETRIEVAL_RG_PATH` first, then common local locations including the Codex app bundled `rg`.
- If `rg` is truly unavailable, the tool returns a warning instead of crashing; install ripgrep or set `RETRIEVAL_RG_PATH` to restore full recall.

HTTP debug mode:

```bash
cd $HOME/.hwai/hwai-mcp-stack/mcp/source
RETRIEVAL_TRANSPORT=http node services/retrieval-mcp/dist/index.js --http
curl http://127.0.0.1:3395/health
```

REST example:

```bash
curl -fsS http://127.0.0.1:3395/api/retrieve/context \
  -H 'content-type: application/json' \
  -d '{
    "query": "context prep mcp health request log",
    "root_path": "$HOME/.hwai/hwai-mcp-stack/mcp/source",
    "include_globs": ["services/context-prep-mcp/**"],
    "max_files": 5,
    "max_snippets": 8
  }'
```

Feedback example:

```bash
curl -fsS http://127.0.0.1:3395/api/retrieve/feedback \
  -H 'content-type: application/json' \
  -d '{
    "call_id": "retrieve-20260423T120000Z-abc123",
    "outcome": "partial",
    "frontier_had_to_search": true,
    "expected_paths": ["services/retrieval-mcp/src/measurement.ts"],
    "missing_paths": ["services/retrieval-mcp/src/measurement.ts"],
    "notes": "Frontier model had to locate measurement code manually"
  }'
```

Measurement report:

```bash
curl -fsS "http://127.0.0.1:3395/api/retrieve/measurements?date=$(date -u +%F)"
npm run measurement:report -- --date=$(date -u +%F) --format=pantheon
```

The package script is the local audit entrypoint. `--format=pantheon` returns aggregate-only telemetry without raw queries, code, file paths, local log paths, samples, or artifact URLs.

## Data Policy

- Raw code and raw queries stay local.
- Request and feedback logs store metadata, counts, hashes, and reviewed path fields needed for local benchmarks.
- Pantheon-safe exports exclude raw queries, code bodies, local log paths, samples, and artifact URLs.
- Agents must still read exact files before edits; retrieval output is context prep, not final evidence.

## Output Contract

```json
{
  "schema_version": "retrieval.v1",
  "pipeline_version": "2026-04-23.local-rg-symbol-fanout-hints-measure-v4",
  "call_id": "retrieve-20260423T120000Z-abc123",
  "retrieval_mode": "local-rg",
  "query": "where is context prep health implemented",
  "input_stats": {
    "files_considered": 1200,
    "ranked_files_returned": 8,
    "snippets_returned": 12,
    "truncated": false,
    "warnings_count": 0,
    "filtered_hits_count": 0,
    "context_hints_applied_count": 1,
    "raw_tokens_estimate": 18000,
    "compact_tokens_estimate": 2500,
    "savings_pct": 86.1
  },
  "ranked_files": [
    {
      "path": "services/context-prep-mcp/src/index.ts",
      "score": 82,
      "reasons": ["4 content matches", "filename contains \"context\""],
      "match_lines": [401, 460]
    }
  ],
  "snippets": [
    {
      "path": "services/context-prep-mcp/src/index.ts",
      "start_line": 390,
      "end_line": 420,
      "reason": "4 content matches",
      "text": "..."
    }
  ],
  "definitions": [
    {
      "path": "services/context-prep-mcp/src/index.ts",
      "line": 460,
      "kind": "function",
      "name": "createContextPrepServer"
    }
  ],
  "import_edges": [
    {
      "path": "services/context-prep-mcp/src/index.ts",
      "line": 12,
      "kind": "import",
      "target": "./prep-url.js"
    }
  ],
  "test_counterparts": [],
  "artifacts": {
    "raw_search_url": "http://127.0.0.1:3395/artifacts/retrieval-abc.json",
    "compact_context_url": "http://127.0.0.1:3395/artifacts/retrieval-abc-compact.md"
  },
  "confidence": {
    "uncertainty": 0.05,
    "reasons": ["strong top match"]
  },
  "quality": {
    "truncated": false,
    "warnings": [],
    "filtered_counts": {},
    "context_hints": {
      "provided_counts": { "selected_paths": 1 },
      "applied_counts": { "selected_paths": 1 },
      "applied": [
        { "path": "services/context-prep-mcp/src/index.ts", "kinds": ["selected_paths"], "boost": 90 }
      ],
      "ignored_sample": []
    },
    "top_extensions": { ".ts": 45, ".md": 12 },
    "path_policy": {
      "effective_globs_count": 42,
      "sources": [
        { "name": ".gitignore", "mode": "rg-native" },
        { "name": "retrieval-default-excludes", "mode": "glob", "patterns_loaded": 34 }
      ]
    },
    "query_plans": [
      { "name": "lexical", "terms_count": 8, "boost": 0 },
      { "name": "expanded-variants", "terms_count": 14, "boost": 6 }
    ]
  },
  "prompt_scaffold": "Use compact_context to orient..."
}
```

## Measurement And Self-Learning Loop

The measurement layer is intentionally simple and local-first:

1. Every `retrieve_context` / `find_files` result includes `call_id`.
2. Request logs store metadata-only summaries: tool, latency, raw/compact/saved token estimates, savings percent, uncertainty, and returned counts.
3. When an agent discovers that retrieval missed or under-ranked the right context, it calls `record_feedback`.
4. `record_feedback` writes `feedback.jsonl` with outcome, paths, and a safe note. It returns `benchmark_candidate=true` for misses, partials, wrong-context cases, and manual-search fallbacks.
5. `get_measurement_report` aggregates request logs + feedback into daily metrics, separates `production_like` / `proof` / `benchmark` traffic, and emits a Pantheon-safe export.
6. `npm run trace:candidates` turns metadata-only feedback into benchmark candidates for manual review.

Feedback discipline:

- Record feedback after real `partial`, `miss`, `wrong_context`, or `manual_search_needed` cases.
- Do not invent filler `helpful` feedback just to raise coverage.
- The daily report shows production-like feedback coverage separately from proof/benchmark coverage so low coverage is visible without letting smoke/e2e traffic drive ranking work.

Definition of "better" for this service:

- Higher Recall@5/10 and MRR on golden queries.
- Lower miss/partial feedback rate.
- Lower frontier/manual-search fallback count.
- Stable or lower p95 latency.
- Higher token savings only when quality stays green.

Do not optimize purely for token savings. A cheap retrieval result that sends the frontier model in the wrong direction is worse than spending more tokens.

Pantheon integration should ingest only `pantheon_export` from `get_measurement_report`, not raw queries or file contents. USD savings are counterfactual planning numbers:

```json
{
  "pantheon_export": {
    "service": "retrieval-mcp",
    "date": "2026-04-23",
    "calls": 42,
    "by_traffic_class": {
      "production_like": 35,
      "proof": 5,
      "benchmark": 2
    },
    "production_like_calls": 35,
    "proof_calls": 5,
    "benchmark_calls": 2,
    "saved_tokens_estimate": 120000,
    "production_like_saved_tokens_estimate": 98000,
    "estimated_usd_saved": 0.36,
    "feedback_count": 5,
    "production_like_feedback_count": 3,
    "production_like_feedback_coverage_pct": 8.6,
    "miss_or_partial_count": 1,
    "frontier_search_count": 1,
    "p95_latency_ms": 240
  }
}
```

`estimated_usd_saved` uses `RETRIEVAL_USD_PER_1M_TOKENS` (default: `3`). This is a counterfactual input-token estimate for planning and Pantheon visibility, not a literal subscription invoice.

## Daily Learning Automation

Greg's local Codex automation `Retrieval MCP Daily Learning` runs every day at 19:00 Moscow time.

It reads the durable cache under `$HOME/.hwai/retrieval-mcp`, calls/derives `get_measurement_report`, and opens an inbox report with:

- calls by tool/transport/surface and traffic class
- production-like agent usage separated from smoke/e2e/proof and benchmark/golden-dataset traffic
- saved token estimate and counterfactual USD
- feedback coverage and miss/partial rate
- frontier/manual-search fallback count
- benchmark candidates from `record_feedback`
- P0/P1/P2 upgrade recommendations
- whether a new branch is actually needed

The automation does not edit code or create branches by itself. The safe operating model is: collect traces automatically, review the daily report, then start a focused branch only when feedback candidates justify a retrieval upgrade.

Notification sinks should be added only as a second step and only for aggregate exports, not raw queries, paths, notes, or artifacts.

## Benchmark Gate

`npm run benchmark` runs local golden queries from `benchmarks/golden-queries.json` plus reviewed trace cases from `benchmarks/from-traces.json` and fails on:

- expected file missing from top 10
- expected snippet terms missing
- generated/dependency/worktree/secret-like noise paths
- truncated retrieval output

Track these metrics before adding smarter retrieval:

- Recall@5 / Recall@10
- MRR
- snippet precision
- symbol precision
- hint precision
- noise hit rate
- token savings percent
- p95 latency
- feedback coverage
- miss/partial rate
- frontier-search fallback count

## Commercial Patterns We Copy

- Cursor: automatic codebase indexing, ignore-file hygiene, incremental chunk caching, and team index reuse.
- Sourcegraph Cody: combine keyword search, Sourcegraph Search, code graph, and explicit context sources instead of relying on chat memory.
- GitHub Copilot workspace context: combine semantic search, text search, grep, file search, usages, symbols, selected text, and open files.
- Continue: local-first codebase awareness, local index storage, configurable retrieval counts, and reranking.
- Windsurf: optimized RAG over current/open files, indexed local codebase, rules, memories, and team knowledge sources.
- Zed: simple built-in read/search/edit tools, explicit agent profiles, and tool permissions.
- Aider / code graph systems: compact repo maps and definition/reference graph context before large file reads.

Current v2 copies the safest part: deterministic local search with exact line anchors, code-graph-lite symbols, hybrid query fan-out, and metadata-only active-file hints. Embeddings, repo history, full code graph, and reranking are still benchmark-gated.

Current v2 adds a no-model symbol-map layer: functions, classes, exports, routes, MCP tool names, imports/reexports, and test counterparts. It is intentionally code-graph-lite, not a full persistent index.

Current v2 also adds deterministic hybrid query fan-out. `retrieve_context` searches a small set of transparent local query plans, currently `lexical`, `expanded-variants`, and `quoted-phrases` when present. This copies the useful part of commercial multi-tool retrieval without embeddings or extra model calls: better candidate generation first, same compact snippet budget after ranking.

Current v2 also keeps identifier-style retrieval more token-disciplined without hiding useful evidence. Exact symbol definitions may be pulled forward for implementation-style questions, `compact_context` narrows the visible symbol map to the most exact identifier matches first, and fallback line-match ranges still stay wide enough to preserve benchmarked terms such as installer entrypoints and failure summaries. The rule is simple: quality wins first, then token savings.

Current v2 also supports metadata-only `context_hints`:

- `selected_paths`: strongest signal, for files/ranges the agent or IDE is actively focused on.
- `diagnostic_files`: failing test, lint, stack trace, or CI files.
- `changed_files_override`: client-provided changed files when git status is not enough.
- `open_files`: useful open-editor context.
- `recent_files`: weak recency signal.

Hints never bypass the path policy and do not carry file bodies. They only boost candidate ranking; agents still read exact returned files before editing.

Current v2 also exposes a token-budgeted repo map:

- `get_repo_map` builds a deterministic orientation map from path priority and code-graph-lite symbols.
- `retrieve_context` can include the same map with `include_repo_map=true`.
- The map is for architecture/onboarding orientation only; agents still read exact files before edits.

Current v2 trace-to-benchmark loop:

- `benchmarks/from-traces.json` stores manually reviewed benchmark cases promoted from `record_feedback`.
- `scripts/trace-to-benchmark.mjs` reads `$HOME/.hwai/retrieval-mcp/feedback.jsonl` by default and outputs `needs_review` candidates.
- Candidates should be copied into `from-traces.json` only after exact file inspection and safe-query review.

## What Not To Do

- Do not call retrieval for every small question. Use it when the target files are unclear or the task spans modules.
- Do not treat retrieval output as final truth. It is context prep; exact files must still be read before edits.
- Do not send secrets or credential paths through retrieval. Hard excludes block common cases, but agents should still avoid credential-oriented queries.
- Do not move the default service to a VPS mirror. Local-first matters because uncommitted branch state is the highest-value context during coding.

## Team Install

Install local MCP configs for Claude Code, Codex, Cursor, and Windsurf:

```bash
cd services/retrieval-mcp
npm run install:local-configs
```

Limit to one tool:

```bash
npm run install:local-configs -- --agents=codex
npm run install:local-configs -- --agents=claude
npm run install:local-configs -- --agents=cursor
npm run install:local-configs -- --agents=windsurf
```

The installer creates backups before changing existing config files. Restart the agent or open a new chat after install.
