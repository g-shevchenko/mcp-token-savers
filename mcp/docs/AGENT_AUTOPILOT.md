# Agent Autopilot Docs

The installed product experience is **HWAI Context Router**, the local technical
core of a **Token Efficiency Platform for Agentic IDEs**.

The installer does two things:

1. Connects MCP servers to Claude Code, Codex, Cursor, and Windsurf.
2. Writes local project instructions that teach those agents when to use HWAI
   Context Router from natural language.

This second step is enabled by default and is part of the release contract. It
is especially important for beginner users: they should describe the task in
plain language, not memorize MCP tool names.

```bash
HWAI_MCP_PROFILE=full /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

`full` means all 17 local token-efficiency MCPs. It does not install external
web/search/crawl wrappers.

To skip local docs/rules updates only for config-only repair:

```bash
HWAI_MCP_AGENT_DOCS=skip /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"
```

## Files Written To The User Workspace

| File | Purpose |
| --- | --- |
| `docs/humanswithai-mcp-stack.md` | Human-readable HWAI Context Router guide and trigger vocabulary. |
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
prep route from phrases like:

| User wording, not commands | Agent should consider |
| --- | --- |
| "where is this implemented", "найди где живет", "что менять" | retrieval, language graph, repo history |
| "huge log", "CI output", "stack trace", "длинные логи" | context prep |
| "compress this context", "сожми контекст", "preserve evidence" | context prep compression |
| "is this safe to merge", "quality gate", "перед PR проверь" | static analysis, quality gate |
| "repo is growing", "find stale docs", "мусор в репо" | repo/docs hygiene, docs sync |
| "release blocker", "missing LICENSE", "generated dist committed" | repo hygiene, quality gate |
| "API/schema changed", "contract drift", "dependency risk" | contract/schema and dependency risk |
| "Playwright trace", "trace.zip", "HAR" | Playwright trace and agent trace |
| "screenshot", "visual diff", "скриншот", "screenshot CDN URL" | vision and visual baseline |

## Known Operational Guardrails

- Vision-MCP keeps customer- or team-specific screenshot CDNs out of product
  defaults. Configure allowed image hosts locally with `VISION_ALLOWED_HOSTS`.
- If an installed agent rejects a newly configured screenshot host, run
  `npm run smoke` in `mcp/source/services/vision-mcp` and restart the Claude
  Code, Codex, Cursor, or Windsurf session so the stdio MCP reloads.
- Avoid `ALLOW_ANY_IMAGE_URL=1` except for trusted local debugging.

## Safety

HWAI Context Router reduces noisy local context and token waste. It does not
replace exact file reads before edits or frontier reasoning for ambiguous,
high-risk, architecture-heavy, security-sensitive, or final-output-sensitive
work.
