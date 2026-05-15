# static-analysis-mcp

Local-first static analysis MCP for compact deterministic verification before frontier model reasoning

## Role in the stack

Local deterministic verification wrapper for tsc/eslint/tests/semgrep/gitleaks/SARIF.

## When agents should use it

Before final answers, after code changes, or when a failure log needs compact deterministic evidence.

## What it improves

Gives compact failure summaries without sending raw code/log bodies to central systems.

## When not to use it

Do not treat optional tool absence as a product failure; it reports local availability.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/static-analysis-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `core`, `repo`, `browser-debug`, `full` |
| service dir | `mcp/source/services/static-analysis-mcp` |
| stdio entrypoint | `mcp/source/services/static-analysis-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/static-analysis-mcp` |

## Tools

- `get_command_policy`
- `run_tsc`
- `run_eslint`
- `run_tests_changed`
- `run_semgrep_local`
- `run_gitleaks`
- `summarize_sarif`
- `get_artifact`

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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/static-analysis-mcp
npm run build
npm run smoke
```
