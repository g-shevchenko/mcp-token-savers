# playwright-trace-mcp

Local-first Playwright trace MCP for compact browser-debug evidence before frontier reasoning

## Role in the stack

Compact browser-debug evidence from Playwright trace.zip/HAR/screenshots.

## When agents should use it

UI/E2E failures, console/network failures, and screenshot-heavy browser debugging.

## What it improves

Avoids dumping huge trace archives into a frontier prompt.

## When not to use it

Do not commit raw traces; use local artifacts only.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/playwright-trace-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `browser-debug`, `full` |
| service dir | `mcp/source/services/playwright-trace-mcp` |
| stdio entrypoint | `mcp/source/services/playwright-trace-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/playwright-trace-mcp` |

## Tools

- `prepare_trace`
- `summarize_console`
- `summarize_network`
- `extract_failure_step`
- `prepare_trace_screenshots`
- `get_artifact`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run fixtures:real` - `node ./scripts/generate-real-fixtures.mjs`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Aggregate exports should be metadata-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/playwright-trace-mcp
npm run build
npm run smoke
```
