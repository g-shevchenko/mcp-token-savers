# Playwright Trace MCP

Local-first MCP for parsing Playwright browser-debug artifacts into compact evidence before frontier-model reasoning.

## Goal

`playwright-trace-mcp` reads local Playwright `trace.zip`, JSONL trace events, HAR/network logs, console logs, and screenshots. It returns compact evidence: primary failure, console errors, network failures, screenshot artifacts, and parser-stack handoff hints.

This is not a hosted Browserbase/Jam/Percy replacement. It is a deterministic local parser that helps agents avoid dumping large trace files, HARs, console logs, and screenshots into chat.

## Entrypoint

```bash
services/playwright-trace-mcp/scripts/local-stdio.sh
```

The local stdio script defaults durable state to:

```bash
$HOME/.hwai/playwright-trace-mcp
```

Durable local files:

- `$HOME/.hwai/playwright-trace-mcp/requests.jsonl`
- `$HOME/.hwai/playwright-trace-mcp/artifacts/`

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

## Tools

- `prepare_trace`
- `summarize_console`
- `summarize_network`
- `extract_failure_step`
- `prepare_trace_screenshots`
- `get_artifact`
- `get_measurement_report`

## Parser Stack Integration

`playwright-trace-mcp` is the browser-debug parser layer:

1. Local parser first: unzip/parse `trace.zip`, JSONL, HAR, console/network text.
2. `context-prep-mcp` next: use the compact markdown artifact when trace text is long or many failures need summarization.
3. `vision-mcp` next: use `prepare_trace_screenshots` artifacts for screenshot review/crops/diffs.
4. Scraper plane last: use scraper/fetch/interact only when a failed request or URL needs independent reproduction.

The MCP returns `handoff` hints:

- `context_prep_recommended`
- `vision_recommended`
- `scraper_followup_recommended`
- `preferred_next_tools`

This keeps the services composable without making one brittle cross-service chain.

## Data Policy

- Raw trace/HAR/console/network contents stay local.
- Request logs are metadata-only summaries.
- Pantheon-safe exports are aggregate-only.
- Pantheon-safe exports exclude raw traces, raw console logs, raw network logs, URLs, paths, samples, screenshots, and artifact URLs.

## Proof Loop

```bash
cd services/playwright-trace-mcp
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/playwright-trace-local-benchmark-2026-04-24.json
npm run fixtures:real -- --out=/tmp/playwright-trace-real-fixture-2026-04-24
npm run benchmark:real -- --real-fixtures-dir=/tmp/playwright-trace-real-fixture-2026-04-24 --out=/tmp/playwright-trace-real-benchmark-2026-04-24.json
npm run benchmark:agent-trace -- --out=/tmp/hwai-playwright-agent-trace-proof-2026-04-24.json
npm run benchmark:vision -- --out=/tmp/hwai-playwright-vision-proof-2026-04-24.json
node scripts/measurement-report.mjs --date=2026-04-24 --format=pantheon
cd ../..
node scripts/hwai-playwright-visual-baseline-proof.mjs --out=/tmp/hwai-playwright-visual-baseline-proof-2026-04-24-scope-query.json
```

## Benchmark Bar

- `tools/list` exposes all trace tools.
- Smoke covers trace, console, network, failure-step, screenshot empty-state, and measurement.
- Golden benchmark has zero failures.
- Real fixture benchmark generates local Playwright `trace.zip`, HAR, and screenshot artifacts, then verifies action failure extraction, console error parsing, 5xx network parsing, HAR slow-request parsing, screenshot extraction, and URL query stripping.
- Pantheon export stays aggregate-only and excludes raw URLs/artifact URLs.

Current local proof:

- synthetic benchmark: 10 cases, 0 failures
- real fixture benchmark: 19 cases, 0 failures
- visual baseline bridge proof: trace screenshot -> baseline approval -> same/changed/explicit-mask/preset-mask/scoped-query/dimension compare, passed
- agent-trace bridge proof: generated real `trace.zip`/HAR/screenshot -> 4 Playwright tool results -> 1 metadata-only agent session, passed
- vision bridge proof: trace screenshot artifact -> local one-shot HTTP render -> `vision-mcp.prepare_screenshot`, passed
- real trace signal: action failure, 2 console errors, 1 network failure, 4 screenshot artifacts
- real HAR signal: 1 slow request
- failure-window signal: nearby actions, console errors, network failures, and slow requests around the primary failure are grouped into compact evidence
- measurement signal: request logs and Pantheon-safe exports include aggregate `failure_window_*` counters only
- agent-trace safety signal: local agent-trace logs and Pantheon-safe export exclude raw trace paths, raw URLs, and artifact URLs
- vision safety signal: local vision request log excludes raw trace paths, screenshot paths, source URLs, and Playwright artifact URLs; generated screenshot has no red annotations, so `vision-mcp` correctly returns `requires_clarification=true`

## Current Role in HWAI Stack

Use this MCP when Playwright/browser debugging artifacts are available:

- failed E2E tests
- local UI proof loops
- Playwright trace viewer artifacts
- HAR/network debugging
- console-heavy browser failures

Agents still inspect exact artifacts locally when exact wording, screenshots, or reproduction details matter.

## Commercial Comparison

Useful commercial patterns reviewed:

- Playwright Trace Viewer: action timeline, before/after DOM snapshots, console, network, errors, and trace screenshots.
- Browserbase Observability: live view, session recording, events/pages timeline, console logs, network logs, HAR capture, and session metadata.
- Cypress Cloud Test Replay: command log time travel, developer tools, DOM/network/console/JS errors, element rendering, and collaborative replay.
- Jam DevTools: screenshot/screen recording, annotations, environment metadata, console logs, network details, and user events.
- Sentry/Datadog Session Replay: replay-to-error/trace correlation plus privacy controls and sampling.
- Percy: visual baseline, pixel diff, responsive comparison, and stabilization of noisy screenshots.

What HWAI intentionally keeps as moat:

- local trace/HAR/screenshot parsing first
- no extra paid browser observability infra
- no raw trace, URL query, screenshot, or artifact leakage to central exports or notification sinks
- direct handoff to `context-prep-mcp`, `vision-mcp`, and scraper follow-up only when evidence proves it is needed

Useful gaps still worth adding later:

- more real HWAI failed E2E `trace.zip` fixtures beyond the generated local fixture
- hosted/review-UI visual baseline approval store beyond the current v1 local file-backed baseline approvals, scoped mask presets, and diff budget proof
- optional trace waterfall UI; not needed for v1 parser quality
