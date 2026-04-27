#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/dependency-risk-mcp"
TMP_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/dependency-risk-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
SMOKE_DATE="$("$NODE_BIN" -e 'console.log(new Date().toISOString().slice(0, 10))')"
trap 'rm -rf "$TMP_DIR" "$OUT_FILE" "$CACHE_DIR" "${REDUCED_CACHE_DIR:-}"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

cat > "$TMP_DIR/package.json" <<'JSON'
{
  "name": "dependency-risk-smoke",
  "version": "1.0.0",
  "dependencies": { "leftpad": "^1.0.0", "risky-lib": "^1.0.0" },
  "devDependencies": { "vitest": "^1.0.0" }
}
JSON
cat > "$TMP_DIR/baseline-lock.json" <<'JSON'
{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "dependency-risk-smoke", "version": "1.0.0" },
    "node_modules/leftpad": { "name": "leftpad", "version": "1.0.0", "license": "MIT", "resolved": "https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz", "integrity": "sha512-leftpad" },
    "node_modules/risky-lib": { "name": "risky-lib", "version": "1.0.0", "license": "MIT", "resolved": "https://registry.npmjs.org/risky-lib/-/risky-lib-1.0.0.tgz", "integrity": "sha512-risky" }
  }
}
JSON
cat > "$TMP_DIR/package-lock.json" <<'JSON'
{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "dependency-risk-smoke", "version": "1.0.0" },
    "node_modules/leftpad": { "name": "leftpad", "version": "2.0.0", "license": "MIT", "resolved": "https://registry.npmjs.org/leftpad/-/leftpad-2.0.0.tgz", "integrity": "sha512-leftpad2" },
    "node_modules/risky-lib": { "name": "risky-lib", "version": "1.1.0", "license": "AGPL-3.0", "resolved": "http://packages.example/risky-lib-1.1.0.tgz", "hasInstallScript": true },
    "node_modules/new-lib": { "name": "new-lib", "version": "1.0.0", "resolved": "git+ssh://git.example/new-lib.git" }
  }
}
JSON
cat > "$TMP_DIR/audit.json" <<'JSON'
{
  "vulnerabilities": {
    "risky-lib": { "name": "risky-lib", "severity": "high", "via": [{"source": 1}], "effects": [], "range": "<1.2.0", "fixAvailable": true }
  },
  "metadata": { "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0, "total": 1 } }
}
JSON
cat > "$TMP_DIR/audit-fix-output.txt" <<'TXT'
add optional-platform 1.0.0
{
  "added": 1,
  "removed": 0,
  "changed": 1,
  "audited": 4,
  "funding": 1,
  "audit": {
    "vulnerabilities": {
      "risky-lib": {
        "name": "risky-lib",
        "severity": "high",
        "isDirect": true,
        "via": [{"source": 1}],
        "effects": [],
        "range": "<1.2.0",
        "fixAvailable": { "name": "risky-lib", "version": "2.0.0", "isSemVerMajor": true }
      }
    },
    "metadata": { "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0, "total": 1 } }
  }
}
TXT
cat > "$TMP_DIR/osv.json" <<'JSON'
{
  "results": [
    { "packages": [ { "package": { "name": "risky-lib", "version": "1.1.0" }, "vulnerabilities": [ { "id": "GHSA-risky", "aliases": ["CVE-2026-0001"] } ] } ] }
  ]
}
JSON
cat > "$TMP_DIR/registry.json" <<'JSON'
{
  "packages": {
    "leftpad": { "latest_version": "2.0.0", "created": "2015-01-01T00:00:00.000Z", "modified": "2026-01-01T00:00:00.000Z" },
    "risky-lib": { "latest_version": "2.0.0", "created": "2017-01-01T00:00:00.000Z", "modified": "2024-01-01T00:00:00.000Z", "deprecated": true }
  }
}
JSON

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dependency-risk-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | DEPENDENCY_RISK_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

base_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
diff_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], baseline_lockfile_path: "baseline-lock.json", current_lockfile_path: "package-lock.json", max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
audit_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], audit_json_path: "audit.json", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
audit_fix_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], audit_fix_output_path: "audit-fix-output.txt", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
osv_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], osv_json_path: "osv.json", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
age_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], registry_metadata_path: "registry.json", metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
measurement_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ date: process.argv[1], metadata: { source: "smoke-local" } }))' "$SMOKE_DATE")"
reduced_measurement_payload="$("$NODE_BIN" -e 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_measurement_report", arguments: { date: process.argv[1], metadata: { source: "smoke-local-reduced-path" } } } }))' "$SMOKE_DATE")"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 summarize_lockfile_diff "$diff_args")"
call_mcp "$(call_tool 4 check_licenses "$base_args")"
call_mcp "$(call_tool 5 run_npm_audit "$audit_args")"
call_mcp "$(call_tool 6 summarize_npm_audit_fix_plan "$audit_fix_args")"
call_mcp "$(call_tool 7 run_osv_scanner "$osv_args")"
call_mcp "$(call_tool 8 package_age_report "$age_args")"
call_mcp "$(call_tool 9 run_npm_audit "$base_args")"
call_mcp "$(call_tool 10 summarize_supply_chain_risk "$base_args")"
call_mcp "$(call_tool 11 get_measurement_report "$measurement_args")"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dependency-risk-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' "$reduced_measurement_payload"
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" DEPENDENCY_RISK_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"summarize_lockfile_diff"' "$OUT_FILE"
grep -q '"name":"run_npm_audit"' "$OUT_FILE"
grep -q '"name":"summarize_npm_audit_fix_plan"' "$OUT_FILE"
grep -q '"name":"run_osv_scanner"' "$OUT_FILE"
grep -q '"name":"check_licenses"' "$OUT_FILE"
grep -q '"name":"package_age_report"' "$OUT_FILE"
grep -q '"name":"summarize_supply_chain_risk"' "$OUT_FILE"
grep -q 'dependency-risk.v0.1' "$OUT_FILE"
grep -q 'dependency-risk-measurement.v0.1' "$OUT_FILE"
grep -q 'added_dependencies_count' "$OUT_FILE"
grep -q 'disallowed_license_count' "$OUT_FILE"
grep -q 'vulnerability_count' "$OUT_FILE"
grep -q 'semver_major_fix_count' "$OUT_FILE"
grep -q 'action_prelude_lines_count' "$OUT_FILE"
grep -q 'osv_vulnerability_count' "$OUT_FILE"
grep -q 'stale_package_count' "$OUT_FILE"
grep -q 'npm_audit_skipped_count' "$OUT_FILE"
grep -q 'supply_chain_risk_count' "$OUT_FILE"
grep -q 'install_script_packages_count' "$OUT_FILE"
if rg -q 'packages.example/risky-lib-1.1.0.tgz|git.example/new-lib.git' "$OUT_FILE"; then
  echo "dependency-risk-mcp smoke leaked raw resolved URL" >&2
  exit 1
fi
if rg -q '/Users/|'"$TMP_DIR" "$OUT_FILE"; then
  echo "dependency-risk-mcp smoke leaked raw local path" >&2
  exit 1
fi
echo "dependency-risk-mcp smoke ok"
