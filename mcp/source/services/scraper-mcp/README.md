# scraper-mcp / searxng-mcp / reader-mcp

Three stdio MCP wrappers over a scraper/search/reader HTTP surface.

The public-prep defaults point to local endpoints:

- `HWAI_SCRAPER_URL=http://localhost:8090`
- `HWAI_YT_TRANSCRIBE_URL=http://localhost:8091`

Set your own URLs and bearer keys in `~/.hwai/mcp-stack/env` when using the
`external-context` or `full` profile.

## Build

```bash
cd $HOME/.hwai/hwai-mcp-stack/mcp/source/services
for svc in scraper-mcp searxng-mcp reader-mcp; do
  (cd $svc && npm install && npm run build)
done
```

The bundle installer normally handles this for you.

## Env

```bash
HWAI_SCRAPER_URL=http://localhost:8090
HWAI_SCRAPER_KEY=replace_me
HWAI_YT_TRANSCRIBE_URL=http://localhost:8091
HWAI_YT_TRANSCRIBE_KEY=replace_me
```

Never commit bearer keys or generated env files.

## Tools Exposed To Agents

| MCP | Tool | When agents call it |
|---|---|---|
| `scraper` | `fetch_url(url, ...)` | JS-heavy sites, bot checks, clean markdown for LLM context |
| `scraper` | `extract_markdown(html)` | HTML already fetched, just need clean text |
| `scraper` | `extract_structured(...)` | Schema-driven structured extraction |
| `scraper` | `health` | Verify upstream scraper service before heavy batches |
| `scraper` | `keyring_stats` | Check upstream quota headroom before batch |
| `scraper` | `youtube_transcribe(...)` | Optional video transcript workflow if your backend supports it |
| `searxng` | `search(query, engines, ...)` | Aggregated SERP and enrichment |
| `reader` | `read(url|html, ...)` | Clean markdown extraction |
