# HWAI Context Prep MCP Server

Parser-first MCP server for reducing noisy text context before Claude Code, Codex, Cursor, Windsurf, ContentOS, or HWAI automations spend frontier-model tokens.

The service does **not** replace final reasoning. It prepares context:

- long logs -> failing command, top errors, stack frames, impacted files, raw artifact
- public URLs -> title, canonical URL, cleaned markdown, headings, key facts, links, warnings, parser-stack provenance
- long text/specs/handoffs -> summary lines, decisions, action items, open questions, risks
- all modes -> compact output plus artifact URL for exact fallback
- all calls -> JSONL request log with metadata only, never raw pasted content
- local default traces -> `$HOME/.hwai/context-prep-mcp/requests.jsonl`

## Design Rule

Quality beats token savings.

Use compact output when parser confidence is good. If exact wording, pricing, legal text, security-sensitive details, or ambiguous logs matter, fetch the artifact and spend the extra tokens.

## Tools

- `prep_logs` — compact terminal/CI/build/test/runtime logs
- `prep_url` — fetch and clean one public URL; local parser first, HWAI `scraper-core /fetch` fallback when needed
- `prep_text` — compact long pasted text, specs, handoffs, meeting notes, chat history
- `get_artifact` — retrieve raw/cleaned artifacts by URL or file name

## Parser Stack Integration

`prep_url` is intentionally a thin token-prep layer on top of the existing HWAI parsing stack, not a competing scraper.

Default behavior:

1. Try the cheap local parser first: guarded HTTP fetch, Cheerio cleanup, headings/facts/links extraction.
2. If local extraction looks unsafe or incomplete, call HWAI `scraper-core /fetch` with `extract_markdown=true`.
3. Return compact markdown plus parser provenance so the agent knows whether it used local parsing or the shared scraper stack.

Fallback triggers in `parser_stack: "auto"`:

- local fetch failed
- very low extracted text volume
- likely JS shell, Cloudflare/DataDome/Turnstile/captcha/challenge shell
- non-HTML content where local cleanup is not trustworthy

Explicit modes:

```json
{
  "url": "https://example.com",
  "parser_stack": "auto",
  "max_tier": "camoufox",
  "allow_paid_tiers": false,
  "session_id": "greg-research-batch"
}
```

- `auto` — recommended. Local first, scraper-core fallback only when useful.
- `local` — never call scraper-core. Best for our own APIs/CDN/GitHub/raw/RSS.
- `scraper_core` — force shared parser stack. Best for hostile, JS-heavy, or exact webpage reading.

Cost guardrail: paid/proxy tiers are not allowed by default. `max_tier` is clamped to free/browser tiers unless `allow_paid_tiers=true`.

Use scraper-stack directly instead of `context-prep` for:

- SERP / keyword / AI Overview research
- structured extraction with schemas (`product_pricing@v1`, `company_contact@v1`, etc.)
- batch crawling
- `/interact` browser actions
- `/deep-research` cited research

In those cases call `scraper-mcp`, `reader-mcp`, `crawl4ai-mcp`, `searxng-mcp`, or `scraper-core` HTTP directly, then optionally pass the resulting noisy markdown/logs through `context-prep`.

## Auto-Trigger Policy

Call `context-prep-mcp` automatically only for noisy inputs:

- logs longer than ~150 lines, ~8-10k chars, or containing stack traces / repeated errors
- specific URLs the user asks the agent to read, compare, summarize, or extract from
- pasted text/spec/handoff longer than ~5k chars

Do **not** call it for:

- short questions
- normal local file reads
- final architecture decisions
- high-risk ambiguous reasoning
- open-ended "latest" research without a specific URL

## Output Contract

Each prep tool returns:

```json
{
  "schema_version": "context-prep.v1",
  "pipeline_version": "2026-04-23.parser-first-v1",
  "prep_mode": "logs-prep | url-prep | text-prep",
  "input_stats": {
    "raw_tokens_estimate": 12000,
    "compact_tokens_estimate": 1600,
    "saved_tokens_estimate": 10400,
    "savings_pct": 86.7
  },
  "compact_context": "small context for the frontier model",
  "parser_stack": {
    "requested": "auto",
    "used": "scraper_core",
    "fallback_reason": "likely_js_or_challenge_shell",
    "scraper_core": {
      "engine": "camoufox",
      "cache_hit": false,
      "duration_ms": 1840,
      "tiers_tried": ["firstparty", "curl_cffi", "camoufox"]
    }
  },
  "artifacts": {
    "raw_log_url": "http://localhost:3394/artifacts/..."
  },
  "confidence": {
    "uncertainty": 0.02,
    "reasons": []
  },
  "autopilot": {
    "requires_clarification": false,
    "suggested_action": "debug_from_compact_log"
  },
  "prompt_scaffold": "How the agent should use the compact output."
}
```

## Claude Code / Codex / Cursor / Windsurf Workflow

1. Detect trigger from `AGENTS.md` / Cursor rules / Codex instructions.
2. Call the matching prep tool.
3. Use compact output for the first reasoning pass.
4. If `confidence.uncertainty > 0.03`, `autopilot.requires_clarification = true`, or exact wording matters, call `get_artifact` or open the artifact URL.
5. Only then make code changes or final recommendations.

Branch metadata should be sent when available:

```json
{
  "metadata": {
    "owner": "greg",
    "project": "hwai",
    "surface": "codex",
    "repo": "team-workspace",
    "branch": "feature/example",
    "commit_sha": "abc123",
    "session_id": "local-chat"
  }
}
```

This metadata is attribution, not a trigger. The service should not run once per branch automatically.

## ContentOS / Frontier Service Integration

Do not put `context-prep-mcp` on every ContentOS model call.

Good integration points after v1 stabilizes:

- before summarizing long source URLs
- before sending scraped HTML or external docs to a frontier model
- before debugging long generation / publication / QA logs
- before handoff generation from long campaign notes

Bad integration points:

- short editorial prompts
- final copy quality judgment
- tasks where exact source wording is the product
- hot synchronous paths where URL fetch latency would slow UX without clear token savings

## Data Policy

- Raw pasted logs, text, fetched pages, and local artifacts stay in the configured local/cache artifact store.
- Request logs store metadata and token estimates, not raw pasted content.
- Pantheon-safe exports are aggregate-only and exclude raw text, local paths, artifact URLs, and samples.
- If exact wording matters, agents should fetch the artifact locally instead of trusting compact output.

Recommended ContentOS rule:

- if raw input is under ~5k chars, skip prep
- if raw input is 5k-30k chars, call prep synchronously
- if raw input is >30k chars or URL fetching may be slow, call prep asynchronously and store artifact
- always keep a "use raw input" fallback

## Local Development

```bash
cd services/context-prep-mcp
npm install
npm run build
npm run smoke
npm run benchmark
CONTEXT_PREP_TRANSPORT=http npm run start:http
```

Health:

```bash
curl http://localhost:3394/health
```

MCP smoke:

```bash
npm run smoke
npm run smoke:http
```

`npm run smoke` exercises the local stdio MCP path through `scripts/local-stdio.sh`; `npm run smoke:http` is the HTTP transport smoke for a running service.

HTTP benchmark, against a running local or remote service:

```bash
CONTEXT_PREP_URL=http://localhost:3394 \
CONTEXT_PREP_MCP_URL=http://localhost:3394/mcp \
npm run benchmark:http
```

Measurement report from metadata-only request logs:

```bash
npm run measurement:report
npm run measurement:report -- --since=2026-04-24T00:00:00Z --out=/tmp/context-prep-report.json
```

REST smoke:

```bash
curl -fsS http://localhost:3394/api/prep/logs \
  -H 'content-type: application/json' \
  -d '{"text":"$ npm run build\nsrc/app.ts:1:1 - error TS2304: Cannot find name foo."}'
```

## Deployment

Public-prep builds are local-first and do not ship an opinionated VPS
deployment script. Run the stdio server locally by default, or deploy the Node
HTTP mode behind your own service manager and reverse proxy.

Optional scraper env:

- `CONTEXT_PREP_SCRAPER_CORE_URL` — default `http://localhost:8090`
- `CONTEXT_PREP_SCRAPER_KEY` or `HWAI_SCRAPER_KEY` — bearer key for fallback/forced parser-stack mode
- `CONTEXT_PREP_SCRAPER_MAX_TIER` — default `camoufox`
- `CONTEXT_PREP_SCRAPER_FALLBACK=disabled` — disables automatic scraper-core fallback
- `CONTEXT_PREP_SCRAPER_TIMEOUT_MS` — default `30000`

## Monitoring And Auto-Recovery

For local use, `get_measurement_report` is the primary health and usage view.
For hosted HTTP mode, wire `GET /health` into your own monitor.

## Benchmark Targets

`npm run benchmark` is the local, no-external-network regression gate. It runs synthetic golden cases for:

- `prep_logs`: noisy TypeScript build failure with the first real error and impacted file preserved
- `prep_text`: mixed RU/EN handoff with decisions, action items, open questions, and risks
- `prep_url`: local HTML page served from `localhost` with local parser forced

It fails when required evidence is missing, confidence is too low, or token savings falls below the per-mode gate.

Minimum v1 gates:

- `prep_logs`: retains first real error, at least one impacted file, and gives `savings_pct >= 60` for long logs
- `prep_url`: returns title/final URL and does not fetch private IPs
- `prep_text`: extracts decisions/actions/questions from mixed RU/EN text
- p95 local parser latency under 3s for normal inputs
- compact responses should stay under 10k chars unless caller opted into larger output

Current measurement loop:

- `CONTEXT_PREP_CACHE_DIR` defaults to `$HOME/.hwai/context-prep-mcp` for durable local traces across Claude/Codex/Cursor/Windsurf.
- `requests.jsonl` stores metadata-only request/output summaries: no raw pasted logs, text, URLs bodies, or artifact contents.
- `npm run measurement:report` aggregates requests, errors, token savings, p95 latency, high-uncertainty counts, and parser usage by tool/transport/parser.
- Reports include `by_trace_source` plus actionable/proof-loop high-uncertainty splits so smoke and benchmark traces do not drive product tuning.
