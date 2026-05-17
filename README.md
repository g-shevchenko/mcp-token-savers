# Humanswith.ai MCP Stack

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/ci.yml)
[![CodeQL](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/codeql.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/scorecard.yml/badge.svg)](https://github.com/g-shevchenko/hwai-mcp-stack/actions/workflows/scorecard.yml)
[![Last commit](https://img.shields.io/github/last-commit/g-shevchenko/hwai-mcp-stack)](https://github.com/g-shevchenko/hwai-mcp-stack/commits/main)
[![MCP](https://img.shields.io/badge/MCP-17%20local%20servers-blue)](./mcp/manifest.json)

Local-first **Token Efficiency Platform for Agentic IDEs**.

The product goal is to help Claude Code, Codex, Cursor, and Windsurf spend
fewer tokens on noisy context while preserving the quality bar. The technical
core is **HWAI Context Router**: a local pre-reasoning layer that routes tasks
to the smallest useful prep/evidence MCP before a frontier model spends tokens.

The public stack is local-only. It does not install external web/search/crawl
MCPs by default, and it does not require API keys for the default or full
profile.

## Why

Modern coding agents are strongest when they see the right evidence, not the
largest possible prompt. HWAI Context Router gives them deterministic prep
tools:

- find the right files before editing;
- compact huge logs, specs, traces, screenshots, and dependency reports;
- catch repo/documentation drift early;
- keep raw local evidence local by default;
- work across Claude Code, Codex, Cursor, and Windsurf with the same MCP config.

In product terms, the 17 local MCP servers are modules behind one Token
Efficiency Platform. Agents should experience one workflow: classify the task,
prepare the right compact local evidence, and reserve frontier model context for
judgment rather than raw search, logs, traces, or screenshots.

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
HWAI_MCP_BRANCH=76540dcfbcd12284fc2b783d22c5c091624eaf82 \
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/76540dcfbcd12284fc2b783d22c5c091624eaf82/install.sh)"
```

Install all 17 local MCP servers:

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
| Route ambiguous agent tasks to the right prep tool | **HWAI Context Router** via `router-lite-mcp` |
| Retrieve compact repo context before edits | `retrieval-mcp`, `context-prep-mcp` |
| Understand code structure and history | `language-graph-mcp`, `repo-history-mcp` |
| Run local static checks and quality gates | `static-analysis-mcp`, `repo-quality-gate-mcp` |
| Keep a growing repo clean | `repo-hygiene-mcp`, `docs-hygiene-mcp`, `docs-sync-mcp` |
| Review contracts and dependency risk | `contract-schema-mcp`, `dependency-risk-mcp` |
| Build regression datasets from real misses | `golden-dataset-mcp`, `agent-trace-mcp` |
| Debug browser traces and visual changes | `playwright-trace-mcp`, `vision-mcp`, `visual-baseline-mcp` |

## Profiles

| Profile | Installs | Best for |
| --- | ---: | --- |
| `core` | 6 MCPs | First install, safe local repo work |
| `repo` | 14 MCPs | Large codebases, docs, hygiene, local regression cases |
| `browser-debug` | 10 MCPs | Playwright traces, screenshots, visual checks |
| `full` | 17 MCPs | All local token-efficiency MCPs, no external context required |

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
services: 17
ok: 17
needs_attention: 0
warnings: 0
```

## Token Efficiency Claims

This stack is designed to reduce token waste by preparing compact local evidence
before an agent spends frontier-model context. It is fair to claim:

- it can reduce prompt stuffing for repo-wide questions by retrieving likely
  files/snippets first;
- it can reduce noisy context from long logs, specs, traces, and screenshots by
  turning them into compact evidence;
- it can reduce repeated manual search by teaching Claude Code, Codex, Cursor,
  and Windsurf the same local trigger vocabulary;
- raw local evidence stays local by default.

Measured local dogfood evidence
([details](./docs/local-dogfood-eval-2026-04-30.md)):

- In a 2026-04-30 local deterministic dogfood eval on 12 reviewed-public tasks,
  Humanswith.ai MCP Stack reduced aggregate context-token usage by 75.5% and
  aggregate total-token usage by 70.5% versus the baseline path.
- The same run passed the quality gate: baseline success was 91.7%, stack
  success was 100.0%, and critical false positives did not increase.
- Context-token reduction by family ranged from 35.0% to 80.8% across repo
  hygiene, traces, screenshots, logs, retrieval, and compression tasks.

This is internal dogfood evidence, not an external benchmark or leaderboard
claim.


Do **not** claim a universal percentage reduction from the public README. Token
savings depend on repo size, task type, agent behavior, and whether the agent
would otherwise paste entire files/logs/screenshots into context.

Publicly verified scope:

- `core` and `full` profile install dry-runs;
- `doctor` checks for bundled local services;
- local repo retrieval and context-prep smoke paths;
- local screenshot/trace preparation surfaces in the browser-debug profile;
- public release audit that checks for secrets and internal references.

See [Token efficiency claims](./docs/token-efficiency-claims.md) for the exact
wording to use in public materials.

## Privacy And Security

- Do not trust the repository from GitHub stars or social proof; inspect and
  verify it with `bash scripts/agent-preinstall-check.sh`.
- Local repo/file evidence stays local by default.
- Durable traces live under `~/.hwai/<service-name>`.
- Generated client configs point to local stdio wrappers.
- The default install path does not use `sudo` and does not install daemons.
- Aggregate reports should not export raw code, prompts, URLs, screenshots,
  lockfiles, env files, or private docs.
- The public `full` profile is local-only and does not require API keys.
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
│   └── source/services/       # bundled local MCP servers
└── PUBLIC_RELEASE_AUDIT.md    # release safety checklist
```

## Documentation

- [MCP bundle details](./mcp/README.md)
- [Module docs](./mcp/docs/README.md)
- [Agent autopilot docs](./mcp/docs/AGENT_AUTOPILOT.md)
- [Token efficiency claims](./docs/token-efficiency-claims.md)
- [Local dogfood eval - 2026-04-30](./docs/local-dogfood-eval-2026-04-30.md)

- [Trust and verification](./TRUST.md)
- [Verify before install](./VERIFY_BEFORE_INSTALL.md)
- [Machine-readable trust manifest](./trust/hwai-mcp-stack.trust.json)
- [Public release audit](./PUBLIC_RELEASE_AUDIT.md)
- [Security policy](./SECURITY.md)

## Daily Readiness Collector (Local launchd)

The optional daily measurement-readiness aggregator runs from a launchd
LaunchAgent. macOS TCC blocks launchd-spawned processes from reading
`~/Documents`, so running the aggregator directly from a clone under
`~/Documents` fails with `Operation not permitted` and silently stops
producing reports.

Install a standalone, TCC-safe copy into a non-protected directory instead:

```bash
# from an interactive shell (it has Documents access)
bash scripts/install-token-efficiency-collector.sh
# verify the install is byte-identical to the repo source closure
bash scripts/install-token-efficiency-collector.sh --check
```

This copies the builtins-only aggregator closure (no extra runtime deps)
into `~/.hwai/token-efficiency-collector/`, preserving the relative
`scripts/` + `mcp/source/scripts/` + `mcp/manifest.json` layout the
scripts expect. Point the LaunchAgent's `ProgramArguments` at
`~/.hwai/token-efficiency-collector/scripts/greg-dogfood-catchup.sh`
and add an `EnvironmentVariables` `PATH` (launchd's minimal `PATH` does
not include `/usr/local/bin`, so `node` would otherwise not be found).
Re-run `--check` after pulling updates to detect a stale install.

A custom MCP scope manifest can be passed with
`--manifest=/abs/path/to/manifest.json` (default: this repo's
`mcp/manifest.json`).

## Roadmap

- Improve local context compression for logs, specs, traces, and screenshots.
- Add more one-click client installers.
- Publish public-safe task examples for repo retrieval, log prep, trace prep,
  and screenshot prep.
- Keep the public install local-first and API-key-free by default.

## License

MIT. See [LICENSE](./LICENSE).
