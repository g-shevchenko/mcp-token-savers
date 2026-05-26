# Context Handoff MCP

Local-first MCP for generic context pressure pre-scoring, operational handoffs,
and cross-agent resume state.

Most agentic IDEs have their own context summarization or compaction. This MCP
does not replace those features. It adds a small local control plane before the
compaction boundary:

- pre-score context pressure with deterministic thresholds;
- render a stable operational handoff template;
- store compact metadata-only events outside the prompt;
- let another agent resume from recent event summaries.

## Tools

- `ctx_pre_score`
- `ctx_record_event`
- `ctx_write_handoff`
- `ctx_resume`
- `ctx_stats`

## Local stdio

```bash
services/context-handoff-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/context-handoff-mcp
```

## Data policy

- Raw logs, prompts, source bodies, env files, and secrets are not required.
- `ctx_record_event` stores summaries and artifact paths, not raw bodies.
- `ctx_stats` returns aggregate counters only.
- This service has no network dependency and no API-key requirement.

## Proof loop

```bash
npm install
npm run build
npm run test
npm run smoke
npm run benchmark
npm run measurement:report
```
