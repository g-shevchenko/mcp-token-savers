# MCP Bundle

This directory contains the installer, manifest, docs, and bundled source for
the 17-module local Humanswith.ai MCP Stack.

Product framing: this bundle is the local module layer for **HWAI Context
Router**, the technical core of a **Token Efficiency Platform for Agentic IDEs**.
The bundle should feel like one router-led workflow, not a menu of unrelated
servers.

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
| `core` | HWAI Context Router, retrieval, context prep, static analysis, repo history, quality gate. |
| `repo` | Core plus language graph, repo/docs hygiene, contracts, dependency risk, docs sync, golden datasets, agent trace. |
| `browser-debug` | Core plus Playwright trace, Vision prep, Visual Baseline, agent trace. |
| `full` | All local profiles. Use after `core` passes. |

## Local-Only Public Stack

The public `full` profile is local-only. It does not install scraper, SERP,
reader, or Crawl4AI wrappers, and it does not require API keys.

Generated MCP configs still point at local stdio wrappers and keep raw repo
evidence on the user's machine.

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

The intended autopilot path is:

1. classify whether prep/evidence tools are useful;
2. call the smallest relevant MCP;
3. return compact evidence and a prompt scaffold;
4. keep frontier reasoning responsible for final judgment;
5. keep raw private evidence out of the frontier prompt unless the user and task
   actually require exact source inspection.
