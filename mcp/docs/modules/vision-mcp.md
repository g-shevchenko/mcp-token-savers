# vision-mcp

MCP server for fetching and processing images from URLs

## Role in the stack

Screenshot/image prep, crops, diff prep, OCR/VLM hooks, artifact profiles.

## When agents should use it

Screenshot review, annotated bug reports, before/after diff, CDN screenshot URLs.
Customer- or team-specific screenshot CDNs are configured locally through
`VISION_ALLOWED_HOSTS`; they are not part of the product default allowlist.

## What it improves

Prepares bounded visual evidence before frontier vision models.

## When not to use it

Respect allowed-host policy; expand profiles only when needed.

## Installation metadata

| Field | Value |
| --- | --- |
| npm package | `@hwai/vision-mcp` |
| version | `1.0.0` |
| category | `local utility` |
| profiles | `browser-debug`, `full` |
| service dir | `mcp/source/services/vision-mcp` |
| stdio entrypoint | `mcp/source/services/vision-mcp/scripts/local-stdio.sh` |
| local cache | `$HOME/.hwai/vision-mcp` |

## Tools

- `fetch_image`
- `analyze_screenshot`
- `prepare_screenshot`
- `batch_analyze_screenshots`
- `batch_prepare_screenshots`
- `analyze_screenshot_diff`
- `prepare_screenshot_diff`
- `image_url_to_text`

## Scripts

- `npm run build` - `tsc`
- `npm run start` - `node dist/index.js`
- `npm run start:http` - `node dist/index.js --http`
- `npm run dev` - `tsc --watch`
- `npm run smoke` - `bash ./scripts/smoke-local.sh`
- `npm run smoke:http` - `bash ./scripts/smoke-http.sh`
- `npm run smoke:bridge` - `node ./scripts/smoke-bridge.mjs`
- `npm run smoke:bridge:persistent` - `node ./scripts/smoke-bridge-persistent.mjs`
- `npm run prepare` - `npm run build`

## Keys and environment

No API keys are required for normal local use.

Default allowed image hosts:

- `example.com`

Override with:

```bash
VISION_ALLOWED_HOSTS=example.com,your-screenshot-cdn.example
```

For trusted local debugging only, `ALLOW_ANY_IMAGE_URL=1` disables the allowlist.
If a running agent still rejects a newly configured host after an update,
restart the agent session or open a new chat so the stdio MCP process reloads.

## Data policy

The module must keep raw local evidence local. Aggregate exports should be metadata-only: call counts, latency, token estimates, result counts, and safe status fields. No raw code, prompts, URLs, screenshots, traces, lockfile bodies, env values, or Notion bodies should be exported centrally.

## Proof commands

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/vision-mcp
npm run build
npm run smoke
```
