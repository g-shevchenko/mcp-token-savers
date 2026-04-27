# dependency-risk-mcp

Local-first dependency risk MCP for lockfile diffs, licenses, audit summaries, OSV summaries, package age, and supply-chain lockfile signals

## Role in the stack

Lockfile diff, audit, OSV, license, package age, and supply-chain summaries.

## When agents should use it

Dependency updates, package additions, release risk review.

## What it improves

Compact dependency risk evidence before frontier reasoning or PR review.

## When not to use it

External scanners are optional and local; missing binaries produce actionable warnings.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/dependency-risk-mcp` |
| version | `0.1.2` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/dependency-risk-mcp` |
| stdio entrypoint | `mcp/source/services/dependency-risk-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/dependency-risk-mcp` |

## Tools

- `summarize_lockfile_diff`
- `run_npm_audit`
- `summarize_npm_audit_fix_plan`
- `run_osv_scanner`
- `check_licenses`
- `package_age_report`
- `summarize_supply_chain_risk`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/dependency-risk-mcp
npm run build
npm run smoke
npm run measurement:report
```
