# HWAI Router Lite MCP

Local-first deterministic trigger/skip policy for **HWAI Context Router**.

`router-lite-mcp` is the lightweight routing engine for the Token Efficiency
Platform for Agentic IDEs. It decides whether a task should first call a
prep/evidence MCP such as `vision-mcp`, `context-prep-mcp`, `retrieval-mcp`,
`playwright-trace-mcp`, `static-analysis-mcp`, `dependency-risk-mcp`,
`docs-hygiene-mcp`, `repo-hygiene-mcp`, `repo-quality-gate-mcp`, or the scraper
stack. It does not answer user tasks, choose final models, edit files, deploy,
or replace frontier reasoning.

The first version is intentionally boring: deterministic rules only, benchmarked trigger/skip precision, local metadata-only traces, and `cheap_only_allowed=false` on every result.

## Tools

- `route_task`
- `classify_input`
- `needs_clarification`
- `get_measurement_report`

## Local stdio

```bash
services/router-lite-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/router-lite-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/router-lite-mcp/requests.jsonl
```

## Proof loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/router-lite-local-benchmark.json
npm run measurement:report -- --date=2026-04-27 --format=pantheon
```

## Data policy

- Raw prompts, URLs, code bodies, doc bodies, screenshots, traces, and local paths are not written to request logs.
- Pantheon exports are aggregate-only.
- The router may recommend a prep MCP, but agents still perform frontier reasoning for judgment-heavy work.
- High-risk, ambiguous, architecture-heavy, security-sensitive, or final-output-sensitive tasks are never routed to a cheap-only path.
