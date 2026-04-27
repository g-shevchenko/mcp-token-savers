# HWAI MCP Stack

Local-first MCP bundle for agentic IDEs and coding agents.

The stack installs MCP servers for Claude Code, Codex, Cursor, and Windsurf so
agents can gather smaller, more targeted context before using frontier model
tokens. The default profile is local-only. External web/search/crawl adapters
are optional and require your own service URLs and bearer keys.

## Modules

This public-prep bundle contains 21 MCP modules:

- Router and trigger policy: `router-lite-mcp`
- Repo context and retrieval: `retrieval-mcp`, `context-prep-mcp`
- Repo intelligence: `static-analysis-mcp`, `repo-history-mcp`, `language-graph-mcp`
- Quality and hygiene: `repo-quality-gate-mcp`, `repo-hygiene-mcp`, `docs-hygiene-mcp`, `docs-sync-mcp`
- Contracts and dependency risk: `contract-schema-mcp`, `dependency-risk-mcp`
- Benchmarking and traces: `golden-dataset-mcp`, `agent-trace-mcp`, `playwright-trace-mcp`
- Visual workflows: `vision-mcp`, `visual-baseline-mcp`
- Optional external context: `scraper-mcp`, `searxng-mcp`, `reader-mcp`, `crawl4ai-mcp`

## One-command install

After this repo is published, the intended public install command is:

```bash
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

Useful options:

```bash
HWAI_MCP_PROFILE=core /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
HWAI_MCP_PROFILE=full HWAI_MCP_CLIENTS=codex,cursor /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

The installer clones or updates the bundle under `~/.hwai/hwai-mcp-stack`,
builds selected modules, writes client MCP configs, and runs `doctor`.

Restart the target client or open a new chat after install so stdio MCP configs
reload.

## Privacy model

- Local repo/file evidence stays local by default.
- Durable traces live under `~/.hwai/<service-name>`.
- Aggregate measurement reports should not export raw code, prompts, URLs,
  screenshots, lockfiles, env files, or private docs.
- External-context modules are disabled in practice until you provide your own
  endpoint URLs and bearer keys in `~/.hwai/mcp-stack/env`.

## Public release status

This folder is a sanitized public-prep snapshot, not yet the canonical public
repo. Before publishing, choose the GitHub owner and license, then rerun the
release audit in `PUBLIC_RELEASE_AUDIT.md`.
