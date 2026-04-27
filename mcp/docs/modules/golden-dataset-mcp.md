# golden-dataset-mcp

Local-first golden dataset MCP for benchmark cases, safe run comparisons, and Pantheon-safe aggregate telemetry

## Role in the stack

Benchmark dataset management and safe run comparisons.

## When agents should use it

When retrieval/context/quality changes need regression proof before ranking/policy changes.

## What it improves

Turns real misses/partials into reviewed benchmark cases.

## When not to use it

Do not add benchmark cases casually without trace evidence.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/golden-dataset-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/golden-dataset-mcp` |
| stdio entrypoint | `mcp/source/services/golden-dataset-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/golden-dataset-mcp` |

## Tools

- `list_datasets`
- `add_case_from_feedback`
- `run_dataset`
- `import_retrieval_feedback`
- `run_retrieval_dataset`
- `compare_runs`
- `export_dataset_manifest`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/golden-dataset-mcp
npm run build
npm run smoke
npm run measurement:report
```
