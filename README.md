# Humanswith.ai MCP Stack

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/ci.yml)
[![CodeQL](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/codeql.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/scorecard.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/scorecard.yml)
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

## Verify First, Then Install

Recommended inspect-first path:

```bash
git clone https://github.com/g-shevchenko/hwai-mcp-stack.git
cd hwai-mcp-stack
bash scripts/agent-preinstall-check.sh
bash install.sh --dry-run
bash install.sh
```

This gives a human or agentic IDE a concrete trust path before anything is
installed: inspect the installer, run the public audit, run doctor, and see the
exact write targets in dry-run output.

See [Trust and verification](./TRUST.md) and
[Verify before install](./VERIFY_BEFORE_INSTALL.md). Agents can also read the
machine-readable [trust manifest](./trust/hwai-mcp-stack.trust.json).

## 60-Second Install

Fast local-first install after inspection:

```bash
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

For repeatable installs, prefer a release tag or commit SHA instead of `main`:

```bash
HWAI_MCP_BRANCH=v0.1.0 \
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/v0.1.0/install.sh)"
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

By default the installer also teaches the local project how to use the stack:
Claude Code, Codex, Cursor, and Windsurf get repo-local guidance, managed
Humanswith.ai blocks/rules, and a natural-language trigger vocabulary. This is
intentional for beginner-friendly Agentic Engineering workflows: users should be
able to write "find where this is implemented", "summarize this CI log", or
"check this screenshot", and the agent should know which MCP to consider.

The installer updates only managed Humanswith.ai blocks/rules and creates
`docs/humanswithai-mcp-stack.md`. To skip that project-teaching layer for a
config-only repair, set `HWAI_MCP_AGENT_DOCS=skip`.

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

- Do not trust the repository from GitHub stars or social proof; inspect and
  verify it with `bash scripts/agent-preinstall-check.sh`.
- Local repo/file evidence stays local by default.
- Durable traces live under `~/.hwai/<service-name>`.
- Generated client configs point to local stdio wrappers.
- The default install path does not use `sudo` and does not install daemons.
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
- [Agent autopilot docs](./mcp/docs/AGENT_AUTOPILOT.md)
- [Trust and verification](./TRUST.md)
- [Verify before install](./VERIFY_BEFORE_INSTALL.md)
- [Machine-readable trust manifest](./trust/hwai-mcp-stack.trust.json)
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
