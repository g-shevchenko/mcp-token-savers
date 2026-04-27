#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/router-lite-mcp"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/router-lite-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cleanup() {
  rm -rf "$CACHE_DIR"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

call_tool() {
  local id="$1"
  local name="$2"
  local args="$3"
  "$NODE_BIN" -e '
const id = Number(process.argv[1]);
const name = process.argv[2];
const args = JSON.parse(process.argv[3]);
console.log(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
' "$id" "$name" "$args"
}

call_mcp() {
  local payload="$1"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"router-lite-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | ROUTER_LITE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

route_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ text: "Review screenshot https://example.com/screenshots/sample.png", metadata: { source: "smoke-local", traffic_class: "proof" } }))')"
skip_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ text: "What is MRR?", metadata: { source: "smoke-local", traffic_class: "proof" } }))')"
clarify_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ text: "fix it", metadata: { source: "smoke-local", traffic_class: "proof" } }))')"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local", traffic_class: "proof" } }))')"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 route_task "$route_args")"
call_mcp "$(call_tool 4 classify_input "$skip_args")"
call_mcp "$(call_tool 5 needs_clarification "$clarify_args")"
call_mcp "$(call_tool 6 get_measurement_report "$measurement_args")"

cat "$OUT_FILE"

grep -q '"name":"route_task"' "$OUT_FILE"
grep -q '"name":"classify_input"' "$OUT_FILE"
grep -q '"name":"needs_clarification"' "$OUT_FILE"
grep -q '"name":"get_measurement_report"' "$OUT_FILE"
grep -q 'router-lite.v0.1' "$OUT_FILE"
grep -q 'router-lite-measurement.v0.1' "$OUT_FILE"
grep -q 'vision-mcp' "$OUT_FILE"
grep -q 'skip_mcp' "$OUT_FILE"
grep -q 'needs_clarification' "$OUT_FILE"
grep -q 'safe_for_pantheon' "$OUT_FILE"
if rg -q 'sample.png|Review screenshot|What is MRR|fix it' "$CACHE_DIR/requests.jsonl"; then
  echo "router-lite-mcp smoke leaked raw prompt or URL to request log" >&2
  exit 1
fi
echo "router-lite-mcp smoke ok"
