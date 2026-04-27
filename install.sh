#!/usr/bin/env bash
set -euo pipefail

PROFILE="${HWAI_MCP_PROFILE:-core}"
CLIENTS="${HWAI_MCP_CLIENTS:-auto}"
WORKSPACE="${HWAI_MCP_WORKSPACE:-$PWD}"
REPO_SLUG="${HWAI_MCP_REPO_SLUG:-g-shevchenko/hwai-mcp-stack}"
REPO_URL="${HWAI_MCP_REPO_URL:-https://github.com/${REPO_SLUG}.git}"
REPO_DIR="${HWAI_MCP_REPO_DIR:-$HOME/.hwai/hwai-mcp-stack}"
BRANCH="${HWAI_MCP_BRANCH:-main}"
SKIP_BUILD="${HWAI_MCP_SKIP_BUILD:-0}"
DRY_RUN="${HWAI_MCP_DRY_RUN:-0}"
NO_UPDATE="${HWAI_MCP_NO_UPDATE:-0}"
AGENT_DOCS="${HWAI_MCP_AGENT_DOCS:-auto}"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --profile=core|repo|browser-debug|external-context|full   Default: core
  --clients=auto|claude,codex,cursor,windsurf               Default: auto
  --workspace=/absolute/project/path                        Default: current dir
  --repo-dir=/absolute/path                                 Default: ~/.hwai/hwai-mcp-stack
  --repo-url=https://github.com/OWNER/REPO.git              Default: public repo URL
  --branch=main                                             Default: main
  --skip-build                                              Pass through to mcp/install.sh
  --dry-run                                                 Pass through to mcp/install.sh
  --no-update                                               Do not pull an existing clone
  --agent-docs=auto|skip                                    Default: auto
  --help|-h

Environment overrides:
  HWAI_MCP_PROFILE, HWAI_MCP_CLIENTS, HWAI_MCP_REPO_SLUG,
  HWAI_MCP_REPO_URL, HWAI_MCP_REPO_DIR, HWAI_MCP_BRANCH,
  HWAI_MCP_AGENT_DOCS
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    case "$name" in
      git) die "Required executable not found: git. Install Xcode Command Line Tools or Git first." ;;
      node) die "Required executable not found: node. Install Node.js LTS first." ;;
      npm) die "Required executable not found: npm. Install Node.js LTS first." ;;
      *) die "Required executable not found: $name" ;;
    esac
  fi
}

abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    ~) printf '%s\n' "$HOME" ;;
    ~/*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s/%s\n' "$PWD" "$1" ;;
  esac
}

stamp() {
  date +"%Y%m%d%H%M%S"
}

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --clients=*) CLIENTS="${arg#*=}" ;;
    --workspace=*) WORKSPACE="${arg#*=}" ;;
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --repo-url=*) REPO_URL="${arg#*=}" ;;
    --branch=*) BRANCH="${arg#*=}" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-update) NO_UPDATE=1 ;;
    --agent-docs=*) AGENT_DOCS="${arg#*=}" ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

WORKSPACE="$(abs_path "$WORKSPACE")"
REPO_DIR="$(abs_path "$REPO_DIR")"

case "$PROFILE" in
  core|repo|browser-debug|external-context|full) ;;
  *) die "Unknown profile: $PROFILE" ;;
esac

case "$CLIENTS" in
  auto|claude|codex|cursor|windsurf|*,*) ;;
  *) die "Unknown clients value: $CLIENTS" ;;
esac

case "$AGENT_DOCS" in
  auto|skip) ;;
  *) die "Unknown agent-docs value: $AGENT_DOCS" ;;
esac

log "Humanswith.ai MCP public installer"
printf 'profile=%s\nclients=%s\nworkspace=%s\nrepo_url=%s\nrepo_dir=%s\nbranch=%s\nagent_docs=%s\n' "$PROFILE" "$CLIENTS" "$WORKSPACE" "$REPO_URL" "$REPO_DIR" "$BRANCH" "$AGENT_DOCS"

log "Checking local prerequisites"
require_bin git
require_bin node
require_bin npm
printf 'git=%s\n' "$(git --version)"
printf 'node=%s\n' "$(node --version)"
printf 'npm=%s\n' "$(npm --version)"

log "Preparing local bundle clone"
mkdir -p "$(dirname "$REPO_DIR")"
if [[ -e "$REPO_DIR" && ! -d "$REPO_DIR/.git" ]]; then
  BACKUP_DIR="${REPO_DIR}.bak.$(stamp)"
  echo "Existing non-git path found at $REPO_DIR; moving to $BACKUP_DIR"
  mv "$REPO_DIR" "$BACKUP_DIR"
fi

if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" remote set-url origin "$REPO_URL"
  if [[ "$NO_UPDATE" == "1" ]]; then
    echo "no-update enabled; keeping existing clone"
  else
    git -C "$REPO_DIR" fetch origin "$BRANCH"
    git -C "$REPO_DIR" checkout "$BRANCH"
    git -C "$REPO_DIR" pull --ff-only
  fi
else
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

test -f "$REPO_DIR/mcp/install.sh" || die "Missing installer: $REPO_DIR/mcp/install.sh"
test -f "$REPO_DIR/mcp/bin/hwai-mcp.mjs" || die "Missing CLI: $REPO_DIR/mcp/bin/hwai-mcp.mjs"
test -d "$REPO_DIR/mcp/source/services" || die "Missing bundled source: $REPO_DIR/mcp/source/services"

log "Installing MCP profile"
INSTALL_ARGS=(
  "--profile=$PROFILE"
  "--clients=$CLIENTS"
  "--workspace=$WORKSPACE"
  "--agent-docs=$AGENT_DOCS"
)
if [[ "$SKIP_BUILD" == "1" ]]; then
  INSTALL_ARGS+=(--skip-build)
fi
if [[ "$DRY_RUN" == "1" ]]; then
  INSTALL_ARGS+=(--dry-run)
fi

bash "$REPO_DIR/mcp/install.sh" "${INSTALL_ARGS[@]}"

log "Running final doctor"
node "$REPO_DIR/mcp/bin/hwai-mcp.mjs" doctor \
  --manifest="$REPO_DIR/mcp/manifest.json" \
  --source-root="$REPO_DIR/mcp/source" \
  --profile="$PROFILE"

log "Done"
echo "Restart Claude Code, Codex, Cursor, or Windsurf, or open a new chat so stdio MCP configs reload."
if [[ "$PROFILE" == "full" || "$PROFILE" == "external-context" ]]; then
  echo "External-context MCPs require endpoint URLs and bearer keys in ~/.hwai/mcp-stack/env."
fi
