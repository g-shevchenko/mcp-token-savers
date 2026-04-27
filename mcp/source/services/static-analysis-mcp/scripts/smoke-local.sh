#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/static-analysis-mcp"
TARGET_DIR="$ROOT_DIR/services/context-prep-mcp"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/static-analysis-mcp-smoke.XXXXXX")"
MEASUREMENT_FILE="$(mktemp "${TMPDIR:-/tmp}/static-analysis-mcp-smoke-measurement.XXXXXX")"

cleanup() {
  rm -rf "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE" "$MEASUREMENT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"static-analysis-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_command_policy","arguments":{"root_path":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$TARGET_DIR")"
  printf ',"command_policy_preset":"repo-safe","metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_tsc","arguments":{"root_path":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$TARGET_DIR")"
  printf ',"timeout_ms":60000,"metadata":{"source":"smoke-local"}}}}\n'
  "$NODE_BIN" -e '
const root = process.argv[1];
const sarif = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "smoke-sarif" } },
      results: [
        {
          ruleId: "demo-rule",
          level: "warning",
          message: { text: "Demo warning" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "demo.ts" },
                region: { startLine: 3, startColumn: 5 },
              },
            },
          ],
        },
      ],
    },
  ],
};
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "summarize_sarif",
    arguments: {
      root_path: root,
      sarif_json: JSON.stringify(sarif),
      metadata: { source: "smoke-local" },
    },
  },
}));
' "$ROOT_DIR"
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"metadata":{"source":"smoke-local"}}}}'
} | STATIC_ANALYSIS_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee "$OUT_FILE"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"static-analysis-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" STATIC_ANALYSIS_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

grep -q '"name":"run_tsc"' "$OUT_FILE"
grep -q '"name":"get_command_policy"' "$OUT_FILE"
grep -q 'static-analysis-command-policy.v1' "$OUT_FILE"
grep -q '"name":"summarize_sarif"' "$OUT_FILE"
grep -q 'demo-rule' "$OUT_FILE"
grep -q 'static-analysis.v1' "$OUT_FILE"
grep -q 'static-analysis-measurement.v1' "$OUT_FILE"
STATIC_ANALYSIS_CACHE_DIR="$CACHE_DIR" "$NODE_BIN" "$SERVICE_DIR/scripts/measurement-report.mjs" --date="$(date -u +%F)" --format=pantheon > "$MEASUREMENT_FILE"
grep -q '"trace_source_counts"' "$MEASUREMENT_FILE"
grep -q '"proof_loop"' "$MEASUREMENT_FILE"
echo "static-analysis-mcp smoke ok"
