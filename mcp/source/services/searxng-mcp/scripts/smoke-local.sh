#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/searxng-mcp"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/searxng-mcp-smoke.XXXXXX")"
trap 'rm -f "$OUT_FILE"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"searxng-mcp-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | "$SERVICE_DIR/scripts/local-stdio.sh" >"$OUT_FILE"

grep -q '"name":"search"' "$OUT_FILE"
echo "searxng-mcp smoke ok"
