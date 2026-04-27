# searxng-mcp

Stdio MCP wrapper for aggregated SERP via scraper-core /serp (SearXNG + 15 engines + optional enrichment).

## Role in the stack

SERP wrapper through scraper-core/SearXNG engines.

## When agents should use it

Search tasks where live external context is required.

## What it improves

Provides controlled SERP gathering instead of ad hoc browsing.

## When not to use it

Requires per-user scraper key; use aggregate-only accounting.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/searxng-mcp` |
| version | `1.1.0` |
| category | `external-context wrapper` |
| profiles | `external-context`, `full` |
| service dir | `mcp/source/services/searxng-mcp` |
| stdio entrypoint | `mcp/source/services/searxng-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/searxng-mcp` |

## Tools

- `search`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

Required env: `HWAI_SCRAPER_KEY`

Optional env: `HWAI_SCRAPER_URL`

Secrets must live in `~/.hwai/mcp-stack/env`, never in Git or Notion.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/searxng-mcp
npm run build
npm run smoke
npm run measurement:report
```
