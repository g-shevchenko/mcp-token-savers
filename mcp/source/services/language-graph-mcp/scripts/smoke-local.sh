#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/language-graph-mcp"
TMP_DIR="$(mktemp -d)"
FIXTURE_DIR="$TMP_DIR/repo"
CACHE_DIR="$TMP_DIR/cache"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/language-graph-mcp-smoke.XXXXXX")"
REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/language-graph-mcp-smoke-report.XXXXXX")"
NODE_BIN="$(command -v node)"
SMOKE_DATE="$("$NODE_BIN" -e 'console.log(new Date().toISOString().slice(0, 10))')"

cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$OUT_FILE" "$REPORT_FILE"
}
trap cleanup EXIT

mkdir -p "$FIXTURE_DIR/src" "$FIXTURE_DIR/docs"
cat >"$FIXTURE_DIR/src/report.ts" <<'TS'
export interface ReportConfig {
  limit: number;
}

export async function runReport(config: ReportConfig) {
  return formatReport(config.limit);
}

export const formatReport = (count: number) => `rows:${count}`;
TS
cat >"$FIXTURE_DIR/src/api.ts" <<'TS'
import { runReport } from "./report";

export async function handleReportRoute() {
  return runReport({ limit: 3 });
}
TS
cat >"$FIXTURE_DIR/src/lazy.ts" <<'TS'
export async function lazyReportRoute() {
  const report = await import("./report");
  return report.runReport({ limit: 2 });
}
TS
cat >"$FIXTURE_DIR/src/report.test.ts" <<'TS'
import { runReport } from "./report";

test("runReport", async () => {
  await runReport({ limit: 1 });
});
TS
cat >"$FIXTURE_DIR/docs/runbook.md" <<'MD'
# Reporting Runbook

## Alert routing
MD

cd "$SERVICE_DIR"
npm run build >/dev/null

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"language-graph-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"index_repo","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_symbol","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"symbol_name":"runReport","auto_index":true,"metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_file_outline","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"file_path":"src/report.ts","auto_index":true,"metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"find_references","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"symbol_name":"runReport","auto_index":true,"metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_import_neighbors","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"file_path":"src/report.ts","auto_index":true,"metadata":{"source":"smoke-local"}}}}\n'
  printf '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_blast_radius","arguments":{"repo_root":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$FIXTURE_DIR")"
  printf ',"symbol_name":"runReport","auto_index":true,"metadata":{"source":"smoke-local"}}}}\n'
  printf '%s\n' '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"metadata":{"source":"smoke-local"}}}}'
} | LANGUAGE_GRAPH_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee "$OUT_FILE"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"language-graph-reduced-path-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" LANGUAGE_GRAPH_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

grep -q '"name":"index_repo"' "$OUT_FILE"
grep -q '"name":"find_references"' "$OUT_FILE"
grep -q 'language-graph.v1' "$OUT_FILE"
grep -q 'language-graph-references.v1' "$OUT_FILE"
grep -q 'language-graph-blast-radius.v1' "$OUT_FILE"
grep -q 'runReport' "$OUT_FILE"
grep -q 'dynamic_import' "$OUT_FILE"
grep -q 'language-graph-measurement.v1' "$OUT_FILE"
LANGUAGE_GRAPH_CACHE_DIR="$CACHE_DIR" node ./scripts/measurement-report.mjs \
  --date="$SMOKE_DATE" \
  --format=pantheon \
  --out="$REPORT_FILE" >/dev/null
"$NODE_BIN" - "$REPORT_FILE" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.safe_for_pantheon !== true) process.exit(1);
if (report.calls < 7) process.exit(1);
if (report.files_indexed < 5) process.exit(1);
if (report.symbols_indexed < 7) process.exit(1);
if (report.dynamic_imports_indexed < 1) process.exit(1);
if (report.references_returned < 6) process.exit(1);
if (report.blast_radius_files < 4) process.exit(1);
NODE
if grep -q "$TMP_DIR" "$CACHE_DIR/requests.jsonl"; then
  echo "request log leaked absolute temp path" >&2
  exit 1
fi
echo "language-graph-mcp smoke ok"
