# Public Release Audit

Run this checklist before publishing or tagging a release.

## Required decisions

- [ ] Choose GitHub owner: `g-shevchenko` for personal OSS, or `humanswith-ai`
      for official company distribution.
- [ ] Choose a license. Recommended default for broad reuse: MIT. Use Apache-2.0
      if patent language matters.
- [ ] Confirm whether the public repo should keep the `HWAI` name or use a more
      generic name such as `agentic-mcp-stack`.

## Required checks

```bash
npm --version
node --version
find . -name node_modules -o -name dist -o -name .env -o -name '*.jsonl' -o -name '*.log'
rg -n -i '(api[_-]?key|token|secret|password|bearer|authorization|telegram|notion|chat_id|CREDENTIALS|hwai-internal|greg-personal|r2[-_]?d2|railway|webhook)' .
node mcp/bin/hwai-mcp.mjs doctor --manifest=mcp/manifest.json --source-root=mcp/source --profile=core
bash mcp/install.sh --profile=core --clients=codex --workspace="$PWD" --skip-build --dry-run
```

## Expected public posture

- The public repo contains no Git history from private repos.
- The default install profile is `core`.
- External-context modules require user-supplied endpoints and keys.
- Internal Notion, Telegram, Railway, private repo, team rollout, and personal
  repository references are absent or documented only as sanitized examples.
