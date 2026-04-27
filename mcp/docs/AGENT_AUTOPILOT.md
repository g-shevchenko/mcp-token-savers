# Agent Autopilot Docs

The installer does two things:

1. Connects MCP servers to Claude Code, Codex, Cursor, and Windsurf.
2. Writes local project instructions that teach those agents when to use the
   stack from natural language.

This second step is enabled by default:

```bash
HWAI_MCP_PROFILE=full /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

To skip local docs/rules updates:

```bash
HWAI_MCP_AGENT_DOCS=skip /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

## Files Written To The User Workspace

| File | Purpose |
| --- | --- |
| `docs/humanswithai-mcp-stack.md` | Human-readable local guide and trigger vocabulary. |
| `AGENTS.md` | Codex/general agent managed block. |
| `CLAUDE.md` | Claude Code managed block. |
| `.cursor/rules/humanswithai-mcp-autopilot.mdc` | Cursor always-apply rule. |
| `.windsurf/rules/humanswithai-mcp-autopilot.md` | Windsurf always-on rule. |

Existing `AGENTS.md` and `CLAUDE.md` files are not replaced. The installer adds
or refreshes only the managed block between:

```text
<!-- BEGIN HUMANSWITHAI_MCP_AUTOPILOT -->
...
<!-- END HUMANSWITHAI_MCP_AUTOPILOT -->
```

## Natural Trigger Vocabulary

Users do not need to write MCP tool names. Agents should infer the right local
prep tool from phrases like:

| User wording, not commands | Agent should consider |
| --- | --- |
| "where is this implemented", "найди где живет", "что менять" | retrieval, language graph, repo history |
| "huge log", "CI output", "stack trace", "длинные логи" | context prep |
| "is this safe to merge", "quality gate", "перед PR проверь" | static analysis, quality gate |
| "repo is growing", "find stale docs", "мусор в репо" | repo/docs hygiene, docs sync |
| "API/schema changed", "contract drift", "dependency risk" | contract/schema and dependency risk |
| "Playwright trace", "trace.zip", "HAR" | Playwright trace and agent trace |
| "screenshot", "visual diff", "скриншот" | vision and visual baseline |
| "search web", "read this URL", "SERP", "crawl" | optional external-context MCPs when endpoints/keys are configured |

## Safety

MCPs reduce noisy context and token waste. They do not replace exact file reads
before edits or frontier reasoning for ambiguous, high-risk, architecture-heavy,
security-sensitive, or final-output-sensitive work.
