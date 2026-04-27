# repo-hygiene-mcp

Local-first repo hygiene MCP for advisory cleanup evidence before agents add or delete code/docs

## Role in the stack

Advisory cleanup evidence for unused code/deps, duplicates, cycles, and complexity hotspots.

## When agents should use it

When repo size grows or before cleanup/refactor planning.

## What it improves

Keeps local repos smaller and easier for agents to reason about.

## When not to use it

Do not auto-delete; require exact file reads and tests.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/repo-hygiene-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/repo-hygiene-mcp` |
| stdio entrypoint | `mcp/source/services/repo-hygiene-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/repo-hygiene-mcp` |

## Tools

- `scan_unused_code`
- `scan_unused_dependencies`
- `scan_duplicate_code`
- `scan_dependency_cycles`
- `scan_complexity_hotspots`
- `propose_cleanup_plan`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/repo-hygiene-mcp
npm run build
npm run smoke
npm run measurement:report
```
