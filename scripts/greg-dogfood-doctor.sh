#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${HWAI_GREG_DOGFOOD_LABEL:-ai.humanswith.hwai-greg-dogfood-daily}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
DATE="${HWAI_GREG_DOGFOOD_DATE:-$(date +%F)}"
DAILY_DIR="$HOME/.hwai/token-efficiency-platform/daily/$DATE"
MANIFEST_PATH="$DAILY_DIR/hwai-utility-mcp-daily-manifest-$DATE.json"
NOTE_PATH="$DAILY_DIR/greg-dogfood-note-$DATE.md"
COVERAGE_PATH="$DAILY_DIR/hwai-mcp-coverage-$DATE.md"
COVERAGE_JSON_PATH="$DAILY_DIR/hwai-mcp-coverage-$DATE.json"

ok=true

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    ok=false
  fi
}

warn_check() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "WARN $name"
  fi
}

check "launchagent-plist-exists" test -f "$PLIST_PATH"
check "launchagent-plist-valid" bash -lc "plutil -lint '$PLIST_PATH' >/dev/null"
check "launchagent-loaded" bash -lc "launchctl print 'gui/$(id -u)/$LABEL' >/dev/null 2>&1"
check "daily-manifest-exists" test -f "$MANIFEST_PATH"
check "daily-note-exists" test -f "$NOTE_PATH"
check "21-mcp-coverage-exists" test -f "$COVERAGE_PATH"
check "21-mcp-coverage-json-exists" test -f "$COVERAGE_JSON_PATH"

if [[ -f "$MANIFEST_PATH" ]]; then
  node - "$MANIFEST_PATH" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const checks = [
  ["manifest-safe-for-pantheon", manifest.safe_for_pantheon === true],
  ["manifest-leakage-scan-passed", manifest.leakage_scan?.passed === true],
  ["manifest-has-automeasurement", Boolean(manifest.automeasurement)],
];
let ok = true;
for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  ok = ok && passed;
}
if (manifest.automeasurement) {
  console.log(`INFO production_like_request_count=${manifest.automeasurement.production_like_request_count || 0}`);
  console.log(`INFO synthetic_request_count=${manifest.automeasurement.synthetic_request_count || 0}`);
  console.log(`INFO real_production_like_request_count=${manifest.automeasurement.real_production_like_request_count || 0}`);
  console.log(`INFO unknown_request_count=${manifest.automeasurement.unknown_request_count || 0}`);
  console.log(`INFO metadata_labeled_pct=${manifest.automeasurement.metadata_labeled_pct || 0}`);
}
process.exit(ok ? 0 : 1);
NODE
else
  ok=false
fi

if [[ -f "$COVERAGE_JSON_PATH" ]]; then
  node - "$COVERAGE_JSON_PATH" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const checks = [
  ["coverage-services-21", report.summary?.services === 21],
  ["coverage-stdio-21", report.summary?.stdio_configured === 21],
  ["coverage-smoke-21", report.summary?.smoke_scripts === 21],
  ["coverage-measurement-21", report.summary?.measurement_scripts === 21],
  ["coverage-no-missing-local-checks", report.summary?.missing_local_checks === 0],
  ["coverage-external-measurement-ready-4", report.summary?.external_measurement_ready === 4],
];
const softChecks = [
  ["coverage-production-like-services-15", (report.summary?.production_like_services || 0) >= 15],
  ["coverage-local-production-like-17", report.summary?.local_production_like_services === 17],
];
let ok = true;
for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  ok = ok && passed;
}
for (const [name, passed] of softChecks) {
  console.log(`${passed ? "PASS" : "WARN"} ${name}`);
}
console.log(`INFO measured_today=${report.summary?.measured_today || 0}`);
console.log(`INFO production_like_services=${report.summary?.production_like_services || 0}`);
console.log(`INFO local_production_like_services=${report.summary?.local_production_like_services || 0}`);
console.log(`INFO external_measurement_ready=${report.summary?.external_measurement_ready || 0}`);
console.log(`INFO external_opt_in=${report.summary?.external_opt_in || 0}`);
process.exit(ok ? 0 : 1);
NODE
else
  ok=false
fi

if ! node "$ROOT_DIR/mcp/bin/hwai-mcp.mjs" doctor \
  --manifest="$ROOT_DIR/mcp/manifest.json" \
  --source-root="$ROOT_DIR/mcp/source" \
  --profile=full >/tmp/hwai-greg-dogfood-doctor-mcp.json; then
  echo "FAIL mcp-full-doctor"
  ok=false
else
  echo "PASS mcp-full-doctor"
fi

if [[ "$ok" == true ]]; then
  echo "Greg dogfood doctor passed."
else
  echo "Greg dogfood doctor found issues." >&2
  exit 1
fi
