#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/searxng-mcp"
ENV_FILE="${HWAI_MCP_ENV_FILE:-$HOME/.hwai/mcp-stack/env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node executable not found; set NODE_BIN for searxng-mcp local stdio" >&2
  exit 127
fi
if [[ ! -f "$SERVICE_DIR/dist/index.js" ]] || \
  [[ -n "$(find "$SERVICE_DIR/src" "$SERVICE_DIR/package.json" "$SERVICE_DIR/tsconfig.json" -newer "$SERVICE_DIR/dist/index.js" -print -quit 2>/dev/null)" ]]; then
  if [[ -z "$NPM_BIN" ]]; then
    echo "npm executable not found; run npm run build or set NPM_BIN for searxng-mcp local stdio" >&2
    exit 127
  fi
  (cd "$SERVICE_DIR" && "$NPM_BIN" run build >/dev/null)
fi

export HWAI_SCRAPER_URL="${HWAI_SCRAPER_URL:-http://localhost:8090}"
export HWAI_CONTEXT="${HWAI_CONTEXT:-searxng-mcp/local-stdio}"
exec "$NODE_BIN" "$SERVICE_DIR/dist/index.js"
