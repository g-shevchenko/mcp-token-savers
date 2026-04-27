## Summary

-

## Proof

- [ ] `bash scripts/public-release-audit.sh`
- [ ] `node mcp/bin/hwai-mcp.mjs doctor --manifest=mcp/manifest.json --source-root=mcp/source --profile=full`
- [ ] Install/doctor docs updated if install behavior changed
- [ ] Agent-docs dry-run still shows local project guidance/rules are written by default

## Public Release Gate

- [ ] No API keys, bearer tokens, PATs, `.env`, request logs, feedback logs, screenshots, HAR/trace archives, or raw private code snippets
- [ ] No required dependency on private repos, private Notion pages, local machine paths, or Humanswith.ai internal infrastructure
- [ ] Public prose uses `Humanswith.ai`; `HWAI` remains only in technical identifiers
- [ ] New/changed modules are represented in manifest, docs, README tables, and doctor proof
- [ ] One-command install still teaches the local project by default; opt-out is config-only repair
