#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/golden-dataset-mcp"
NODE_BIN="$(command -v node)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/golden-dataset-mcp-smoke.XXXXXX")"

cd "$SERVICE_DIR"
npm run build >/dev/null
export GOLDEN_DATASET_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/golden-dataset-mcp-smoke.XXXXXX")"

cleanup() {
  rm -rf "$GOLDEN_DATASET_CACHE_DIR"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

call_mcp() {
  local payload="$1"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"golden-dataset-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_case_from_feedback","arguments":{"dataset":"retrieval-quality","feedback_id":"smoke-feedback-1","call_id":"smoke-call-1","source_service":"retrieval-mcp","task_type":"retrieval","raw_query":"raw smoke query should only be hashed","query_summary":"Reviewed-safe smoke retrieval miss.","expected_paths":["services/retrieval-mcp/src/measurement.ts"],"missing_paths":["services/retrieval-mcp/src/measurement.ts"],"tags":["smoke","retrieval"],"status":"reviewed","metadata":{"source":"smoke-local"}}}}'
call_mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_datasets","arguments":{"metadata":{"source":"smoke-local"}}}}'
call_mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"run_dataset","arguments":{"dataset":"retrieval-quality","runner":"smoke","run_id":"smoke-run","results":[{"case_id":"retrieval-mcp:smoke-feedback-1","returned_paths":["services/retrieval-mcp/src/measurement.ts"]}],"metadata":{"source":"smoke-local"}}}}'
call_mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"export_dataset_manifest","arguments":{"dataset":"retrieval-quality","metadata":{"source":"smoke-local"}}}}'
call_mcp '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"metadata":{"source":"smoke-local"}}}}'

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"golden-dataset-reduced-path-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_datasets","arguments":{"metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"add_case_from_feedback"' "$OUT_FILE"
grep -q '"name":"run_dataset"' "$OUT_FILE"
grep -q '"name":"run_retrieval_dataset"' "$OUT_FILE"
grep -q '"name":"import_retrieval_feedback"' "$OUT_FILE"
grep -q '"name":"compare_runs"' "$OUT_FILE"
grep -q 'golden-dataset.v1' "$OUT_FILE"
grep -q 'golden-dataset-measurement.v1' "$OUT_FILE"
if rg -q 'raw smoke query should only be hashed|/Users/' "$OUT_FILE" "$GOLDEN_DATASET_CACHE_DIR/requests.jsonl"; then
  echo "golden-dataset-mcp smoke leaked raw query or absolute path" >&2
  exit 1
fi
echo "golden-dataset-mcp smoke ok"
