#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/crawl4ai-mcp"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/crawl4ai-mcp-smoke.XXXXXX")"
trap 'rm -f "$OUT_FILE"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"crawl4ai-mcp-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | "$SERVICE_DIR/scripts/local-stdio.sh" >"$OUT_FILE"

grep -q '"name":"crawl"' "$OUT_FILE"
grep -q '"name":"extract_structured"' "$OUT_FILE"
grep -q '"name":"generate_llmstxt"' "$OUT_FILE"
echo "crawl4ai-mcp smoke ok"
