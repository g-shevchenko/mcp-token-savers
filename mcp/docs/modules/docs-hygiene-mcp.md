# docs-hygiene-mcp

Local-first docs hygiene MCP for advisory Markdown link, duplicate, orphan, stale-reference, and SSOT checks

## Role in the stack

Markdown hygiene: links, anchors, orphan docs, duplicates, stale references, SSOT conflicts.

## When agents should use it

When docs grow, after large documentation work, or before sharing team onboarding material.

## What it improves

Reduces documentation drift and duplicated guidance.

## When not to use it

Some warnings are advisory; root runbooks may intentionally differ.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/docs-hygiene-mcp` |
| version | `0.1.1` |
| category | `local utility` |
| profiles | `repo`, `full` |
| service dir | `mcp/source/services/docs-hygiene-mcp` |
| stdio entrypoint | `mcp/source/services/docs-hygiene-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/docs-hygiene-mcp` |

## Tools

- `inventory_docs`
- `find_broken_links`
- `find_broken_anchors`
- `find_orphan_docs`
- `find_duplicate_sections`
- `find_stale_code_references`
- `check_doc_frontmatter`
- `check_ssot_conflicts`
- `propose_doc_merge_or_archive`
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
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/docs-hygiene-mcp
npm run build
npm run smoke
npm run measurement:report
```
