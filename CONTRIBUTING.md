# Contributing

Thanks for helping improve Humanswith.ai MCP Stack.

This repository is public and installable, so every change should keep the
first-run path boring in the best way: one command, clear verification, no
private dependencies, no secrets.

## Before Opening A PR

Run:

```bash
bash scripts/agent-preinstall-check.sh
bash scripts/public-release-audit.sh
```

For MCP changes, also run the profile you touched:

```bash
node mcp/bin/hwai-mcp.mjs doctor \
  --manifest=mcp/manifest.json \
  --source-root=mcp/source \
  --profile=full
```

## Contribution Rules

- Keep the repo self-contained. Do not require access to private Humanswith.ai
  repos, private Notion pages, local traces, screenshots, or personal machine
  paths.
- Never commit API keys, bearer tokens, PATs, `.env` files, request logs,
  feedback logs, screenshot artifacts, HAR/trace archives, or raw private code
  snippets.
- Public prose should use `Humanswith.ai`. Keep `HWAI` only for technical
  identifiers such as `HWAI_*`, `@hwai/*`, `~/.hwai`, and repo/package names.
- If you add a module, update `mcp/manifest.json`, module docs, install/doctor
  coverage, and the README table.
- If you change install behavior, update the one-command install docs and prove
  the clean install or dry-run path.
- If you change trust posture, update `TRUST.md`, `VERIFY_BEFORE_INSTALL.md`,
  `trust/hwai-mcp-stack.trust.json`, and `scripts/agent-preinstall-check.sh`
  in the same PR.
- Keep public install examples inspect-first. Any `curl | bash` example must
  point to an inspectable repo script and should have a tagged-release variant.
- Keep the local project teaching layer on by default. Install changes must
  continue to write agent docs/rules and natural-language trigger vocabulary
  unless the user explicitly selects a config-only repair mode.

## Security

If you believe sensitive data was committed, do not open a public issue with the
secret value. Follow [SECURITY.md](./SECURITY.md).
