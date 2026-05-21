#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/repo-hygiene-mcp"
TMP_DIR="$(mktemp -d)"
CACHE_DIR="$TMP_DIR/.cache"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/repo-hygiene-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cleanup() {
  rm -rf "$TMP_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

mkdir -p "$TMP_DIR/src"
cat > "$TMP_DIR/package.json" <<'JSON'
{
  "name": "repo-hygiene-smoke",
  "type": "module",
  "dependencies": {
    "chalk": "^5.0.0",
    "left-pad": "^1.3.0",
    "lodash": "^4.17.21"
  }
}
JSON
cat > "$TMP_DIR/src/app.ts" <<'TS'
import lodash from "lodash";

export function usedUtility(value: string) {
  return lodash.camelCase(value);
}

export function orphanUtility(value: string) {
  return value.trim().toUpperCase();
}
TS
cat > "$TMP_DIR/src/a.ts" <<'TS'
import { b } from "./b";
export const a = b + 1;
TS
cat > "$TMP_DIR/src/b.ts" <<'TS'
import { a } from "./a";
export const b = a + 1;
TS
cat > "$TMP_DIR/src/lazy.ts" <<'TS'
export async function colorize(value: string) {
  const chalk = await import("chalk");
  return chalk.default.green(value);
}
TS
cat > "$TMP_DIR/src/dup-one.ts" <<'TS'
export function firstDuplicate(input: string) {
  const normalized = input.trim().toLowerCase();
  const parts = normalized.split("-");
  const filtered = parts.filter(Boolean);
  const joined = filtered.join("_");
  return joined.replace(/_/g, "-");
}
TS
cat > "$TMP_DIR/src/dup-two.ts" <<'TS'
export function secondDuplicate(input: string) {
  const normalized = input.trim().toLowerCase();
  const parts = normalized.split("-");
  const filtered = parts.filter(Boolean);
  const joined = filtered.join("_");
  return joined.replace(/_/g, "-");
}
TS
cat > "$TMP_DIR/src/complex.ts" <<'TS'
export function complex(items: string[]) {
  let total = 0;
  for (const item of items) {
    if (item.includes("a") && item.length > 2) total += 1;
    if (item.includes("b") || item.includes("c")) total += 1;
    switch (item[0]) {
      case "x":
        total += 1;
        break;
      default:
        total += 0;
    }
  }
  return total > 2 ? total : 0;
}
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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-hygiene-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | REPO_HYGIENE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

scan_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], max_files: 50, max_findings: 20, block_lines: 5, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
depth_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], path: "src/complex.ts", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
depth_compare_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], path: "src/complex.ts", compare_to: "src/app.ts", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local" } }))')"
reduced_measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local-reduced-path" } }))')"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 scan_unused_dependencies "$scan_args")"
call_mcp "$(call_tool 4 scan_unused_code "$scan_args")"
call_mcp "$(call_tool 5 scan_duplicate_code "$scan_args")"
call_mcp "$(call_tool 6 scan_dependency_cycles "$scan_args")"
call_mcp "$(call_tool 7 scan_complexity_hotspots "$scan_args")"
call_mcp "$(call_tool 8 propose_cleanup_plan "$scan_args")"
call_mcp "$(call_tool 9 get_measurement_report "$measurement_args")"
call_mcp "$(call_tool 11 score_module_depth "$depth_args")"
call_mcp "$(call_tool 12 score_module_depth "$depth_compare_args")"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-hygiene-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  call_tool 10 get_measurement_report "$reduced_measurement_args"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" REPO_HYGIENE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"scan_unused_dependencies"' "$OUT_FILE"
grep -q '"name":"scan_unused_code"' "$OUT_FILE"
grep -q '"name":"scan_duplicate_code"' "$OUT_FILE"
grep -q '"name":"scan_dependency_cycles"' "$OUT_FILE"
grep -q '"name":"scan_complexity_hotspots"' "$OUT_FILE"
grep -q '"name":"score_module_depth"' "$OUT_FILE"
grep -q '"name":"propose_cleanup_plan"' "$OUT_FILE"
grep -q '"depth_ratio"' "$OUT_FILE"
grep -q '"band"' "$OUT_FILE"
grep -q '"direction"' "$OUT_FILE"
grep -q 'repo-hygiene.v0.1' "$OUT_FILE"
grep -q 'repo-hygiene-measurement.v0.1' "$OUT_FILE"
grep -q 'left-pad' "$OUT_FILE"
grep -q 'dynamic_imports_seen' "$OUT_FILE"
if rg -q 'dependency_name\\": \\"chalk' "$OUT_FILE"; then
  echo "repo-hygiene-mcp smoke incorrectly flagged dynamic import dependency" >&2
  exit 1
fi
grep -q 'orphanUtility' "$OUT_FILE"
grep -q 'duplicate_groups' "$OUT_FILE"
grep -q 'cycles_count' "$OUT_FILE"
grep -q 'plan_items_count' "$OUT_FILE"
if rg -q 'value.trim\\(\\)\\.toUpperCase|joined.replace|/Users/' "$OUT_FILE"; then
  echo "repo-hygiene-mcp smoke leaked raw code body or absolute path" >&2
  exit 1
fi
if rg -q "$TMP_DIR" "$CACHE_DIR/requests.jsonl"; then
  echo "repo-hygiene-mcp smoke leaked absolute temp path in request log" >&2
  exit 1
fi
echo "repo-hygiene-mcp smoke ok"
