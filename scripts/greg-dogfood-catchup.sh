#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DAYS="${HWAI_GREG_DOGFOOD_CATCHUP_DAYS:-7}"
END_DATE="$(date +%F)"
FORCE="0"

usage() {
  cat <<USAGE
Usage:
  scripts/greg-dogfood-catchup.sh [--days=7] [--end-date=YYYY-MM-DD] [--force]

Backfills Greg MacBook HWAI Context Router daily reports for missed days, then
refreshes readiness and weekly rollup artifacts.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days=*)
      DAYS="${1#*=}"
      shift
      ;;
    --days)
      DAYS="${2:-}"
      shift 2
      ;;
    --end-date=*)
      END_DATE="${1#*=}"
      shift
      ;;
    --end-date)
      END_DATE="${2:-}"
      shift 2
      ;;
    --force)
      FORCE="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || (( DAYS < 1 || DAYS > 31 )); then
  echo "Invalid --days=$DAYS; expected 1..31" >&2
  exit 2
fi

if ! [[ "$END_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Invalid --end-date=$END_DATE; expected YYYY-MM-DD" >&2
  exit 2
fi

DATES_TEXT="$(node - "$END_DATE" "$DAYS" <<'NODE'
const endDate = process.argv[2];
const days = Number(process.argv[3]);
function addDays(dateIso, offset) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
for (let i = days - 1; i >= 0; i -= 1) {
  console.log(addDays(endDate, -i));
}
NODE
)"

BASE_DIR="$HOME/.hwai/token-efficiency-platform/daily"
generated=0
skipped=0

first_day=""
while IFS= read -r day; do
  [[ -n "$day" ]] || continue
  if [[ -z "$first_day" ]]; then
    first_day="$day"
  fi
  manifest="$BASE_DIR/$day/hwai-utility-mcp-daily-manifest-$day.json"
  note="$BASE_DIR/$day/greg-dogfood-note-$day.md"
  coverage="$BASE_DIR/$day/hwai-mcp-coverage-$day.json"
  if [[ "$FORCE" == "1" || ! -f "$manifest" || ! -f "$note" || ! -f "$coverage" ]]; then
    "$ROOT_DIR/scripts/greg-dogfood-daily-note.sh" --date="$day" >/dev/null
    generated=$((generated + 1))
  else
    skipped=$((skipped + 1))
  fi
done <<<"$DATES_TEXT"

readiness_md="$BASE_DIR/greg-dogfood-measurement-readiness-$END_DATE.md"
"$ROOT_DIR/scripts/greg-dogfood-measurement-readiness.mjs" \
  --end-date="$END_DATE" \
  --days="$DAYS" \
  --out="$readiness_md" \
  --json-out="${readiness_md%.md}.json" >/dev/null

"$ROOT_DIR/scripts/greg-dogfood-weekly-rollup.mjs" \
  --end-date="$END_DATE" \
  --days="$DAYS" >/dev/null

"$ROOT_DIR/scripts/greg-dogfood-review-queue.mjs" \
  --end-date="$END_DATE" \
  --days="$DAYS" >/dev/null

echo "Greg dogfood catch-up complete."
echo "Window: $first_day..$END_DATE"
echo "Generated/refreshed days: $generated"
echo "Already complete days: $skipped"
echo "Readiness: $readiness_md"
echo "Weekly rollup: $BASE_DIR/greg-dogfood-weekly-rollup-$END_DATE.md"
echo "Review queue: $BASE_DIR/greg-dogfood-review-queue-$END_DATE.md"

# Heartbeat (Phase 2 fold-in): on successful catch-up, record a small
# liveness file in the standalone-collector dir so staleness is detectable
# without parsing the daily tree. Best-effort: never fail the run on this.
HEARTBEAT_DIR="${HWAI_TEC_INSTALL_DIR:-$HOME/.hwai/token-efficiency-collector}"
if [[ -d "$HEARTBEAT_DIR" ]]; then
  readiness_json="${readiness_md%.md}.json"
  node - "$HEARTBEAT_DIR/last_success.json" "$first_day" "$END_DATE" "$readiness_json" <<'NODE' || true
const fs = require("node:fs");
const [outPath, start, end, readinessJson] = process.argv.slice(2);
let gates = null;
let status = null;
try {
  const r = JSON.parse(fs.readFileSync(readinessJson, "utf8"));
  status = r.status || null;
  gates = Array.isArray(r.gates)
    ? r.gates.map((g) => ({ name: g.name, passed: g.passed === true }))
    : null;
} catch {
  /* readiness json may be absent on a fresh window; heartbeat still useful */
}
const payload = {
  schema_version: "hwai-token-efficiency-collector-heartbeat.v1",
  ts: new Date().toISOString(),
  window: { start, end },
  status,
  gates,
};
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
NODE
fi
