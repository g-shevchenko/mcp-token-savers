# scraper-mcp

Stdio MCP wrapper over scraper-core HTTP API. Proactive fetcher for Claude Code / Cursor / Codex / Windsurf agents.

## Role in the stack

Stdio wrapper over a Humanswith.ai scraper-core-compatible fetch/extract/browser stack.

## When agents should use it

External URLs, JS/challenge-heavy pages, structured extraction, YouTube transcription routing.

## What it improves

Centralizes expensive external context collection with per-user keys and aggregate accounting.

## When not to use it

Requires per-user key; do not leak raw URLs/queries in central exports.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/scraper-mcp` |
| version | `1.1.0` |
| category | `external-context wrapper` |
| profiles | `external-context`, `full` |
| service dir | `mcp/source/services/scraper-mcp` |
| stdio entrypoint | `mcp/source/services/scraper-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/scraper-mcp` |

## Tools

- `fetch_url`
- `extract_markdown`
- `extract_structured`
- `health`
- `keyring_stats`
- `youtube_transcribe`
- `youtube_transcribe_status`
- `youtube_transcribe_health`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

Required env: `HWAI_SCRAPER_KEY`

Optional env: `HWAI_SCRAPER_URL`, `HWAI_YT_TRANSCRIBE_KEY`, `HWAI_YT_TRANSCRIBE_URL`

Secrets must live in `~/.hwai/mcp-stack/env`, never in Git or Notion.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/scraper-mcp
npm run build
npm run smoke
npm run measurement:report
```
