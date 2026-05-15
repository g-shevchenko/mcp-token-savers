# repo-history-mcp

Local-first git history MCP for compact repo history evidence and Pantheon-safe aggregate telemetry

## Role in the stack

Compact git history, blame, diff-stat, hotspot, and co-change evidence.

## When agents should use it

When a change area is historically risky or ownership/regression context matters.

## What it improves

Adds local historical context without raw diffs or file bodies.

## When not to use it

Requires a git workspace for meaningful tool calls.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/repo-history-mcp` |
| version | `1.1.0` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/repo-history-mcp` |
| stdio entrypoint | `mcp/source/services/repo-history-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/repo-history-mcp` |

## Tools

- `summarize_recent_commits`
- `search_commits`
- `summarize_file_history`
- `summarize_blame`
- `summarize_diff_stat`
- `find_change_hotspots`
- `find_cochange_files`
- `get_artifact`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Aggregate exports should be metadata-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/repo-history-mcp
npm run build
npm run smoke
```
