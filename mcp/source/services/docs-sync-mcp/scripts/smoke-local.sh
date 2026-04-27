#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/docs-sync-mcp"
TMP_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/docs-sync-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
SMOKE_DATE="$("$NODE_BIN" -e 'console.log(new Date().toISOString().slice(0, 10))')"
trap 'rm -rf "$TMP_DIR" "$OUT_FILE" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

mkdir -p "$TMP_DIR/notes"
cat > "$TMP_DIR/notes/fresh.md" <<'MD'
# Fresh Doc

No action here.
MD
cat > "$TMP_DIR/notes/stale.md" <<'MD'
# Stale Doc

- [ ] Sync this mirror
MD
cat > "$TMP_DIR/notes/missing.md" <<'MD'
# Missing Mirror Doc

TODO: create mirror
MD
cat > "$TMP_DIR/DOC_REGISTRY.md" <<'MD'
- `notes/fresh.md`
- `notes/orphan.md`
MD
"$NODE_BIN" - <<'NODE' "$TMP_DIR"
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
const fresh = fs.readFileSync(path.join(root, "notes/fresh.md"), "utf8");
const manifest = {
  pages: [
    { source_path: "notes/fresh.md", title: "Old Fresh Mirror Title", source_hash: hash(fresh), notion_page_id: "fresh-page", notion_url: "https://notion.local/fresh", last_synced_at: "2026-04-01T00:00:00.000Z" },
    { source_path: "notes/stale.md", source_hash: hash("old body"), notion_page_id: "stale-page", notion_url: "https://notion.local/stale", last_synced_at: "2026-04-01T00:00:00.000Z" },
    { source_path: "notes/deleted.md", source_hash: hash("deleted body"), notion_page_id: "deleted-page", notion_url: "https://notion.local/deleted", last_synced_at: "2026-04-01T00:00:00.000Z" }
  ]
};
fs.writeFileSync(path.join(root, "mirror.json"), JSON.stringify(manifest, null, 2));
NODE

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docs-sync-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | DOCS_SYNC_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

base_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], doc_roots: ["notes"], mirror_manifest_path: "mirror.json", max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
registry_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], doc_roots: ["notes"], mirror_manifest_path: "mirror.json", doc_registry_path: "DOC_REGISTRY.md", max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: process.argv[1], metadata: { source: "smoke-local" } }))' "$SMOKE_DATE")"
reduced_measurement_payload="$("$NODE_BIN" -e 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_measurement_report", arguments: { date: process.argv[1], metadata: { source: "smoke-local-reduced-path" } } } }))' "$SMOKE_DATE")"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 compare_repo_notion_mirror "$base_args")"
call_mcp "$(call_tool 4 find_stale_notion_mirrors "$base_args")"
call_mcp "$(call_tool 5 extract_repo_actions "$base_args")"
call_mcp "$(call_tool 6 propose_notion_update "$base_args")"
call_mcp "$(call_tool 7 check_doc_registry "$registry_args")"
call_mcp "$(call_tool 8 get_measurement_report "$measurement_args")"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docs-sync-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' "$reduced_measurement_payload"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" DOCS_SYNC_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"compare_repo_notion_mirror"' "$OUT_FILE"
grep -q '"name":"find_stale_notion_mirrors"' "$OUT_FILE"
grep -q '"name":"extract_repo_actions"' "$OUT_FILE"
grep -q '"name":"propose_notion_update"' "$OUT_FILE"
grep -q '"name":"check_doc_registry"' "$OUT_FILE"
grep -q 'docs-sync.v0.1' "$OUT_FILE"
grep -q 'docs-sync-measurement.v0.1' "$OUT_FILE"
grep -q 'stale_mirrors_count' "$OUT_FILE"
grep -q 'missing_mirror_count' "$OUT_FILE"
grep -q 'title_mismatch_count' "$OUT_FILE"
grep -q 'action_items_count' "$OUT_FILE"
grep -q 'update_candidates_count' "$OUT_FILE"
grep -q 'missing_registry_entries_count' "$OUT_FILE"
if rg -q '/Users/|'"$TMP_DIR"'|https://notion.local' "$OUT_FILE"; then
  echo "docs-sync-mcp smoke leaked raw local path or Notion URL" >&2
  exit 1
fi
echo "docs-sync-mcp smoke ok"
