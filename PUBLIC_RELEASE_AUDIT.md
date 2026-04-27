# Public Release Audit

Run this checklist before publishing or tagging a release.

Fast path:

```bash
bash scripts/public-release-audit.sh
```

## Required decisions

- [ ] Choose GitHub owner: `g-shevchenko` for personal OSS, or `humanswith-ai`
      for official company distribution.
- [ ] Choose a license. Recommended default for broad reuse: MIT. Use Apache-2.0
      if patent language matters.
- [ ] Confirm public prose uses `Humanswith.ai` as the brand. Keep `HWAI` only
      where it is a technical identifier, such as env vars, package scopes,
      paths, or the repository slug.
- [ ] Confirm the repository is self-contained and does not require access to
      private Humanswith.ai repos, private Notion pages, local machine paths, or
      internal infrastructure for the default install path.

## Required checks

```bash
npm --version
node --version
find . -name node_modules -o -name dist -o -name .env -o -name '*.jsonl' -o -name '*.log'
rg -n -i '(api[_-]?key|token|secret|password|bearer|authorization|telegram|notion|chat_id|CREDENTIALS|hwai-internal|greg-personal|r2[-_]?d2|railway|webhook)' .
node mcp/bin/hwai-mcp.mjs doctor --manifest=mcp/manifest.json --source-root=mcp/source --profile=core
bash mcp/install.sh --profile=core --clients=codex --workspace="$PWD" --skip-build --dry-run
bash mcp/install.sh --profile=core --clients=auto --workspace="$(mktemp -d)" --skip-build --dry-run
```

## Expected public posture

- The public repo contains no Git history from private repos.
- The default install profile is `core`.
- External-context modules require user-supplied endpoints and keys.
- Internal Notion, Telegram, Railway, private repo, team rollout, and personal
  repository references are absent or documented only as sanitized examples.
- `README.md`, `mcp/README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and the PR
  checklist agree on install, proof, and no-secret expectations.
- Any `curl | bash` install path has an inspectable script in the repo and a
  dry-run or doctor proof.
- One-command install updates local agent docs/rules by default, or documents
  `HWAI_MCP_AGENT_DOCS=skip` / `--agent-docs=skip`.
