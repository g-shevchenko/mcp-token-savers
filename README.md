# Humanswith.ai MCP Stack

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/g-shevchenko/hwai-mcp-stack?style=social)](https://github.com/g-shevchenko/hwai-mcp-stack/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/g-shevchenko/hwai-mcp-stack)](https://github.com/g-shevchenko/hwai-mcp-stack/commits/main)
[![MCP](https://img.shields.io/badge/MCP-21%20servers-blue)](./mcp/manifest.json)

Local-first MCP servers for Claude Code, Codex, Cursor, and Windsurf.

Give coding agents compact repo context, logs, traces, screenshots, quality
checks, dependency risk, and documentation hygiene before they spend frontier
model tokens. The default install is local-only. External web/search/crawl
adapters are optional and require your own endpoints and bearer keys.

## Why

Modern coding agents are strongest when they see the right evidence, not the
largest possible prompt. Humanswith.ai MCP Stack gives them deterministic prep tools:

- find the right files before editing;
- compact huge logs, specs, traces, screenshots, and dependency reports;
- catch repo/documentation drift early;
- keep raw local evidence local by default;
- work across Claude Code, Codex, Cursor, and Windsurf with the same MCP config.

## 60-Second Install

Safe local-first install:

```bash
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

Install all 21 MCP servers:

```bash
HWAI_MCP_PROFILE=full /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

Install only for selected clients:

```bash
HWAI_MCP_PROFILE=full HWAI_MCP_CLIENTS=codex,cursor /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

Requirements: macOS/Linux shell, `git`, Node.js, and `npm`.

After installation, restart Claude Code, Codex, Cursor, or Windsurf, or open a
new chat so stdio MCP configs reload.

## What You Get

| Need | MCPs |
| --- | --- |
| Route ambiguous agent tasks to the right prep tool | `router-lite-mcp` |
| Retrieve compact repo context before edits | `retrieval-mcp`, `context-prep-mcp` |
| Understand code structure and history | `language-graph-mcp`, `repo-history-mcp` |
| Run local static checks and quality gates | `static-analysis-mcp`, `repo-quality-gate-mcp` |
| Keep a growing repo clean | `repo-hygiene-mcp`, `docs-hygiene-mcp`, `docs-sync-mcp` |
| Review contracts and dependency risk | `contract-schema-mcp`, `dependency-risk-mcp` |
| Build regression datasets from real misses | `golden-dataset-mcp`, `agent-trace-mcp` |
| Debug browser traces and visual changes | `playwright-trace-mcp`, `vision-mcp`, `visual-baseline-mcp` |
| Add optional external context | `scraper-mcp`, `searxng-mcp`, `reader-mcp`, `crawl4ai-mcp` |

## Profiles

| Profile | Installs | Best for |
| --- | ---: | --- |
| `core` | 6 MCPs | First install, safe local repo work |
| `repo` | 14 MCPs | Large codebases, docs, hygiene, benchmarks |
| `browser-debug` | 10 MCPs | Playwright traces, screenshots, visual checks |
| `external-context` | 4 MCPs | Web/search/crawl wrappers over your own services |
| `full` | 21 MCPs | Power users who want the whole stack |

## Verification

The installer runs `doctor` automatically. You can rerun it anytime:

```bash
~/.hwai/hwai-mcp-stack/mcp/bin/hwai-mcp.mjs doctor \
  --manifest=~/.hwai/hwai-mcp-stack/mcp/manifest.json \
  --source-root=~/.hwai/hwai-mcp-stack/mcp/source \
  --profile=full
```

Expected result for the full profile:

```text
services: 21
ok: 21
needs_attention: 0
warnings: 0
```

## Privacy And Security

- Local repo/file evidence stays local by default.
- Durable traces live under `~/.hwai/<service-name>`.
- Generated client configs point to local stdio wrappers.
- Aggregate reports should not export raw code, prompts, URLs, screenshots,
  lockfiles, env files, or private docs.
- External-context MCPs do not work until you provide your own endpoint URLs and
  bearer keys in `~/.hwai/mcp-stack/env`.
- Never commit `~/.hwai/mcp-stack/env` or generated request logs.

## Repository Layout

```text
.
├── install.sh                 # one-command public installer
├── mcp/
│   ├── manifest.json          # profiles and server catalog
│   ├── install.sh             # local bundle installer
│   ├── bin/hwai-mcp.mjs       # install/doctor CLI
│   ├── docs/                  # module docs
│   └── source/services/       # 21 bundled MCP servers
└── PUBLIC_RELEASE_AUDIT.md    # release safety checklist
```

## Documentation

- [MCP bundle details](./mcp/README.md)
- [Module docs](./mcp/docs/README.md)
- [Public release audit](./PUBLIC_RELEASE_AUDIT.md)
- [Security policy](./SECURITY.md)

## Roadmap

- Better module-by-module token-savings reports.
- More one-click client installers.
- Public example fixtures for screenshots, traces, logs, and repo hygiene.
- Optional hosted external-context templates that do not require Humanswith.ai internal
  infrastructure.

## License

MIT. See [LICENSE](./LICENSE).
