# router-lite-mcp

Local-first deterministic trigger/skip policy for **HWAI Context Router**.

## Role in the stack

`router-lite-mcp` is the current lightweight routing engine behind HWAI Context
Router. It decides whether an agent should call a prep/evidence MCP before
frontier reasoning, and records aggregate token-efficiency signals.

## When agents should use it

At the start of a task when it is unclear whether retrieval, context prep, vision, local checks, or direct reasoning is the right first step.

## What it improves

Prevents unnecessary MCP calls while preserving frontier reasoning for
ambiguous or high-risk tasks. The product-level goal is lower context spend
without hiding quality risk.

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
