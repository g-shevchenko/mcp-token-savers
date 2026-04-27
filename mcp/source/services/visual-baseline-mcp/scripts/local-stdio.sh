#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export VISUAL_BASELINE_CACHE_DIR="${VISUAL_BASELINE_CACHE_DIR:-$HOME/.hwai/visual-baseline-mcp}"
export VISUAL_BASELINE_REQUEST_LOG_PATH="${VISUAL_BASELINE_REQUEST_LOG_PATH:-$VISUAL_BASELINE_CACHE_DIR/requests.jsonl}"
export VISUAL_BASELINE_ARTIFACT_DIR="${VISUAL_BASELINE_ARTIFACT_DIR:-$VISUAL_BASELINE_CACHE_DIR/artifacts}"
export VISUAL_BASELINE_BASELINE_DIR="${VISUAL_BASELINE_BASELINE_DIR:-$VISUAL_BASELINE_CACHE_DIR/baselines}"

resolve_bin() {
  local name="$1"
  shift
  local detected
  detected="$(command -v "$name" 2>/dev/null || true)"
  for candidate in "$detected" "$@"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="${NODE_BIN:-$(resolve_bin node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node executable not found; set NODE_BIN for visual-baseline-mcp local stdio" >&2
  exit 127
fi

NPM_BIN="${NPM_BIN:-$(resolve_bin npm /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm || true)}"

cd "$SERVICE_DIR"
if [[ ! -d node_modules ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm install or set NPM_BIN for visual-baseline-mcp local stdio" >&2
    exit 127
  fi
  "$NPM_BIN" install >/dev/null
fi
if [[ ! -f dist/index.js ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm run build or set NPM_BIN for visual-baseline-mcp local stdio" >&2
    exit 127
  fi
  "$NPM_BIN" run build >/dev/null
fi

exec "$NODE_BIN" dist/index.js
