#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATE="$(date +%F)"
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date=*)
      DATE="${1#*=}"
      shift
      ;;
    --date)
      DATE="${2:-}"
      shift 2
      ;;
    --out-dir=*)
      OUT_DIR="${1#*=}"
      shift
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$DATE" ]]; then
  echo "--date cannot be empty" >&2
  exit 2
fi

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$HOME/.hwai/token-efficiency-platform/daily/$DATE"
fi

mkdir -p "$OUT_DIR"

"$ROOT_DIR/scripts/token-efficiency-report.sh" \
  --date="$DATE" \
  --out-dir="$OUT_DIR" >/tmp/hwai-greg-dogfood-report-"$DATE".json

NOTE_PATH="$OUT_DIR/greg-dogfood-note-$DATE.md"
MANIFEST_PATH="$OUT_DIR/hwai-utility-mcp-daily-manifest-$DATE.json"
DIGEST_PATH="$OUT_DIR/hwai-utility-mcp-digest-$DATE.md"
COVERAGE_PATH="$OUT_DIR/hwai-mcp-coverage-$DATE.md"
COVERAGE_JSON_PATH="$OUT_DIR/hwai-mcp-coverage-$DATE.json"
READINESS_PATH="$HOME/.hwai/token-efficiency-platform/daily/greg-dogfood-measurement-readiness-$DATE.md"
FULL_PROFILE_SMOKE_PATH="$HOME/.hwai/token-efficiency-platform/full-profile-smoke/$DATE/hwai-mcp-full-profile-smoke-$DATE.md"
FULL_PROFILE_SMOKE_LINE=""
AUTOMEASUREMENT_SUMMARY=""

"$ROOT_DIR/scripts/hwai-mcp-coverage-report.mjs" \
  --date="$DATE" \
  --profile=full \
  --daily-manifest="$MANIFEST_PATH" \
  --format=markdown \
  --out="$COVERAGE_PATH" >/dev/null

"$ROOT_DIR/scripts/hwai-mcp-coverage-report.mjs" \
  --date="$DATE" \
  --profile=full \
  --daily-manifest="$MANIFEST_PATH" \
  --format=json \
  --out="$COVERAGE_JSON_PATH" >/dev/null

"$ROOT_DIR/scripts/greg-dogfood-measurement-readiness.mjs" \
  --end-date="$DATE" \
  --days=7 \
  --out="$READINESS_PATH" \
  --json-out="${READINESS_PATH%.md}.json" >/dev/null

if [[ -f "$FULL_PROFILE_SMOKE_PATH" ]]; then
  FULL_PROFILE_SMOKE_LINE="- Full-profile smoke gate: \`$FULL_PROFILE_SMOKE_PATH\`"
fi

AUTOMEASUREMENT_SUMMARY="$(node - "$MANIFEST_PATH" "$COVERAGE_JSON_PATH" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const coverage = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const auto = manifest.automeasurement || {};
const summary = coverage.summary || {};
console.log([
  `- Production-like requests: ${auto.production_like_request_count || 0}`,
  `- Synthetic requests: ${auto.synthetic_request_count || 0}`,
  `- Real production-like requests: ${auto.real_production_like_request_count || 0}`,
  `- Unknown traffic-class requests: ${auto.unknown_request_count || 0}`,
  `- Metadata-labeled coverage: ${auto.metadata_labeled_pct || 0}%`,
  `- Production-like services: ${summary.production_like_services || 0}/${summary.services || 0}`,
  `- Local production-like services: ${summary.local_production_like_services || 0}/${summary.local_services || 0}`,
  `- External measurement-ready services: ${summary.external_measurement_ready || 0}/${summary.external_services || 0}`,
  `- Measured services: ${summary.measured_today || 0}/${summary.services || 0}`,
].join("\n"));
NODE
)"

cat >"$NOTE_PATH" <<EOF
# Greg Dogfood Daily Note - $DATE

Product: **Token Efficiency Platform for Agentic IDEs**  
Technical core: **HWAI Context Router**  
Customer zero: Greg on Greg MacBook

## Report Artifacts

- Daily manifest: \`$MANIFEST_PATH\`
- Token efficiency digest: \`$DIGEST_PATH\`
- 21-MCP coverage report: \`$COVERAGE_PATH\`
- Measurement readiness: \`$READINESS_PATH\`
$FULL_PROFILE_SMOKE_LINE

## Automeasurement Snapshot

$AUTOMEASUREMENT_SUMMARY

## Workflows Used Today

- [ ] \`greg_repo_work\`
- [ ] \`greg_debug_logs\`
- [ ] \`greg_release_review\`
- [ ] \`greg_screenshot_review\`
- [ ] \`greg_eval_proof\`
- [ ] other:

## What Helped

- 

## Misses Or Friction

- 

## Fixture Candidates

- [ ] No fixture candidate today.
- [ ] Retrieval miss:
- [ ] Router false positive/false negative:
- [ ] Compression evidence loss:
- [ ] Long-log summarization miss:
- [ ] Screenshot/visual miss:

## Tomorrow's Tuning Action

- 

## Claim Boundary

This note is internal solo dogfood evidence. Do not publish it as a benchmark
claim without review and leakage checks.
EOF

echo "Greg dogfood daily note written:"
echo "$NOTE_PATH"
echo "Daily report manifest:"
echo "$MANIFEST_PATH"
echo "21-MCP coverage report:"
echo "$COVERAGE_PATH"
