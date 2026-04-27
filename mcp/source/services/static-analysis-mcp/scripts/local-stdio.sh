#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export STATIC_ANALYSIS_CACHE_DIR="${STATIC_ANALYSIS_CACHE_DIR:-$HOME/.hwai/static-analysis-mcp}"
export STATIC_ANALYSIS_REQUEST_LOG_PATH="${STATIC_ANALYSIS_REQUEST_LOG_PATH:-$STATIC_ANALYSIS_CACHE_DIR/requests.jsonl}"
export STATIC_ANALYSIS_ARTIFACT_DIR="${STATIC_ANALYSIS_ARTIFACT_DIR:-$STATIC_ANALYSIS_CACHE_DIR/artifacts}"

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
  echo "node executable not found; set NODE_BIN for static-analysis-mcp local stdio" >&2
  exit 127
fi

NPM_BIN="${NPM_BIN:-$(resolve_bin npm /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm || true)}"

cd "$SERVICE_DIR"
if [[ ! -d node_modules ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm install or set NPM_BIN for static-analysis-mcp local stdio" >&2
    exit 127
  fi
  "$NPM_BIN" install >/dev/null
fi
if [[ ! -f dist/index.js ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm run build or set NPM_BIN for static-analysis-mcp local stdio" >&2
    exit 127
  fi
  "$NPM_BIN" run build >/dev/null
fi
exec "$NODE_BIN" dist/index.js
