#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/agent-trace-mcp"
SESSION_ID="agent-trace-smoke-2026-04-24-$$"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/agent-trace-mcp-smoke.XXXXXX")"

cleanup() {
  rm -rf "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

call_mcp() {
  local payload="$1"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-trace-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | AGENT_TRACE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$("$NODE_BIN" -e '
const sessionId = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "start_trace",
    arguments: {
      session_id: sessionId,
      task_id: "static-analysis-mcp-v1-proof",
      surface: "codex",
      source: "smoke-local",
      title: "Agent trace smoke"
    },
  },
}));
' "$SESSION_ID")"
call_mcp "$("$NODE_BIN" -e '
const sessionId = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "record_step",
    arguments: {
      session_id: sessionId,
      source: "smoke-local",
      step_type: "proof_loop",
      status: "ok",
      summary: "Smoke recorded one deterministic proof step",
      raw_tokens_estimate: 1200,
      compact_tokens_estimate: 180,
      saved_tokens_estimate: 1020
    },
  },
}));
' "$SESSION_ID")"
call_mcp "$("$NODE_BIN" -e '
const sessionId = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "record_tool_result",
    arguments: {
      session_id: sessionId,
      source: "smoke-local",
      utility_mcp: "static-analysis-mcp",
      tool_name: "run_tsc",
      status: "ok",
      duration_ms: 1140,
      raw_tokens_estimate: 800,
      compact_tokens_estimate: 120,
      saved_tokens_estimate: 680,
      uncertainty: 0
    },
  },
}));
' "$SESSION_ID")"
call_mcp "$("$NODE_BIN" -e '
const sessionId = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "summarize_session", arguments: { session_id: sessionId, metadata: { source: "smoke-local" } } },
}));
' "$SESSION_ID")"
call_mcp "$("$NODE_BIN" -e '
const sessionId = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 10,
  method: "tools/call",
  params: {
    name: "compare_sessions",
    arguments: {
      baseline_session_id: sessionId,
      candidate_session_id: sessionId,
      metadata: { source: "smoke-local" },
    },
  },
}));
' "$SESSION_ID")"
call_mcp '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"export_pantheon_safe","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local"}}}}'
call_mcp '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local"}}}}'

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-trace-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" AGENT_TRACE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"start_trace"' "$OUT_FILE"
grep -q '"name":"record_tool_result"' "$OUT_FILE"
grep -q '"name":"compare_sessions"' "$OUT_FILE"
grep -q 'agent-trace.v1' "$OUT_FILE"
grep -q 'agent-trace-session-diff.v1' "$OUT_FILE"
grep -q 'agent-trace-pantheon-export.v1' "$OUT_FILE"
grep -q 'agent-trace-measurement.v1' "$OUT_FILE"
grep -q 'Events: 3' "$OUT_FILE"
echo "agent-trace-mcp smoke ok"
