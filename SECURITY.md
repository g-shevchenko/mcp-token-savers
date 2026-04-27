# Security Policy

Do not commit credentials, private URLs, raw prompts, raw source-code excerpts
from private repositories, screenshots, lockfiles with sensitive registries, or
local MCP trace files.

External-context modules read bearer keys from `~/.hwai/mcp-stack/env` or the
process environment. Keep those files local and out of Git.

Before every public release, run the checks in `PUBLIC_RELEASE_AUDIT.md`.
