#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/playwright-trace-mcp"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/playwright-trace-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
SMOKE_DATE="$("$NODE_BIN" -e 'console.log(new Date().toISOString().slice(0, 10))')"
trap 'rm -rf "$OUT_FILE" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

TRACE_JSON="$("$NODE_BIN" -e '
const rows = [
  { type: "before", callId: "call@save", class: "Frame", method: "click", startTime: 1000, params: { selector: "text=Save" } },
  { type: "console", messageType: "error", text: "TypeError: save is not a function", location: "app.js:42", time: 1100 },
  {
    type: "resource-snapshot",
    snapshot: {
      _monotonicTime: 1120,
      time: 45,
      request: { method: "POST", url: "https://example.test/api/save?debug=true" },
      response: { status: 500, statusText: "Internal Server Error" }
    }
  },
  { type: "after", callId: "call@save", endTime: 1500, error: { message: "Timeout 5000ms exceeded while waiting for locator" } }
];
process.stdout.write(JSON.stringify(rows));
')"

call_mcp() {
  local payload="$1"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"playwright-trace-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | PLAYWRIGHT_TRACE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

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

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 prepare_trace "$("$NODE_BIN" -e 'console.log(JSON.stringify({ trace_json: process.argv[1], metadata: { source: "smoke-local" } }))' "$TRACE_JSON")")"
call_mcp "$(call_tool 4 summarize_console "$("$NODE_BIN" -e 'console.log(JSON.stringify({ trace_json: process.argv[1], metadata: { source: "smoke-local" } }))' "$TRACE_JSON")")"
call_mcp "$(call_tool 5 summarize_network "$("$NODE_BIN" -e 'console.log(JSON.stringify({ trace_json: process.argv[1], metadata: { source: "smoke-local" } }))' "$TRACE_JSON")")"
call_mcp "$(call_tool 6 extract_failure_step "$("$NODE_BIN" -e 'console.log(JSON.stringify({ trace_json: process.argv[1], metadata: { source: "smoke-local" } }))' "$TRACE_JSON")")"
call_mcp "$(call_tool 7 prepare_trace_screenshots '{"metadata":{"source":"smoke-local"}}')"
call_mcp "$(call_tool 8 get_measurement_report "$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: process.argv[1], metadata: { source: "smoke-local" } }))' "$SMOKE_DATE")")"

REDUCED_CACHE_DIR="$(mktemp -d)"
reduced_measurement_payload="$("$NODE_BIN" -e 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_measurement_report", arguments: { date: process.argv[1], metadata: { source: "smoke-local-reduced-path" } } } }))' "$SMOKE_DATE")"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"playwright-trace-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' "$reduced_measurement_payload"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" PLAYWRIGHT_TRACE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"prepare_trace"' "$OUT_FILE"
grep -q '"name":"summarize_console"' "$OUT_FILE"
grep -q '"name":"summarize_network"' "$OUT_FILE"
grep -q 'playwright-trace.v1' "$OUT_FILE"
grep -q 'playwright-trace-measurement.v1' "$OUT_FILE"
grep -q 'context_prep_recommended' "$OUT_FILE"
grep -q 'scraper_followup_recommended' "$OUT_FILE"
grep -q 'Errors: 1' "$OUT_FILE"
grep -q 'Network failures: 1' "$OUT_FILE"
grep -q 'Failure window: Around failure' "$OUT_FILE"
grep -q 'failure_window_network_failures' "$OUT_FILE"
grep -q 'Timeout 5000ms exceeded' "$OUT_FILE"
echo "playwright-trace-mcp smoke ok"
