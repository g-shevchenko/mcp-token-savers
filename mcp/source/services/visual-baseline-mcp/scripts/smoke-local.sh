#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/visual-baseline-mcp"
TMP_DIR="$(mktemp -d)"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/visual-baseline-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cleanup() {
  rm -rf "$TMP_DIR" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"
  rm -f "$OUT_FILE"
}
trap cleanup EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

BASELINE_IMAGE="$TMP_DIR/baseline.png"
CHANGED_IMAGE="$TMP_DIR/changed.png"

"$NODE_BIN" - "$BASELINE_IMAGE" "$CHANGED_IMAGE" <<'NODE'
const sharp = require("sharp");
const [baselinePath, changedPath] = process.argv.slice(2);

async function writeImage(filePath, mutate) {
  const width = 48;
  const height = 48;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    pixels[offset] = 38;
    pixels[offset + 1] = 47;
    pixels[offset + 2] = 63;
    pixels[offset + 3] = 255;
  }
  mutate?.(pixels, width, height);
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

Promise.all([
  writeImage(baselinePath),
  writeImage(changedPath, (pixels, width) => {
    for (let y = 12; y < 24; y += 1) {
      for (let x = 12; x < 24; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 230;
        pixels[offset + 1] = 74;
        pixels[offset + 2] = 66;
      }
    }
  }),
]).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

call_mcp() {
  local payload="$1"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"visual-baseline-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | VISUAL_BASELINE_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

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

baseline_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", image_path: process.argv[1], metadata: { source: "smoke-local" } }))' "$BASELINE_IMAGE")"
approval_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", reviewer: "smoke-local", reason: "stdio proof", metadata: { source: "smoke-local" } }))')"
compare_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", image_path: process.argv[1], max_changed_pct: 0.1, metadata: { source: "smoke-local" } }))' "$CHANGED_IMAGE")"
masked_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", image_path: process.argv[1], ignore_regions: [{ x: 12, y: 12, width: 12, height: 12, label: "dynamic-widget" }], max_changed_pct: 0.1, metadata: { source: "smoke-local" } }))' "$CHANGED_IMAGE")"
preset_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ preset_name: "smoke-dynamic-widget", route: "/smoke-dashboard", component: "dynamic-widget", viewport: "desktop", tags: ["dynamic"], regions: [{ x: 12, y: 12, width: 12, height: 12, label: "dynamic-widget" }], metadata: { source: "smoke-local" } }))')"
preset_masked_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", image_path: process.argv[1], mask_preset_names: ["smoke-dynamic-widget"], max_changed_pct: 0.1, metadata: { source: "smoke-local" } }))' "$CHANGED_IMAGE")"
query_masked_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ baseline_name: "smoke-dashboard", image_path: process.argv[1], mask_preset_query: { route: "/smoke-dashboard", component: "dynamic-widget", viewport: "desktop", tags: ["dynamic"] }, max_changed_pct: 0.1, metadata: { source: "smoke-local" } }))' "$CHANGED_IMAGE")"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 create_baseline "$baseline_args")"
call_mcp "$(call_tool 4 approve_baseline "$approval_args")"
call_mcp "$(call_tool 5 compare_screenshot "$compare_args")"
call_mcp "$(call_tool 6 compare_screenshot "$masked_args")"
call_mcp "$(call_tool 7 save_mask_preset "$preset_args")"
call_mcp "$(call_tool 8 compare_screenshot "$preset_masked_args")"
call_mcp "$(call_tool 9 compare_screenshot "$query_masked_args")"
call_mcp "$(call_tool 10 get_measurement_report '{"date":"2026-04-24","metadata":{"source":"smoke-local"}}')"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"visual-baseline-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-24","metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" VISUAL_BASELINE_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"create_baseline"' "$OUT_FILE"
grep -q '"name":"approve_baseline"' "$OUT_FILE"
grep -q '"name":"save_mask_preset"' "$OUT_FILE"
grep -q '"name":"compare_screenshot"' "$OUT_FILE"
grep -q 'visual-baseline.v1' "$OUT_FILE"
grep -q 'visual-baseline-measurement.v1' "$OUT_FILE"
grep -q 'approval_status.*approved' "$OUT_FILE"
grep -q 'baselines_approved' "$OUT_FILE"
grep -q 'mask_preset_saved' "$OUT_FILE"
grep -q 'mask_presets_applied' "$OUT_FILE"
grep -q 'mask_preset_query_matched' "$OUT_FILE"
grep -q 'mask_preset_query_compares' "$OUT_FILE"
grep -q 'status.*changed' "$OUT_FILE"
grep -q 'status.*passed' "$OUT_FILE"
grep -q 'changed_pixels' "$OUT_FILE"
grep -q 'ignored_changed_pixels' "$OUT_FILE"
grep -q 'safe_for_pantheon.*true' "$OUT_FILE"
echo "visual-baseline-mcp smoke ok"
