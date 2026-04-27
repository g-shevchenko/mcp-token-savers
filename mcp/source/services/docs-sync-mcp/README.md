# HWAI Docs Sync MCP

Local-first advisory MCP for repo Markdown SSOT versus Notion mirror manifests and doc registries.

It compares repo docs with a local mirror manifest, finds stale/missing mirrors and title drift, extracts action markers without raw-body telemetry, and proposes Notion update candidates. It does not write to Notion in v0.1.

## Tools

- `compare_repo_notion_mirror`
- `find_stale_notion_mirrors`
- `extract_repo_actions`
- `propose_notion_update`
- `check_doc_registry`
- `get_artifact`
- `get_measurement_report`

## Local Stdio

```bash
services/docs-sync-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/docs-sync-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/docs-sync-mcp/requests.jsonl
```

## Proof Loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/docs-sync-local-benchmark.json
node scripts/measurement-report.mjs --date=2026-04-25 --format=pantheon
```

## Data Policy

- Raw doc bodies, Notion content, Notion URLs, local paths, and artifact URLs are not written to request logs.
- Pantheon exports are aggregate-only.
- Tool outputs may include repo-relative source paths, repo titles, hashes, line numbers, hashed mirror titles, and hashed Notion IDs for local review.
- Agents must read exact repo docs before editing Notion mirrors.
