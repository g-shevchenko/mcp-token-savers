#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${HWAI_GREG_SMOKE_SOURCE:-greg_codex_synthetic_workflow}"
SURFACE="${HWAI_GREG_SMOKE_SURFACE:-codex}"
TRAFFIC_CLASS="${HWAI_GREG_SMOKE_TRAFFIC_CLASS:-production_like}"
DATE="${HWAI_GREG_SMOKE_DATE:-$(date -u +%F)}"
OUT_DIR="${HWAI_GREG_SMOKE_OUT_DIR:-/tmp/hwai-greg-dogfood-smoke}"
TMP_DIR="$OUT_DIR/tmp"
VISION_PORT_FILE="$OUT_DIR/vision-port"
VISION_SERVER_PID=""

mkdir -p "$OUT_DIR"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
rm -f "$VISION_PORT_FILE"

cleanup() {
  if [[ -n "$VISION_SERVER_PID" ]]; then
    kill "$VISION_SERVER_PID" 2>/dev/null || true
    wait "$VISION_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

json_string() {
  node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$1"
}

metadata_json() {
  printf '{"source":%s,"surface":%s,"traffic_class":%s}' \
    "$(json_string "$SOURCE")" \
    "$(json_string "$SURFACE")" \
    "$(json_string "$TRAFFIC_CLASS")"
}

tool_payload() {
  local id="$1"
  local name="$2"
  local args="$3"
  node - "$id" "$name" "$args" <<'NODE'
const id = Number(process.argv[2]);
const name = process.argv[3];
const args = JSON.parse(process.argv[4]);
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
}));
NODE
}

call_stdio() {
  local wrapper="$1"
  local payload="$2"
  local out_file="$3"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"greg-dogfood-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | "$wrapper" >"$out_file"
}

META="$(metadata_json)"
ROOT_JSON="$(json_string "$ROOT_DIR")"
RETRIEVAL_SERVICE_JSON="$(json_string "$ROOT_DIR/mcp/source/services/retrieval-mcp")"

call_stdio \
  "$ROOT_DIR/mcp/source/services/router-lite-mcp/scripts/local-stdio.sh" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"route_task","arguments":{"text":"найди где реализовано daily token efficiency report and automeasurement doctor","input_kind":"repo_task","metadata":'"$META"'}}}' \
  "$OUT_DIR/router-lite.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/retrieval-mcp/scripts/local-stdio.sh" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"retrieve_context","arguments":{"query":"Greg dogfood automeasurement daily report doctor","root_path":'"$ROOT_JSON"',"include_globs":["scripts/greg-dogfood-*.sh","scripts/greg-dogfood-*.mjs","AUTOMEASUREMENT_PLAN.md","GREG_DOGFOOD_RUNBOOK.md"],"max_files":6,"max_snippets":6,"max_chars":5000,"metadata":'"$META"'}}}' \
  "$OUT_DIR/retrieval.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/context-prep-mcp/scripts/local-stdio.sh" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"compress_context","arguments":{"text":"Greg solo dogfood signal: daily report should be automatic, metadata coverage should be visible, unknown traffic should be treated as product work, and public benchmark claims should stay conservative.","query":"preserve automeasurement evidence and claim boundary","mode":"query","target_ratio":0.6,"metadata":'"$META"'}}}' \
  "$OUT_DIR/context-prep.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/repo-hygiene-mcp/scripts/local-stdio.sh" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scan_complexity_hotspots","arguments":{"repo_root":'"$ROOT_JSON"',"max_files":80,"max_findings":5,"metadata":'"$META"'}}}' \
  "$OUT_DIR/repo-hygiene.json"

STATIC_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
const root = process.argv[2];
const metadata = JSON.parse(process.argv[3]);
const sarif = {
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "greg-smoke" } },
    results: [{
      ruleId: "greg-dogfood-rule",
      level: "warning",
      message: { text: "Synthetic aggregate-only warning" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "scripts/greg-dogfood-smoke.sh" }, region: { startLine: 1 } } }],
    }],
  }],
};
console.log(JSON.stringify({ root_path: root, sarif_json: JSON.stringify(sarif), metadata }));
NODE
)"
REPO_HISTORY_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
console.log(JSON.stringify({ repo_root: process.argv[2], max_commits: 25, max_files: 8, metadata: JSON.parse(process.argv[3]) }));
NODE
)"
QUALITY_GATE_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
console.log(JSON.stringify({
  repo_root: process.argv[2],
  base_ref: "HEAD",
  max_files: 120,
  max_context_pressure_score: 2000,
  max_large_docs: 20,
  large_doc_lines: 400,
  max_findings: 8,
  metadata: JSON.parse(process.argv[3]),
}));
NODE
)"
LANGUAGE_GRAPH_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
console.log(JSON.stringify({ repo_root: process.argv[2], max_files: 80, metadata: JSON.parse(process.argv[3]) }));
NODE
)"
DOCS_HYGIENE_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
console.log(JSON.stringify({
  repo_root: process.argv[2],
  include_globs: ["*.md", "docs/**/*.md", "mcp/docs/**/*.md"],
  max_files: 80,
  max_findings: 8,
  metadata: JSON.parse(process.argv[3]),
}));
NODE
)"
CONTRACT_SCHEMA_ARGS="$(node - "$ROOT_DIR" "$META" <<'NODE'
console.log(JSON.stringify({
  repo_root: process.argv[2],
  env_paths: [".env.example", "scripts/**/*.sh", "mcp/source/services/*/src/**/*.ts"],
  max_files: 120,
  max_findings: 8,
  metadata: JSON.parse(process.argv[3]),
}));
NODE
)"
DEPENDENCY_RISK_ARGS="$(node - "$ROOT_DIR/mcp/source/services/retrieval-mcp" "$META" <<'NODE'
console.log(JSON.stringify({
  repo_root: process.argv[2],
  package_json_path: "package.json",
  lockfile_path: "package-lock.json",
  disallowed_licenses: ["AGPL-3.0", "GPL-3.0"],
  max_findings: 8,
  metadata: JSON.parse(process.argv[3]),
}));
NODE
)"

call_stdio \
  "$ROOT_DIR/mcp/source/services/static-analysis-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 summarize_sarif "$STATIC_ARGS")" \
  "$OUT_DIR/static-analysis.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/repo-history-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 find_change_hotspots "$REPO_HISTORY_ARGS")" \
  "$OUT_DIR/repo-history.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/repo-quality-gate-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 check_context_budget "$QUALITY_GATE_ARGS")" \
  "$OUT_DIR/repo-quality-gate.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/language-graph-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 index_repo "$LANGUAGE_GRAPH_ARGS")" \
  "$OUT_DIR/language-graph.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/docs-hygiene-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 inventory_docs "$DOCS_HYGIENE_ARGS")" \
  "$OUT_DIR/docs-hygiene.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/contract-schema-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 index_env_contracts "$CONTRACT_SCHEMA_ARGS")" \
  "$OUT_DIR/contract-schema.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/dependency-risk-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 check_licenses "$DEPENDENCY_RISK_ARGS")" \
  "$OUT_DIR/dependency-risk.json"

DOCS_SYNC_ROOT="$TMP_DIR/docs-sync"
mkdir -p "$DOCS_SYNC_ROOT/notes"
cat >"$DOCS_SYNC_ROOT/notes/fresh.md" <<'MD'
# Fresh Doc

No action here.
MD
cat >"$DOCS_SYNC_ROOT/notes/stale.md" <<'MD'
# Stale Doc

- [ ] Sync this mirror
MD
node - "$DOCS_SYNC_ROOT" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
const fresh = fs.readFileSync(path.join(root, "notes/fresh.md"), "utf8");
const manifest = {
  pages: [
    { source_path: "notes/fresh.md", title: "Fresh Doc", source_hash: hash(fresh), notion_page_id: "fresh-page", notion_url: "https://notion.local/fresh" },
    { source_path: "notes/stale.md", title: "Stale Doc", source_hash: hash("old body"), notion_page_id: "stale-page", notion_url: "https://notion.local/stale" },
  ],
};
fs.writeFileSync(path.join(root, "mirror.json"), JSON.stringify(manifest, null, 2));
NODE
DOCS_SYNC_ARGS="$(node - "$DOCS_SYNC_ROOT" "$META" <<'NODE'
console.log(JSON.stringify({
  repo_root: process.argv[2],
  doc_roots: ["notes"],
  mirror_manifest_path: "mirror.json",
  max_findings: 8,
  metadata: JSON.parse(process.argv[3]),
}));
NODE
)"
GOLDEN_DATASET_ARGS="$(node - "$META" "$$" <<'NODE'
const metadata = JSON.parse(process.argv[2]);
const suffix = process.argv[3];
console.log(JSON.stringify({
  dataset: "greg-dogfood-router-quality",
  feedback_id: `greg-feedback-${suffix}`,
  call_id: `greg-call-${suffix}`,
  source_service: "retrieval-mcp",
  task_type: "retrieval",
  raw_query: "raw query is hashed by golden dataset request logging",
  query_summary: "Greg-safe retrieval miss candidate for context router tuning.",
  expected_paths: ["scripts/greg-dogfood-smoke.sh"],
  missing_paths: ["scripts/greg-dogfood-smoke.sh"],
  tags: ["greg-dogfood", "retrieval"],
  status: "reviewed",
  metadata,
}));
NODE
)"
AGENT_TRACE_SESSION="greg-dogfood-agent-trace-$$"
AGENT_TRACE_START_ARGS="$(node - "$META" "$AGENT_TRACE_SESSION" <<'NODE'
const metadata = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  session_id: process.argv[3],
  task_id: "greg-dogfood-telemetry-expansion",
  surface: "codex",
  source: "greg_codex_synthetic_workflow",
  title: "Greg dogfood telemetry expansion",
  metadata,
}));
NODE
)"
AGENT_TRACE_STEP_ARGS="$(node - "$META" "$AGENT_TRACE_SESSION" <<'NODE'
const metadata = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  session_id: process.argv[3],
  source: "greg_codex_synthetic_workflow",
  step_type: "product_telemetry",
  status: "ok",
  summary: "Expanded production-like MCP telemetry coverage.",
  raw_tokens_estimate: 1200,
  compact_tokens_estimate: 180,
  saved_tokens_estimate: 1020,
  metadata,
}));
NODE
)"
PLAYWRIGHT_TRACE_ARGS="$(node - "$META" <<'NODE'
const metadata = JSON.parse(process.argv[2]);
const trace = [
  { type: "before", callId: "call@save", class: "Frame", method: "click", startTime: 1000, params: { selector: "text=Save" } },
  { type: "console", messageType: "error", text: "TypeError: save is not a function", location: "app.js:42", time: 1100 },
  {
    type: "resource-snapshot",
    snapshot: {
      _monotonicTime: 1120,
      time: 45,
      request: { method: "POST", url: "https://example.test/api/save?debug=true" },
      response: { status: 500, statusText: "Internal Server Error" },
    },
  },
  { type: "after", callId: "call@save", endTime: 1500, error: { message: "Timeout 5000ms exceeded while waiting for locator" } },
];
console.log(JSON.stringify({ trace_json: JSON.stringify(trace), metadata }));
NODE
)"
VISUAL_TMP_DIR="$TMP_DIR/visual-baseline"
mkdir -p "$VISUAL_TMP_DIR"
(
  cd "$ROOT_DIR/mcp/source/services/visual-baseline-mcp"
  node - "$VISUAL_TMP_DIR/baseline.png" "$VISUAL_TMP_DIR/changed.png" <<'NODE'
const sharp = require("sharp");
const [baselinePath, changedPath] = process.argv.slice(2);

async function writeImage(filePath, changed) {
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
  if (changed) {
    for (let y = 12; y < 24; y += 1) {
      for (let x = 12; x < 24; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 230;
        pixels[offset + 1] = 74;
        pixels[offset + 2] = 66;
      }
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

Promise.all([writeImage(baselinePath, false), writeImage(changedPath, true)]).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
)
VISUAL_BASELINE_ARGS="$(node - "$META" "$VISUAL_TMP_DIR/baseline.png" <<'NODE'
console.log(JSON.stringify({ baseline_name: "greg-dogfood-dashboard", image_path: process.argv[3], metadata: JSON.parse(process.argv[2]) }));
NODE
)"
VISUAL_COMPARE_ARGS="$(node - "$META" "$VISUAL_TMP_DIR/changed.png" <<'NODE'
console.log(JSON.stringify({ baseline_name: "greg-dogfood-dashboard", image_path: process.argv[3], max_changed_pct: 0.1, metadata: JSON.parse(process.argv[2]) }));
NODE
)"

call_stdio \
  "$ROOT_DIR/mcp/source/services/docs-sync-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 compare_repo_notion_mirror "$DOCS_SYNC_ARGS")" \
  "$OUT_DIR/docs-sync.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/golden-dataset-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 add_case_from_feedback "$GOLDEN_DATASET_ARGS")" \
  "$OUT_DIR/golden-dataset.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/agent-trace-mcp/scripts/local-stdio.sh" \
  "$(printf '%s\n%s\n' "$(tool_payload 2 start_trace "$AGENT_TRACE_START_ARGS")" "$(tool_payload 3 record_step "$AGENT_TRACE_STEP_ARGS")")" \
  "$OUT_DIR/agent-trace.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/playwright-trace-mcp/scripts/local-stdio.sh" \
  "$(tool_payload 2 prepare_trace "$PLAYWRIGHT_TRACE_ARGS")" \
  "$OUT_DIR/playwright-trace.json"

call_stdio \
  "$ROOT_DIR/mcp/source/services/visual-baseline-mcp/scripts/local-stdio.sh" \
  "$(printf '%s\n%s\n' "$(tool_payload 2 create_baseline "$VISUAL_BASELINE_ARGS")" "$(tool_payload 3 compare_screenshot "$VISUAL_COMPARE_ARGS")")" \
  "$OUT_DIR/visual-baseline.json"

(
  cd "$ROOT_DIR/mcp/source/services/vision-mcp"
  node - "$VISION_PORT_FILE" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const sharp = require("sharp");
const portFile = process.argv[2];

(async () => {
  const png = await sharp({
    create: {
      width: 220,
      height: 120,
      channels: 4,
      background: { r: 248, g: 249, b: 251, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="220" height="120" xmlns="http://www.w3.org/2000/svg"><rect x="24" y="24" width="172" height="58" rx="4" fill="#ffffff" stroke="#d32f2f" stroke-width="6"/></svg>',
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const server = http.createServer((req, res) => {
    if (req.url !== "/greg-smoke.png") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "image/png");
    res.end(png);
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    fs.writeFileSync(portFile, String(address.port));
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
) &
VISION_SERVER_PID="$!"

for _ in $(seq 1 50); do
  if [[ -s "$VISION_PORT_FILE" ]]; then
    break
  fi
  sleep 0.1
done

VISION_URL="http://127.0.0.1:$(cat "$VISION_PORT_FILE")/greg-smoke.png"
VISION_URL_JSON="$(json_string "$VISION_URL")"

ALLOW_ANY_IMAGE_URL=1 VISION_MCP_ENABLE_OCR=0 call_stdio \
  "$ROOT_DIR/mcp/source/services/vision-mcp/scripts/local-stdio.sh" \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"prepare_screenshot","arguments":{"url":'"$VISION_URL_JSON"',"context":"Greg screenshot review automeasurement smoke","task_intent":"bug_report","metadata":'"$META"'}}}' \
  "$OUT_DIR/vision.json"

grep -q 'router-lite.v' "$OUT_DIR/router-lite.json"
grep -q 'retrieval.v1' "$OUT_DIR/retrieval.json"
grep -q 'context-prep.v1' "$OUT_DIR/context-prep.json"
grep -q 'context-compression' "$OUT_DIR/context-prep.json"
grep -q 'repo-hygiene.v0.1' "$OUT_DIR/repo-hygiene.json"
grep -q 'static-analysis.v1' "$OUT_DIR/static-analysis.json"
grep -q 'repo-history.v1' "$OUT_DIR/repo-history.json"
grep -q 'repo-quality-gate.v0.1' "$OUT_DIR/repo-quality-gate.json"
grep -q 'language-graph.v1' "$OUT_DIR/language-graph.json"
grep -q 'docs-hygiene.v0.1' "$OUT_DIR/docs-hygiene.json"
grep -q 'contract-schema.v0.1' "$OUT_DIR/contract-schema.json"
grep -q 'dependency-risk.v0.1' "$OUT_DIR/dependency-risk.json"
grep -q 'docs-sync.v0.1' "$OUT_DIR/docs-sync.json"
grep -q 'golden-dataset.v1' "$OUT_DIR/golden-dataset.json"
grep -q 'agent-trace.v1' "$OUT_DIR/agent-trace.json"
grep -q 'playwright-trace.v1' "$OUT_DIR/playwright-trace.json"
grep -q 'visual-baseline.v1' "$OUT_DIR/visual-baseline.json"
grep -q 'vision-mcp.v3' "$OUT_DIR/vision.json"

"$ROOT_DIR/scripts/token-efficiency-report.sh" --date="$DATE" --out-dir="$OUT_DIR/report" >"$OUT_DIR/manifest.json"

node - "$OUT_DIR/manifest.json" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const auto = manifest.automeasurement || {};
if (manifest.safe_for_pantheon !== true) {
  throw new Error("expected safe_for_pantheon=true");
}
if ((auto.production_like_request_count || 0) <= 0) {
  throw new Error("expected production_like_request_count > 0");
}
if ((auto.metadata_labeled_pct || 0) <= 0) {
  throw new Error("expected metadata_labeled_pct > 0");
}
const services = manifest.services || {};
const productionLikeServices = Object.entries(services)
  .filter(([, row]) => (row.production_like_request_count || 0) > 0)
  .map(([name]) => name)
  .sort();
if (productionLikeServices.length < 15) {
  throw new Error(`expected at least 15 production-like services, got ${productionLikeServices.length}: ${productionLikeServices.join(", ")}`);
}
console.log(JSON.stringify({ ok: true, productionLikeServices, automeasurement: auto }, null, 2));
NODE

echo "Greg dogfood smoke passed."
echo "Artifacts: $OUT_DIR"
