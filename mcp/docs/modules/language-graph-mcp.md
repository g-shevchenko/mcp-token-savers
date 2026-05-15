# language-graph-mcp

Local-first language graph MCP for structural repo navigation, references, and blast-radius checks

## Role in the stack

Structural code graph for outlines, symbols, references, imports, and blast radius.

## When agents should use it

Large repo navigation, architecture questions, and impact checks before editing.

## What it improves

Improves recall without loading the whole repo into the frontier model.

## When not to use it

Still read exact files before edits.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/language-graph-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/language-graph-mcp` |
| stdio entrypoint | `mcp/source/services/language-graph-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/language-graph-mcp` |

## Tools

- `index_repo`
- `get_graph_status`
- `get_file_outline`
- `find_symbol`
- `find_references`
- `get_import_neighbors`
- `get_blast_radius`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/language-graph-mcp
npm run build
npm run smoke
```
