# crawl4ai-mcp

Stdio MCP wrapper for Crawl4AI service (structured extraction, site crawl, llms.txt generation).

## Role in the stack

Crawl4AI wrapper for crawls, structured extraction, and llms.txt generation.

## When agents should use it

Multi-page external extraction, product/page schema extraction, crawl jobs.

## What it improves

Offloads external crawling from local agents while keeping keys per user.

## When not to use it

Requires Crawl4AI token; manage quotas per user.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/crawl4ai-mcp` |
| version | `1.2.0` |
| category | `external-context wrapper` |
| profiles | `external-context`, `full` |
| service dir | `mcp/source/services/crawl4ai-mcp` |
| stdio entrypoint | `mcp/source/services/crawl4ai-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/crawl4ai-mcp` |

## Tools

- `crawl`
- `extract_structured`
- `generate_llmstxt`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

Required env: `HWAI_CRAWL4AI_TOKEN`

Optional env: `HWAI_CRAWL4AI_URL`, `HWAI_CRAWL4AI_EMAIL`

Secrets must live in `~/.hwai/mcp-stack/env`, never in Git or Notion.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/crawl4ai-mcp
npm run build
npm run smoke
npm run measurement:report
```
