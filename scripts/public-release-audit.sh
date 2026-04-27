#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FAILED=0

section() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  FAILED=1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required executable: $1"
  fi
}

section "Prerequisites"
require_bin git
require_bin rg
require_bin node
require_bin bash

section "Git status"
git status --short --branch

section "Whitespace"
if git diff --check; then
  pass "git diff --check"
else
  fail "git diff --check"
fi

section "Trust verification surface"
for required in TRUST.md VERIFY_BEFORE_INSTALL.md trust/hwai-mcp-stack.trust.json scripts/agent-preinstall-check.sh; do
  if [[ -f "$required" ]]; then
    pass "present: $required"
  else
    fail "missing trust verification file: $required"
  fi
done
if [[ -f trust/hwai-mcp-stack.trust.json ]]; then
  if node -e 'const t=require("./trust/hwai-mcp-stack.trust.json"); if (t.default_profile !== "core" || t.requires_sudo !== false) process.exit(1);'; then
    pass "trust manifest core/no-sudo policy"
  else
    fail "trust manifest core/no-sudo policy"
  fi
fi

section "Generated/local artifacts"
artifact_hits="$(
  find . \
    \( -path './.git' -o -path './node_modules' -o -path '*/node_modules' \) -prune -o \
    \( -name '.env' -o -name '*.jsonl' -o -name '*.log' -o -name '*.har' -o -name '*.trace' -o -name 'trace.zip' -o -name '*.zip' \) \
    -print
)"
if [[ -n "$artifact_hits" ]]; then
  printf '%s\n' "$artifact_hits"
  fail "Generated/local artifacts found"
else
  pass "No generated/local artifacts found"
fi

section "Token-shaped secret scan"
if rg -n -i \
  '(github_pat_|gh[pousr]_[A-Za-z0-9_]{20,}|x-access-token|authorization:\s*bearer\s+[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|ya29\.|xox[baprs]-)' \
  --glob '!scripts/public-release-audit.sh' \
  --glob '!scripts/agent-preinstall-check.sh' \
  --glob '!PUBLIC_RELEASE_AUDIT.md' \
  --glob '!SECURITY.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!TRUST.md' \
  --glob '!VERIFY_BEFORE_INSTALL.md' \
  --glob '!trust/hwai-mcp-stack.trust.json' \
  --glob '!.github/pull_request_template.md' \
  .; then
  fail "Token-shaped values found"
else
  pass "No token-shaped values found"
fi

section "Private/internal reference scan"
private_scan_globs=(
  --glob '!PUBLIC_RELEASE_AUDIT.md'
  --glob '!SECURITY.md'
  --glob '!CONTRIBUTING.md'
  --glob '!TRUST.md'
  --glob '!VERIFY_BEFORE_INSTALL.md'
  --glob '!trust/hwai-mcp-stack.trust.json'
  --glob '!scripts/public-release-audit.sh'
  --glob '!scripts/agent-preinstall-check.sh'
  --glob '!.github/pull_request_template.md'
)
if rg -n -i \
  '(greg-personal-claude|humanswith-ai/hwai-internal|token_v2|telegram_chat_id|172\.245\.72\.102|r2[-_ ]?d2|private notion)' \
  "${private_scan_globs[@]}" \
  .; then
  fail "Private/internal references found outside allowed audit docs"
else
  pass "No private/internal references found outside allowed audit docs"
fi

section "Public brand wording"
if rg -n 'HWAI MCP Stack|HWAI stack' README.md mcp/README.md 2>/dev/null; then
  fail "Public prose should prefer Humanswith.ai; keep HWAI only for technical identifiers"
else
  pass "Public prose brand check"
fi

section "Inspect-first install docs"
if rg -n 'scripts/agent-preinstall-check\.sh|VERIFY_BEFORE_INSTALL|TRUST\.md|trust/hwai-mcp-stack\.trust\.json' README.md TRUST.md VERIFY_BEFORE_INSTALL.md >/tmp/hwai-mcp-public-audit-trust-docs.txt; then
  cat /tmp/hwai-mcp-public-audit-trust-docs.txt
  pass "Inspect-first verification docs"
else
  fail "Inspect-first verification docs"
fi

section "MCP doctor"
if [[ -f mcp/bin/hwai-mcp.mjs && -f mcp/manifest.json && -d mcp/source ]]; then
  if node mcp/bin/hwai-mcp.mjs doctor --manifest=mcp/manifest.json --source-root=mcp/source --profile=core >/tmp/hwai-mcp-public-audit-doctor.json; then
    cat /tmp/hwai-mcp-public-audit-doctor.json
    pass "Core doctor"
  else
    cat /tmp/hwai-mcp-public-audit-doctor.json 2>/dev/null || true
    fail "Core doctor"
  fi
else
  pass "MCP doctor skipped; MCP bundle not present"
fi

section "Install dry-run"
if [[ -f mcp/install.sh ]]; then
  if bash mcp/install.sh --profile=core --clients=codex --workspace="$PWD" --skip-build --dry-run; then
    pass "Install dry-run"
  else
    fail "Install dry-run"
  fi
  tmp_workspace="$(mktemp -d)"
  agent_docs_output="$(mktemp)"
  if bash mcp/install.sh --profile=core --clients=auto --workspace="$tmp_workspace" --skip-build --dry-run | tee "$agent_docs_output"; then
    missing_agent_docs=0
    for expected in \
      "$tmp_workspace/docs/humanswithai-mcp-stack.md" \
      "$tmp_workspace/AGENTS.md" \
      "$tmp_workspace/CLAUDE.md" \
      "$tmp_workspace/.cursor/rules/humanswithai-mcp-autopilot.mdc" \
      "$tmp_workspace/.windsurf/rules/humanswithai-mcp-autopilot.md"; do
      if ! grep -F "$expected" "$agent_docs_output" >/dev/null; then
        printf 'missing expected agent-docs target in dry-run: %s\n' "$expected" >&2
        missing_agent_docs=1
      fi
    done
    if [[ "$missing_agent_docs" == "0" ]]; then
      pass "Install dry-run with agent docs"
    else
      fail "Install dry-run with agent docs"
    fi
  else
    fail "Install dry-run with agent docs"
  fi
  rm -f "$agent_docs_output"
  rm -rf "$tmp_workspace"
else
  pass "Install dry-run skipped; mcp/install.sh not present"
fi

if [[ "$FAILED" == "0" ]]; then
  section "Result"
  pass "Public release audit passed"
else
  section "Result"
  fail "Public release audit failed"
  exit 1
fi
