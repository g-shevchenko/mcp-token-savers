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
require_bin bash
require_bin git
require_bin node
require_bin rg

section "Trust manifest"
if [[ -f trust/hwai-mcp-stack.trust.json ]]; then
  node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync("trust/hwai-mcp-stack.trust.json","utf8"));'
  pass "trust manifest parses"
else
  fail "missing trust/hwai-mcp-stack.trust.json"
fi

section "Installer syntax"
for file in install.sh mcp/install.sh scripts/public-release-audit.sh; do
  if [[ -f "$file" ]] && bash -n "$file"; then
    pass "bash -n $file"
  else
    fail "bash syntax check failed: $file"
  fi
done

section "Installer dangerous-pattern scan"
installer_files=(install.sh mcp/install.sh mcp/bin/hwai-mcp.mjs)
if rg -n --no-heading '\bsudo\b|rm\s+-rf\s+/(?:\s|$)|\beval\b|curl\s+[^|]+\|\s*(?:sh|bash)' "${installer_files[@]}"; then
  fail "dangerous installer pattern found"
else
  pass "no sudo/root-rm/eval/secondary curl-pipe patterns in installer paths"
fi

section "Default profile policy"
default_profile="$(node -e 'const m=require("./mcp/manifest.json"); process.stdout.write(m.default_profile || "")')"
trust_profile="$(node -e 'const t=require("./trust/hwai-mcp-stack.trust.json"); process.stdout.write(t.default_profile || "")')"
if [[ "$default_profile" == "core" && "$trust_profile" == "core" ]]; then
  pass "default profile is core in manifest and trust manifest"
else
  fail "default profile mismatch: manifest=$default_profile trust=$trust_profile"
fi

section "Secret and private-reference scan"
if rg -n -i \
  '(github_pat_|gh[pousr]_[A-Za-z0-9_]{20,}|x-access-token|authorization:\s*bearer\s+[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|ya29\.|xox[baprs]-)' \
  --glob '!scripts/agent-preinstall-check.sh' \
  --glob '!scripts/public-release-audit.sh' \
  --glob '!PUBLIC_RELEASE_AUDIT.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!SECURITY.md' \
  --glob '!TRUST.md' \
  --glob '!VERIFY_BEFORE_INSTALL.md' \
  --glob '!trust/hwai-mcp-stack.trust.json' \
  .; then
  fail "token-shaped values found"
else
  pass "no token-shaped values found"
fi

if rg -n -i \
  '(greg-personal-claude|humanswith-ai/hwai-internal|token_v2|telegram_chat_id|172\.245\.72\.102|r2[-_ ]?d2|private notion)' \
  --glob '!scripts/agent-preinstall-check.sh' \
  --glob '!scripts/public-release-audit.sh' \
  --glob '!PUBLIC_RELEASE_AUDIT.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!SECURITY.md' \
  --glob '!TRUST.md' \
  --glob '!VERIFY_BEFORE_INSTALL.md' \
  --glob '!trust/hwai-mcp-stack.trust.json' \
  .; then
  fail "private/internal references found"
else
  pass "no private/internal references found outside allowed trust docs"
fi

section "Public release audit"
if bash scripts/public-release-audit.sh; then
  pass "public release audit"
else
  fail "public release audit"
fi

section "Top-level dry-run"
if bash install.sh --dry-run --skip-build; then
  pass "top-level installer dry-run"
else
  fail "top-level installer dry-run"
fi

section "Decision"
if [[ "$FAILED" == "0" ]]; then
  pass "Agent preinstall check passed"
else
  fail "Agent preinstall check failed"
  exit 1
fi
