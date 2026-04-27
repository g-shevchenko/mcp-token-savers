# vision-mcp

Local-first screenshot preparation MCP. It turns raw screenshots or screenshot
URLs into compact, model-ready artifacts and structured review scaffolds.

## Tools

- `prepare_screenshot`
- `batch_prepare_screenshots`
- `prepare_screenshot_diff`
- `get_artifact`
- `get_measurement_report`

Compatibility aliases may also expose older `analyze_*` names.

## Local Usage

```bash
cd ~/.hwai/hwai-mcp-stack/mcp/source/services/vision-mcp
npm install
npm run build
npm run smoke
```

For URL inputs, either set a safe allowlist:

```bash
VISION_ALLOWED_HOSTS=example.com
```

or explicitly allow arbitrary image URLs for local experiments:

```bash
ALLOW_ANY_IMAGE_URL=1
```

## Privacy

The MCP stores local artifacts under `~/.hwai/vision-mcp` by default.
Measurement exports should stay aggregate-only and must not include raw
screenshots, raw URLs, local image paths, private notes, or env values.
