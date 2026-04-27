# repo-quality-gate-mcp

Local-first advisory repo quality gate MCP for clean new work budgets

## Role in the stack

Advisory clean-new-work budgets for code/docs/context growth.

## When agents should use it

Before committing or handing off large additions, generated output, docs growth, or broad refactors.

## What it improves

Catches context bloat and review risk early; never blocks by itself.

## When not to use it

Do not delete or rewrite based only on this output.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/repo-quality-gate-mcp` |
| version | `0.1.2` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/repo-quality-gate-mcp` |
| stdio entrypoint | `mcp/source/services/repo-quality-gate-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/repo-quality-gate-mcp` |

## Tools

- `check_new_code_budget`
- `check_new_docs_budget`
- `check_context_budget`
- `create_quality_snapshot`
- `compare_quality_snapshot`
- `propose_quality_gate_plan`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/repo-quality-gate-mcp
npm run build
npm run smoke
npm run measurement:report
```
