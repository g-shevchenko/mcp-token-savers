#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/repo-history-mcp"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/repo-history-mcp-smoke.XXXXXX")"

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-history-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | REPO_HISTORY_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "summarize_recent_commits",
    arguments: {
      repo_root: root,
      max_commits: 3,
      max_files: 20,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "summarize_diff_stat",
    arguments: {
      repo_root: root,
      base_ref: "HEAD~1",
      head_ref: "HEAD",
      max_files: 20,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "find_change_hotspots",
    arguments: {
      repo_root: root,
      max_commits: 25,
      max_files: 10,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: {
    name: "search_commits",
    arguments: {
      repo_root: root,
      query: "MCP",
      max_commits: 5,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: {
    name: "summarize_blame",
    arguments: {
      repo_root: root,
      file_path: "AGENTS.md",
      start_line: 1,
      end_line: 20,
      max_authors: 5,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp "$("$NODE_BIN" -e '
const root = process.argv[1];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 8,
  method: "tools/call",
  params: {
    name: "find_cochange_files",
    arguments: {
      repo_root: root,
      paths: ["AGENTS.md"],
      max_commits: 20,
      max_files: 10,
      metadata: { source: "smoke-local" }
    },
  },
}));
' "$ROOT_DIR")"
call_mcp '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local"}}}}'

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repo-history-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" REPO_HISTORY_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"summarize_recent_commits"' "$OUT_FILE"
grep -q '"name":"search_commits"' "$OUT_FILE"
grep -q '"name":"summarize_blame"' "$OUT_FILE"
grep -q '"name":"summarize_diff_stat"' "$OUT_FILE"
grep -q '"name":"find_change_hotspots"' "$OUT_FILE"
grep -q '"name":"find_cochange_files"' "$OUT_FILE"
grep -q 'repo-history.v1' "$OUT_FILE"
grep -q 'repo-history-measurement.v1' "$OUT_FILE"
if rg -q 'line two changed|export const beta|/Users/' "$OUT_FILE"; then
  echo "repo-history-mcp smoke leaked raw body or absolute path" >&2
  exit 1
fi
echo "repo-history-mcp smoke ok"
