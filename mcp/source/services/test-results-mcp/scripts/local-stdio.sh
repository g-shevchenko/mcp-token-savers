#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/test-results-mcp"

cd "$ROOT_DIR"

export TEST_RESULTS_CACHE_DIR="${TEST_RESULTS_CACHE_DIR:-$HOME/.hwai/test-results-mcp}"

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
  echo "node executable not found; set NODE_BIN for test-results-mcp local stdio" >&2
  exit 127
fi

NPM_BIN="${NPM_BIN:-$(resolve_bin npm /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm || true)}"

if [[ ! -f "$SERVICE_DIR/dist/index.js" ]] || \
  [[ -n "$(find "$SERVICE_DIR/src" "$SERVICE_DIR/package.json" "$SERVICE_DIR/tsconfig.json" -newer "$SERVICE_DIR/dist/index.js" -print -quit 2>/dev/null)" ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm run build or set NPM_BIN for test-results-mcp local stdio" >&2
    exit 127
  fi
  (cd "$SERVICE_DIR" && "$NPM_BIN" run build >/dev/null)
fi

exec "$NODE_BIN" "$SERVICE_DIR/dist/index.js"
