# retrieval-mcp

Local-first deterministic codebase retrieval MCP for token-efficient agent context

## Role in the stack

Local repo retrieval that finds likely files/snippets before an agent reads exact files.

## When agents should use it

Broad codebase questions, bug fixes, reviews, or implementation tasks when target files are not obvious.

## What it improves

Reduces manual search and prompt stuffing; records misses/partials for benchmark candidates.

## When not to use it

Do not use for secrets or when the exact file is already known.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/retrieval-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/retrieval-mcp` |
| stdio entrypoint | `mcp/source/services/retrieval-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/retrieval-mcp` |

## Tools

- `retrieve_context`
- `find_files`
- `get_artifact`
- `get_repo_map`
- `record_feedback`
- `get_measurement_report`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run start:http` - `node dist/index.js --http`
- `npm run dev` - `tsc --watch`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run benchmark` - `npm run build && node ./scripts/benchmark-local.mjs`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run trace:candidates` - `npm run build && node ./scripts/trace-to-benchmark.mjs`
- `npm run e2e` - `bash ./scripts/e2e-local.sh`
- `npm run install:local-configs` - `node ./scripts/install-local-configs.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/retrieval-mcp
npm run build
npm run smoke
npm run measurement:report
```
