#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/manifest.json"
CLI="$SCRIPT_DIR/bin/hwai-mcp.mjs"

PROFILE="core"
CLIENTS="auto"
WORKSPACE="${PWD}"
SOURCE_ROOT="${HWAI_MCP_SOURCE_ROOT:-$SCRIPT_DIR/source}"
REPO_URL="${HWAI_MCP_SOURCE_REPO:-}"
DRY_RUN=0
SKIP_BUILD=0
UPDATE_SOURCE=0
AGENT_DOCS="auto"

usage() {
  cat <<'EOF'
Usage: ./mcp/install.sh [options]

Options:
  --profile=core|repo|browser-debug|full
  --clients=auto|claude,codex,cursor,windsurf
  --workspace=/absolute/project/path   Project/workspace to receive project MCP configs. Default: current directory.
  --source-root=/absolute/path         Existing bundled MCP source root. Default: ./mcp/source.
  --repo-url=https://github.com/...    Explicit fallback source repo to clone if --source-root is missing.
  --update-source                      Run git pull --ff-only for a git-backed --source-root.
  --dry-run                            Show actions/config changes without writing.
  --skip-build                         Skip npm install/build; useful for config-only updates.
  --agent-docs=auto|skip               Write local agent docs/rules into workspace. Default: auto.
  --no-update-source                   Compatibility no-op; bundled source is not updated by default.

One-command example after public release:
  /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/hwai-mcp-stack/main/install.sh)"

Existing clone example:
  ~/.hwai/hwai-mcp-stack/mcp/install.sh --profile=core --clients=auto
EOF
}

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --clients=*) CLIENTS="${arg#*=}" ;;
    --workspace=*) WORKSPACE="${arg#*=}" ;;
    --source-root=*) SOURCE_ROOT="${arg#*=}" ;;
    --repo-url=*) REPO_URL="${arg#*=}" ;;
    --update-source) UPDATE_SOURCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --agent-docs=*) AGENT_DOCS="${arg#*=}" ;;
    --no-update-source) UPDATE_SOURCE=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required executable not found: $name" >&2
    exit 127
  fi
}

require_bin node
require_bin npm

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(m.source_repo || "");' "$MANIFEST")"
fi

case "$AGENT_DOCS" in
  auto|skip) ;;
  *) echo "Unknown agent-docs value: $AGENT_DOCS" >&2; usage; exit 2 ;;
esac

mkdir -p "$HOME/.hwai/mcp-stack"

if [[ -d "$SOURCE_ROOT/services" ]]; then
  echo "using bundled MCP source: $SOURCE_ROOT"
  if [[ "$UPDATE_SOURCE" == "1" ]]; then
    require_bin git
    if git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if [[ "$DRY_RUN" == "1" ]]; then
        echo "[dry-run] would update $SOURCE_ROOT with git pull --ff-only"
      else
        git -C "$SOURCE_ROOT" pull --ff-only
      fi
    else
      echo "--update-source requested, but $SOURCE_ROOT is bundled/non-git source; skipping" >&2
    fi
  fi
else
  if [[ -z "$REPO_URL" ]]; then
    echo "Bundled MCP source not found at $SOURCE_ROOT/services" >&2
    echo "Re-clone the MCP stack repo, or pass --source-root to an existing MCP source tree." >&2
    exit 2
  elif [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] would clone $REPO_URL into $SOURCE_ROOT"
  else
    require_bin git
    mkdir -p "$(dirname "$SOURCE_ROOT")"
    git clone --filter=blob:none "$REPO_URL" "$SOURCE_ROOT"
  fi
fi

CLI_ARGS=(
  "$CLI" install
  --manifest="$MANIFEST" \
  --source-root="$SOURCE_ROOT" \
  --workspace="$WORKSPACE" \
  --profile="$PROFILE" \
  --clients="$CLIENTS"
  --agent-docs="$AGENT_DOCS"
)

if [[ "$DRY_RUN" == "1" ]]; then
  CLI_ARGS+=(--dry-run)
fi
if [[ "$SKIP_BUILD" == "1" ]]; then
  CLI_ARGS+=(--skip-build)
fi

exec node "${CLI_ARGS[@]}"
