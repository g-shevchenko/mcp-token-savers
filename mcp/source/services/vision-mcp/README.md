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
VISION_ALLOWED_HOSTS=example.com,your-screenshot-cdn.example
```

or explicitly allow arbitrary image URLs for local experiments:

```bash
ALLOW_ANY_IMAGE_URL=1
```

By default, Vision-MCP allows only neutral sample hosts. Team- or customer-
specific screenshot CDNs must be configured locally through
`VISION_ALLOWED_HOSTS`; they are not baked into the open-source or commercial
product defaults.

If an already-open Claude Code, Codex, Cursor, or Windsurf session still rejects
that host after an update, restart the agent session or open a new chat so the
stdio MCP process reloads its code and environment. A local override that
allowlists your own screenshot host looks like:

```bash
VISION_ALLOWED_HOSTS=example.com,your-screenshot-cdn.example
```

Use `ALLOW_ANY_IMAGE_URL=1` only for trusted local debugging; it disables the
host allowlist.

## Performance

`prepare_screenshot` is prep-first: the frontier model reads the prepared
full-frame and crops directly. The optional Tesseract OCR pass only adds a
discarded text *hint* and defaults to English (`eng`), so on non-English or
dense screenshots it spends time producing low-confidence output the
prep-first flow never uses. Unless you specifically consume the OCR hint,
disable it for noticeably faster, cheaper prep:

```bash
VISION_MCP_ENABLE_OCR=0
```

## Privacy

The MCP stores local artifacts under `~/.hwai/vision-mcp` by default.
Measurement exports should stay aggregate-only and must not include raw
screenshots, raw URLs, local image paths, private notes, or env values.
