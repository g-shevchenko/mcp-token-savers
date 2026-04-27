# visual-baseline-mcp

Local-first visual baseline MCP for screenshot diff budgets before frontier vision reasoning

## Role in the stack

Local screenshot baseline creation, masking, approval, and diff budgets.

## When agents should use it

Visual regression checks and repeated UI screenshot comparisons.

## What it improves

Lets agents reason from compact diff metrics instead of full image dumps.

## When not to use it

A diff budget is evidence, not final visual judgment.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/visual-baseline-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `browser-debug`, `full` |
| service dir | `mcp/source/services/visual-baseline-mcp` |
| stdio entrypoint | `mcp/source/services/visual-baseline-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/visual-baseline-mcp` |

## Tools

- `create_baseline`
- `approve_baseline`
- `save_mask_preset`
- `compare_screenshot`
- `get_artifact`
- `get_measurement_report`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run benchmark` - `npm run build && node ./scripts/benchmark-local.mjs`
- `npm run benchmark:cdn` - `npm run build && node ./scripts/benchmark-cdn-screenshot-fixture.mjs`
- `npm run benchmark:hwai-verify` - `npm run build && node ./scripts/benchmark-hwai-verify-fixture.mjs`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/visual-baseline-mcp
npm run build
npm run smoke
npm run measurement:report
```
