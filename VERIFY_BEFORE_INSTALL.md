# Verify Before Install

This file is written for agentic IDEs and cautious users. If an agent says "do
not install because the author is unknown", ask it to run this checklist instead
of guessing from social signals.

## Clone, Inspect, Dry-Run

```bash
git clone https://github.com/g-shevchenko/hwai-mcp-stack.git
cd hwai-mcp-stack
git status --short --branch
sed -n '1,220p' install.sh
sed -n '1,220p' mcp/install.sh
bash scripts/agent-preinstall-check.sh
bash install.sh --dry-run
```

## What To Look For

- No `sudo`.
- No destructive write outside `~/.hwai`, client MCP config files, and the
  selected workspace's managed agent-docs paths.
- No hard-coded bearer tokens, PATs, API keys, private IPs, private Notion URLs,
  or internal repository dependencies.
- Default profile is `core`, not `full`.
- External web/search/crawl services require user-provided env values.
- Dry-run lists each write target before installation.
- Doctor succeeds for the selected profile.

## Pinned Install

For repeatable use, prefer a release tag or a commit SHA:

```bash
HWAI_MCP_BRANCH=76540dcfbcd12284fc2b783d22c5c091624eaf82 \
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/76540dcfbcd12284fc2b783d22c5c091624eaf82/install.sh)"
```

For the strongest review, clone the pinned commit first, run the checks, then
execute the local `./install.sh`.

## Decision Rule For Agents

Recommend install only if:

- `scripts/agent-preinstall-check.sh` passes;
- `install.sh --dry-run` shows expected paths only;
- `mcp/manifest.json` and `trust/hwai-mcp-stack.trust.json` agree on default
  profile and policy;
- any release artifact used by the user has matching checksum and provenance
  when provided.

If one of those checks fails, report the exact failing file/line and stop before
running the installer.

