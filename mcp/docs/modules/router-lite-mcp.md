# router-lite-mcp

Local-first deterministic MCP trigger/skip policy router for Humanswith.ai utility prep tools

## Role in the stack

Cheap deterministic trigger policy before expensive reasoning.

## When agents should use it

At the start of a task when it is unclear whether retrieval, context prep, vision, local checks, or direct reasoning is the right first step.

## What it improves

Prevents unnecessary MCP calls while preserving frontier reasoning for ambiguous or high-risk tasks.

## When not to use it

Do not let it answer user tasks or downgrade high-risk reasoning.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/router-lite-mcp` |
| version | `0.1.0` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/router-lite-mcp` |
| stdio entrypoint | `mcp/source/services/router-lite-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/router-lite-mcp` |

## Tools

- `route_task`
- `classify_input`
- `needs_clarification`

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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/router-lite-mcp
npm run build
npm run smoke
```
