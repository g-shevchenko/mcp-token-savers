#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/context-prep-mcp"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/context-prep-mcp-smoke.XXXXXX")"

trap 'rm -f "$OUT_FILE"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"context-prep-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  "$NODE_BIN" - <<'NODE'
const logText = [
  "$ npm run build",
  "src/app.ts:12:4 - error TS2304: Cannot find name 'leakySymbol'.",
  "Build failed"
].join("\n");
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "prep_logs",
    arguments: {
      text: logText,
      context: "local stdio smoke",
      metadata: { source: "smoke-local" }
    }
  }
}));
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "prep_text",
    arguments: {
      text: "Decision: keep context-prep local-first. Action: add stdio smoke coverage. Risk: do not leak raw text into request logs.",
      purpose: "local smoke",
      metadata: { source: "smoke-local" }
    }
  }
}));
NODE
} | CONTEXT_PREP_CACHE_DIR="$CACHE_DIR" \
  CONTEXT_PREP_SCRAPER_FALLBACK=disabled \
  "$SERVICE_DIR/scripts/local-stdio.sh" | tee "$OUT_FILE" >/dev/null

grep -q '"name":"prep_logs"' "$OUT_FILE"
grep -q '"name":"prep_text"' "$OUT_FILE"
grep -q '"name":"prep_url"' "$OUT_FILE"
grep -q '"name":"get_artifact"' "$OUT_FILE"
grep -q 'context-prep.v1' "$OUT_FILE"
grep -q 'logs-prep' "$OUT_FILE"
grep -q 'text-prep' "$OUT_FILE"

if rg -q 'leakySymbol|keep context-prep local-first' "$CACHE_DIR/requests.jsonl"; then
  echo "context-prep-mcp smoke leaked raw input into request log" >&2
  exit 1
fi

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"context-prep-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" CONTEXT_PREP_CACHE_DIR="$(mktemp -d)" \
  "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

grep -q '"name":"prep_logs"' "$OUT_FILE"
echo "context-prep-mcp smoke ok"
