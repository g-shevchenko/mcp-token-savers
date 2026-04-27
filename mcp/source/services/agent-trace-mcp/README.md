# Agent Trace MCP

Local-first MCP for compact agent session graphs, proof-loop attribution, and Pantheon-safe aggregate telemetry.

## Goal

`agent-trace-mcp` groups autonomous work into local metadata-only traces before HWAI exports any usage signal to Pantheon. It is the local replacement for the basic trace/session/agent-graph layer in products such as Langfuse, LangSmith, Helicone, and OpenTelemetry-based dashboards.

It is not a prompt logger. Do not record raw prompts, raw code, file bodies, secrets, or long notes.

## Entrypoint

```bash
services/agent-trace-mcp/scripts/local-stdio.sh
```

The local stdio script defaults durable state to:

```bash
$HOME/.hwai/agent-trace-mcp
```

Durable local files:

- `$HOME/.hwai/agent-trace-mcp/events.jsonl`
- `$HOME/.hwai/agent-trace-mcp/requests.jsonl`
- `$HOME/.hwai/agent-trace-mcp/artifacts/`

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

## Tools

- `start_trace`
- `record_step`
- `record_tool_result`
- `summarize_session`
- `compare_sessions`
- `export_pantheon_safe`
- `get_artifact`
- `get_measurement_report`

## Data Policy

- Local event traces are metadata-oriented.
- Raw prompts, raw code, file bodies, secrets, and long notes should not be sent to the MCP.
- Session summaries and local artifacts stay under `$HOME/.hwai/agent-trace-mcp`.
- Pantheon export is aggregate-only.
- Pantheon export excludes raw prompts, raw code, file paths, local log paths, event summaries, samples, and artifact URLs.

## Proof Loop

```bash
cd services/agent-trace-mcp
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/agent-trace-local-benchmark-2026-04-24.json
npm run benchmark:playwright -- --out=/tmp/hwai-playwright-agent-trace-proof-2026-04-24.json
node scripts/measurement-report.mjs --date=2026-04-24 --format=pantheon
```

## Benchmark Bar

- `tools/list` exposes all trace tools.
- A smoke session records start, step, tool result, summary, Pantheon export, and measurement report.
- `compare_sessions` returns aggregate-only deltas between two session rollups for autonomous-loop regression review.
- Pantheon export remains aggregate-only and does not include raw summaries.
- Golden benchmark has zero failures.
- Playwright bridge benchmark auto-generates a real local `trace.zip`, HAR, and screenshot fixture, records four `playwright-trace-mcp` tool results into one agent session, and verifies local agent-trace logs/Pantheon export do not include raw trace paths, raw URLs, or artifact URLs.

Current bridge proof:

- events: 7
- `playwright-trace-mcp` tool results: 4
- failure kind: action
- failure window: 2 nearby console errors, 1 nearby network failure
- screenshots prepared: 4
- saved-token estimate: about 12.5k for the generated fixture
- Pantheon-safe export: passed

## Current Role in HWAI Stack

Use this MCP when an autonomous loop or multi-MCP task needs attribution across steps:

- utility MCP proof loops
- daily learning automation
- long Codex/Claude/Cursor repo tasks
- Pantheon-safe usage rollups
- reducing `unknown` source labels in shared MCP measurement

Agents still use frontier reasoning for ambiguous, high-risk, architecture-heavy, security-sensitive, or final-output-sensitive work.
