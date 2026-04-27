#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export ROUTER_LITE_CACHE_DIR="${ROUTER_LITE_CACHE_DIR:-$HOME/.hwai/router-lite-mcp}"

cd "$SERVICE_DIR"
exec node dist/index.js
