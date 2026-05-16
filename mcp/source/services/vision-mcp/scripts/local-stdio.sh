#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${HWAI_MCP_ENV_FILE:-$HOME/.hwai/mcp-stack/env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export VISION_MCP_CACHE_DIR="${VISION_MCP_CACHE_DIR:-$HOME/.hwai/vision-mcp}"

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
  echo "node executable not found; set NODE_BIN for vision-mcp local stdio" >&2
  exit 127
fi

NPM_BIN="${NPM_BIN:-$(resolve_bin npm /opt/homebrew/bin/npm /usr/local/bin/npm /usr/bin/npm || true)}"

cd "$SERVICE_DIR"
if [[ ! -f dist/index.js ]] || \
  [[ -n "$(find src package.json tsconfig.json -newer dist/index.js -print -quit 2>/dev/null)" ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm run build or set NPM_BIN for vision-mcp local stdio" >&2
    exit 127
  fi
  "$NPM_BIN" run build >/dev/null
fi

exec "$NODE_BIN" dist/index.js
