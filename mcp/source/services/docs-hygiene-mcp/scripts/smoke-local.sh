#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/docs-hygiene-mcp"
TMP_DIR="$(mktemp -d)"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/docs-hygiene-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cleanup() {
  rm -rf "$TMP_DIR" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

mkdir -p "$TMP_DIR/docs"
cat > "$TMP_DIR/README.md" <<'MD'
# Fixture Readme

See [good](docs/good.md), [missing](docs/missing.md), [bad anchor](docs/good.md#missing-anchor), and [duplicate A](docs/duplicate-a.md).
Reference style links: [missing ref][missing-ref] and [bad anchor ref][bad-anchor-ref].

[missing-ref]: docs/reference-missing.md
[bad-anchor-ref]: <docs/good.md#reference-missing-anchor> "Reference title"

Implementation moved away from `src/missing.ts` but this stale reference stayed behind.

Notion is the canonical source of truth for this workflow.
MD
cat > "$TMP_DIR/docs/good.md" <<'MD'
---
owner: docs
---

# Good Doc

## Stable Anchor

A small linked doc.
MD
cat > "$TMP_DIR/docs/orphan.md" <<'MD'
# Orphan Doc

This page has no inbound Markdown link in the scanned fixture.
MD
cat > "$TMP_DIR/docs/duplicate-a.md" <<'MD'
# Duplicate A

## Shared Procedure

Repeated operational guidance should live in one canonical home and every mirror should point back to it.
Agents need a short owner signal, a current source path, and a reviewed replacement before cleanup work starts.
The same checklist appearing in two pages should become a link, not a second independently maintained procedure.
Archive decisions stay advisory until backlinks and external references are checked by a human-visible proof loop.
MD
cat > "$TMP_DIR/docs/duplicate-b.md" <<'MD'
# Duplicate B

## Shared Procedure

Repeated operational guidance should live in one canonical home and every mirror should point back to it.
Agents need a short owner signal, a current source path, and a reviewed replacement before cleanup work starts.
The same checklist appearing in two pages should become a link, not a second independently maintained procedure.
Archive decisions stay advisory until backlinks and external references are checked by a human-visible proof loop.
MD
cat > "$TMP_DIR/docs/frontmatter-gap.md" <<'MD'
# Frontmatter Gap

This page intentionally lacks YAML frontmatter.
MD

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docs-hygiene-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | DOCS_HYGIENE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

scan_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], max_files: 50, max_findings: 20, min_section_lines: 4, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local" } }))')"
reduced_measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), metadata: { source: "smoke-local-reduced-path" } }))')"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 inventory_docs "$scan_args")"
call_mcp "$(call_tool 4 find_broken_links "$scan_args")"
call_mcp "$(call_tool 5 find_broken_anchors "$scan_args")"
call_mcp "$(call_tool 6 find_orphan_docs "$scan_args")"
call_mcp "$(call_tool 7 find_duplicate_sections "$scan_args")"
call_mcp "$(call_tool 8 find_stale_code_references "$scan_args")"
call_mcp "$(call_tool 9 check_doc_frontmatter "$scan_args")"
call_mcp "$(call_tool 10 check_ssot_conflicts "$scan_args")"
call_mcp "$(call_tool 11 propose_doc_merge_or_archive "$scan_args")"
call_mcp "$(call_tool 12 get_measurement_report "$measurement_args")"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docs-hygiene-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  call_tool 13 get_measurement_report "$reduced_measurement_args"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" DOCS_HYGIENE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"inventory_docs"' "$OUT_FILE"
grep -q '"name":"find_broken_links"' "$OUT_FILE"
grep -q '"name":"find_broken_anchors"' "$OUT_FILE"
grep -q '"name":"find_orphan_docs"' "$OUT_FILE"
grep -q '"name":"find_duplicate_sections"' "$OUT_FILE"
grep -q '"name":"find_stale_code_references"' "$OUT_FILE"
grep -q '"name":"check_doc_frontmatter"' "$OUT_FILE"
grep -q '"name":"check_ssot_conflicts"' "$OUT_FILE"
grep -q '"name":"propose_doc_merge_or_archive"' "$OUT_FILE"
grep -q 'docs-hygiene.v0.1' "$OUT_FILE"
grep -q 'docs-hygiene-measurement.v0.1' "$OUT_FILE"
grep -q 'broken_links_count' "$OUT_FILE"
grep -q 'broken_anchors_count' "$OUT_FILE"
grep -q 'docs/reference-missing.md' "$OUT_FILE"
grep -q 'orphan_docs_count' "$OUT_FILE"
grep -q 'duplicate_section_groups' "$OUT_FILE"
grep -q 'stale_references_count' "$OUT_FILE"
grep -q 'ssot_conflicts_count' "$OUT_FILE"
grep -q 'plan_items_count' "$OUT_FILE"
if rg -q 'Repeated operational guidance|Archive decisions stay advisory|/Users/' "$OUT_FILE"; then
  echo "docs-hygiene-mcp smoke leaked raw doc body or absolute path" >&2
  exit 1
fi
if rg -q "$TMP_DIR" "$CACHE_DIR/requests.jsonl"; then
  echo "docs-hygiene-mcp smoke leaked absolute temp path in request log" >&2
  exit 1
fi
echo "docs-hygiene-mcp smoke ok"
