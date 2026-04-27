# Security Policy

Do not commit credentials, private URLs, raw prompts, raw source-code excerpts
from private repositories, screenshots, lockfiles with sensitive registries, or
local MCP trace files.

External-context modules read bearer keys from `~/.hwai/mcp-stack/env` or the
process environment. Keep those files local and out of Git.

Before every public release, run:

```bash
bash scripts/public-release-audit.sh
```

If a real secret was pushed, treat it as compromised: remove it from the repo,
rotate it at the source, and do not publish a release until the audit passes
again.
