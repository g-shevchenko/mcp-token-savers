# reader-mcp

Stdio MCP wrapper for HTML→markdown via scraper-core /extract (trafilatura → LiteLLM Cerebras → Gemini → Ollama).

## Role in the stack

HTML-to-markdown reader through scraper-core extraction tiers.

## When agents should use it

Reading article/page content when local parsers need remote fallback.

## What it improves

Compacts pages into markdown via shared parser cascade.

## When not to use it

Do not use for confidential URLs unless policy allows.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/reader-mcp` |
| version | `1.1.0` |
| category | `external-context wrapper` |
| profiles | `external-context`, `full` |
| service dir | `mcp/source/services/reader-mcp` |
| stdio entrypoint | `mcp/source/services/reader-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/reader-mcp` |

## Tools

- `read`

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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/reader-mcp
npm run build
npm run smoke
npm run measurement:report
```
