# docs-sync-mcp

Local-first docs sync MCP for repo SSOT versus Notion mirror manifests, stale mirrors, title drift, action extraction, and update candidates

## Role in the stack

Repo SSOT versus Notion mirror checks and update-candidate extraction.

## When agents should use it

When repo docs need Notion mirrors or Notion pages may be stale.

## What it improves

Keeps Notion as mirror while repo markdown remains SSOT.

## When not to use it

It proposes updates; it does not replace human source-of-truth decisions.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/docs-sync-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/docs-sync-mcp` |
| stdio entrypoint | `mcp/source/services/docs-sync-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/docs-sync-mcp` |

## Tools

- `compare_repo_notion_mirror`
- `find_stale_notion_mirrors`
- `extract_repo_actions`
- `propose_notion_update`
- `check_doc_registry`
- `get_artifact`
- `get_measurement_report`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run benchmark` - `npm run build && node ./scripts/benchmark-local.mjs`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/docs-sync-mcp
npm run build
npm run smoke
npm run measurement:report
```
