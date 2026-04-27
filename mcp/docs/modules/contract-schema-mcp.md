# contract-schema-mcp

Local-first contract/schema MCP for OpenAPI, Zod, env contracts, payload validation, and drift checks

## Role in the stack

OpenAPI/Zod/env contract indexing, snapshots, payload validation, and drift checks.

## When agents should use it

API changes, env contract changes, integration handoffs, breaking-change review.

## What it improves

Prevents schema drift and missing env examples without reading secret values.

## When not to use it

Do not feed raw secret env files; use examples/templates.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/contract-schema-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/contract-schema-mcp` |
| stdio entrypoint | `mcp/source/services/contract-schema-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/contract-schema-mcp` |

## Tools

- `index_openapi`
- `index_zod`
- `index_env_contracts`
- `create_contract_snapshot`
- `diff_contracts`
- `validate_payload_sample`
- `summarize_breaking_changes`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/contract-schema-mcp
npm run build
npm run smoke
npm run measurement:report
```
