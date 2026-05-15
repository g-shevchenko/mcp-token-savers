# context-prep-mcp

Parser-first MCP server for compacting logs, URLs, and long text before frontier model reasoning

## Role in the stack

Parser-first compression for logs, URLs, and long text.

## When agents should use it

Long terminal output, CI logs, copied specs, noisy web pages, and pasted chat dumps.

## What it improves

Turns noisy raw input into compact summaries/artifacts before frontier reasoning.

## When not to use it

Do not use when exact wording matters unless artifacts are inspected.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/context-prep-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/context-prep-mcp` |
| stdio entrypoint | `mcp/source/services/context-prep-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/context-prep-mcp` |

## Tools

- `prep_logs`
- `prep_url`
- `prep_text`
- `get_artifact`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run start:http` - `node dist/index.js --http`
- `npm run dev` - `tsc --watch`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run smoke:http` - `bash ./scripts/smoke-http.sh`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Aggregate exports should be metadata-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/context-prep-mcp
npm run build
npm run smoke
```
