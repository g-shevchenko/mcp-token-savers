#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/repo-quality-gate-mcp"
TMP_DIR="$(mktemp -d)"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/repo-quality-gate-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cleanup() {
  rm -rf "$TMP_DIR" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

mkdir -p "$TMP_DIR/src" "$TMP_DIR/docs"
cat > "$TMP_DIR/README.md" <<'MD'
# Fixture

Small baseline doc.
MD
cat > "$TMP_DIR/src/app.ts" <<'TS'
export const baseline = 1;
TS
git -C "$TMP_DIR" init >/dev/null
git -C "$TMP_DIR" add .
git -C "$TMP_DIR" -c user.name=HWAI -c user.email=hwai@example.test commit -m baseline >/dev/null
cat > "$TMP_DIR/src/new-feature.ts" <<'TS'
export function newFeature(input: string) {
  const normalized = input.trim().toLowerCase();
  const parts = normalized.split("-");
  return parts.filter(Boolean).join("_");
}
TS
cat > "$TMP_DIR/docs/new-guide.md" <<'MD'
# New Guide

This changed guide intentionally lacks frontmatter.
It has enough lines to trip the large-doc budget in the fixture.
The point is to keep generated docs and maintained docs separated.
Agents should review exact files before changing documentation.
Budgets are advisory until false positives are measured.
MD
mkdir -p "$TMP_DIR/dist"
cat > "$TMP_DIR/dist/generated.ts" <<'TS'
export const generated0 = 0;
export const generated1 = 1;
export const generated2 = 2;
export const generated3 = 3;
export const generated4 = 4;
export const generated5 = 5;
export const generated6 = 6;
export const generated7 = 7;
TS
mkdir -p "$TMP_DIR/.cache"
cat > "$TMP_DIR/.cache/tool-output.ts" <<'TS'
export const cached0 = 0;
export const cached1 = 1;
export const cached2 = 2;
export const cached3 = 3;
TS

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-quality-gate-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | REPO_QUALITY_GATE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

scan_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], base_ref: "HEAD", max_added_code_lines: 2, max_added_doc_lines: 4, max_changed_code_files: 1, max_changed_doc_files: 1, max_context_pressure_score: 5, max_large_docs: 0, large_doc_lines: 6, max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local" } }))')"
reduced_measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local-reduced-path" } }))')"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 check_new_code_budget "$scan_args")"
call_mcp "$(call_tool 4 check_new_docs_budget "$scan_args")"
call_mcp "$(call_tool 5 check_context_budget "$scan_args")"
call_mcp "$(call_tool 6 create_quality_snapshot "$scan_args")"
call_mcp "$(call_tool 7 propose_quality_gate_plan "$scan_args")"
call_mcp "$(call_tool 8 get_measurement_report "$measurement_args")"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-quality-gate-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  call_tool 9 get_measurement_report "$reduced_measurement_args"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" REPO_QUALITY_GATE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"check_new_code_budget"' "$OUT_FILE"
grep -q '"name":"check_new_docs_budget"' "$OUT_FILE"
grep -q '"name":"check_context_budget"' "$OUT_FILE"
grep -q '"name":"create_quality_snapshot"' "$OUT_FILE"
grep -q '"name":"compare_quality_snapshot"' "$OUT_FILE"
grep -q '"name":"propose_quality_gate_plan"' "$OUT_FILE"
grep -q 'repo-quality-gate.v0.1' "$OUT_FILE"
grep -q 'repo-quality-gate-measurement.v0.1' "$OUT_FILE"
grep -q 'added_code_lines' "$OUT_FILE"
grep -q 'added_doc_lines' "$OUT_FILE"
grep -q 'context_pressure_score' "$OUT_FILE"
grep -q 'plan_items_count' "$OUT_FILE"
if rg -q 'input.trim\\(\\)\\.toLowerCase|parts.filter|/Users/' "$OUT_FILE"; then
  echo "repo-quality-gate-mcp smoke leaked raw code body or absolute path" >&2
  exit 1
fi
if rg -q 'dist/generated.ts|\\.cache/tool-output.ts' "$OUT_FILE"; then
  echo "repo-quality-gate-mcp smoke counted generated root dist file by default" >&2
  exit 1
fi
if rg -q "$TMP_DIR" "$CACHE_DIR/requests.jsonl"; then
  echo "repo-quality-gate-mcp smoke leaked absolute temp path in request log" >&2
  exit 1
fi
echo "repo-quality-gate-mcp smoke ok"
