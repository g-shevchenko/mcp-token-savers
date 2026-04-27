# MCP Bundle

This directory contains the installer, manifest, docs, and bundled source for
the 21-module Humanswith.ai MCP Stack.

Use the repository-level `install.sh` for one-command public installs. Use this
directory directly only when you already have a local clone:

```bash
~/.hwai/hwai-mcp-stack/mcp/install.sh --profile=core --clients=auto
```

By default the installer also teaches the target workspace how to use the stack:
`docs/humanswithai-mcp-stack.md`, managed blocks in `AGENTS.md` and
`CLAUDE.md`, and Cursor/Windsurf rules when those clients are selected. This
default is part of the product for beginner users, not an optional add-on.

Skip that layer only when you intentionally want config-only repair without
local agent instructions:

```bash
~/.hwai/hwai-mcp-stack/mcp/install.sh --profile=core --clients=auto --agent-docs=skip
```

## Profiles

| Profile | Purpose |
| --- | --- |
| `core` | Router, retrieval, context prep, static analysis, repo history, quality gate. |
| `repo` | Core plus language graph, repo/docs hygiene, contracts, dependency risk, docs sync, golden datasets, agent trace. |
| `browser-debug` | Core plus Playwright trace, Vision prep, Visual Baseline, agent trace. |
| `external-context` | Scraper, SERP, reader, and Crawl4AI wrappers over user-supplied endpoints. |
| `full` | All profiles. Use after `core` passes. |

## Optional External Context

The installer creates `~/.hwai/mcp-stack/env` when missing. Fill per-user
endpoint URLs and bearer keys there if you use `external-context` or `full`:

```bash
HWAI_SCRAPER_URL=http://localhost:8090
HWAI_SCRAPER_KEY=
HWAI_CRAWL4AI_URL=http://localhost:11235
HWAI_CRAWL4AI_TOKEN=
```

Never commit that file. Generated MCP configs only point wrappers at the local
env file.

## Doctor

```bash
~/.hwai/hwai-mcp-stack/mcp/bin/hwai-mcp.mjs doctor \
  --manifest=~/.hwai/hwai-mcp-stack/mcp/manifest.json \
  --source-root=~/.hwai/hwai-mcp-stack/mcp/source \
  --profile=core
```

Doctor checks service folders, `package.json`, build scripts, and executable
stdio wrappers. It does not read request logs, feedback logs, screenshots,
traces, env files, credentials, Notion bodies, or raw code bodies.

## Agent Autopilot

See [Agent Autopilot Docs](./docs/AGENT_AUTOPILOT.md) for the natural-language
trigger vocabulary that the installer places into local project docs/rules.
