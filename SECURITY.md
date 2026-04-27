# Security Policy

## Supported Versions

Use the latest tagged release when available. If you install from `main`, treat
it as a development channel and run the verification commands in
[`VERIFY_BEFORE_INSTALL.md`](./VERIFY_BEFORE_INSTALL.md) first.

## Reporting A Vulnerability

Please open a private GitHub security advisory if available, or contact the
maintainer without including secret values in a public issue. Include:

- affected version or commit SHA;
- the exact file and line when possible;
- reproduction steps;
- whether credentials, private URLs, local traces, screenshots, or raw prompts
  may have been exposed.

Do not commit credentials, private URLs, raw prompts, raw source-code excerpts
from private repositories, screenshots, lockfiles with sensitive registries, or
local MCP trace files.

External-context modules read bearer keys from `~/.hwai/mcp-stack/env` or the
process environment. Keep those files local and out of Git.

Before every public release, run:

```bash
bash scripts/agent-preinstall-check.sh
bash scripts/public-release-audit.sh
```

If a real secret was pushed, treat it as compromised: remove it from the repo,
rotate it at the source, and do not publish a release until the audit passes
again.

## Threat Model

Primary trust boundary: local installer and local MCP stdio wrappers.

Expected local writes are documented in
[`trust/hwai-mcp-stack.trust.json`](./trust/hwai-mcp-stack.trust.json). The
default `core` profile is local-first and does not require API keys. Optional
external-context MCPs may call user-configured web/search/crawl endpoints only
after the user provides endpoint URLs and bearer keys in local env.

Non-goals:

- proving every dependency is vulnerability-free;
- replacing source inspection with signatures;
- making external user-provided endpoints safe by default.

Release attestations, when present, prove artifact provenance. They do not prove
the code is safe; consumers still need policy checks, source inspection, and
dry-run verification.
