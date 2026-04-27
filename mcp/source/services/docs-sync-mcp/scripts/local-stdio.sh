#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  for candidate in \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "docs-sync-mcp: node binary not found" >&2
  exit 127
fi

if [[ ! -f "$SERVICE_DIR/dist/index.js" ]]; then
  echo "docs-sync-mcp: dist/index.js not found; run npm run build in $SERVICE_DIR" >&2
  exit 1
fi

export DOCS_SYNC_CACHE_DIR="${DOCS_SYNC_CACHE_DIR:-$HOME/.hwai/docs-sync-mcp}"
exec "$NODE_BIN" "$SERVICE_DIR/dist/index.js"
