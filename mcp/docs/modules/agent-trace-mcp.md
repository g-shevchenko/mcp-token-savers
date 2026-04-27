# agent-trace-mcp

Local-first agent trace MCP for compact session graphs and Pantheon-safe aggregate telemetry

## Role in the stack

Local session trace graph and aggregate telemetry for agent workflows.

## When agents should use it

Debugging multi-step agent runs and comparing session behavior without leaking raw content.

## What it improves

Shows which steps/tools mattered and exports aggregate-only telemetry.

## When not to use it

Do not store raw prompts/code/secrets in trace notes.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/agent-trace-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/agent-trace-mcp` |
| stdio entrypoint | `mcp/source/services/agent-trace-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/agent-trace-mcp` |

## Tools

- `start_trace`
- `record_step`
- `record_tool_result`
- `summarize_session`
- `compare_sessions`
- `export_pantheon_safe`
- `get_artifact`
- `get_measurement_report`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run dev` - `tsc --watch`
- `npm run benchmark` - `npm run build && node ./scripts/benchmark-local.mjs`
- `npm run benchmark:playwright` - `npm run build && node ../../scripts/hwai-ensure-service-deps.mjs services/playwright-trace-mcp && npm --prefix ../playwright-trace-mcp run build && node ../../scripts/hwai-playwright-agent-trace-proof.mjs`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run measurement:report` - `npm run build && node ./scripts/measurement-report.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

## Data policy

The module must keep raw local evidence local. Measurement exports should be aggregate-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/agent-trace-mcp
npm run build
npm run smoke
npm run measurement:report
```
