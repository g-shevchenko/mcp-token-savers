#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/retrieval-mcp"
NODE_BIN="$(command -v node)"
SMOKE_CACHE_DIR="$(mktemp -d /tmp/retrieval-mcp-smoke.XXXXXX)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/retrieval-mcp-smoke.XXXXXX")"
PATH_OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/retrieval-mcp-path-smoke.XXXXXX")"
STDIO_OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/retrieval-mcp-local-stdio-path-smoke.XXXXXX")"

cleanup() {
  rm -rf "$SMOKE_CACHE_DIR"
  rm -f "$OUT_FILE" "$PATH_OUT_FILE" "$STDIO_OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

cd "$ROOT_DIR"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"retrieval-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"retrieve_context","arguments":{"query":"context prep mcp health request log","root_path":'
  printf '%s' "$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$ROOT_DIR")"
  printf ',"include_globs":["services/context-prep-mcp/**"],"max_files":5,"max_snippets":6,"max_chars":6000,"metadata":{"source":"smoke-local","surface":"smoke"}}}}\n'
  printf '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_repo_map","arguments":{"root_path":'
  printf '%s' "$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$ROOT_DIR")"
  printf ',"include_globs":["services/retrieval-mcp/**"],"max_files":24,"max_chars":2000,"metadata":{"source":"smoke-local","surface":"smoke"}}}}\n'
} | RETRIEVAL_CACHE_DIR="$SMOKE_CACHE_DIR" node "$SERVICE_DIR/dist/index.js" | tee "$OUT_FILE"

grep -q '"name":"retrieve_context"' "$OUT_FILE"
grep -q '"name":"get_repo_map"' "$OUT_FILE"
grep -q 'retrieval.v1' "$OUT_FILE"
grep -q 'retrieval-repo-map.v1' "$OUT_FILE"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"retrieval-path-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"retrieve_context","arguments":{"query":"retrieval mcp ripgrep command path","root_path":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$ROOT_DIR")"
  printf ',"include_globs":["services/retrieval-mcp/**"],"max_files":3,"max_snippets":4,"max_chars":3000,"metadata":{"source":"smoke-local-path","surface":"smoke"}}}}\n'
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_repo_map","arguments":{"root_path":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$ROOT_DIR")"
  printf ',"include_globs":["services/retrieval-mcp/**"],"max_files":8,"max_chars":1200,"metadata":{"source":"smoke-local-path","surface":"smoke"}}}}\n'
} | PATH="/usr/bin:/bin" RETRIEVAL_CACHE_DIR="$SMOKE_CACHE_DIR" "$NODE_BIN" "$SERVICE_DIR/dist/index.js" | tee "$PATH_OUT_FILE"

grep -q 'retrieval.v1' "$PATH_OUT_FILE"
grep -q 'retrieval-repo-map.v1' "$PATH_OUT_FILE"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"retrieval-local-stdio-path-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"retrieve_context","arguments":{"query":"retrieval local stdio node rg path proof","root_path":'
  printf '%s' "$("$NODE_BIN" -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$ROOT_DIR")"
  printf ',"include_globs":["services/retrieval-mcp/**"],"max_files":3,"max_snippets":3,"max_chars":2200,"metadata":{"source":"smoke-local-stdio-path","surface":"smoke"}}}}\n'
} | PATH="/usr/bin:/bin" RETRIEVAL_CACHE_DIR="$SMOKE_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee "$STDIO_OUT_FILE"

grep -q 'retrieval.v1' "$STDIO_OUT_FILE"
echo "retrieval-mcp smoke ok"
