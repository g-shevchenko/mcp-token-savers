#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/contract-schema-mcp"
TMP_DIR="$(mktemp -d)"
CACHE_DIR="$(mktemp -d)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/contract-schema-mcp-smoke.XXXXXX")"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
trap 'rm -rf "$TMP_DIR" "$CACHE_DIR" "$OUT_FILE" "${REDUCED_CACHE_DIR:-}"' EXIT

cd "$SERVICE_DIR"
npm run build >/dev/null

mkdir -p "$TMP_DIR/src" "$TMP_DIR/contracts"
cat > "$TMP_DIR/contracts/openapi.json" <<'JSON'
{
  "openapi": "3.1.0",
  "paths": {
    "/users": {
      "get": { "operationId": "listUsers", "responses": { "200": { "description": "ok" } } },
      "post": {
        "operationId": "createUser",
        "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/UserInput" } } } },
        "responses": { "201": { "description": "created" } }
      }
    }
  },
  "components": {
    "schemas": {
      "UserInput": {
        "type": "object",
        "required": ["email"],
        "properties": { "email": { "type": "string" }, "age": { "type": "number" } }
      }
    }
  }
}
JSON
cat > "$TMP_DIR/src/contracts.ts" <<'TS'
import { z } from "zod";

export const UserInputSchema = z.object({
  email: z.string().email(),
  age: z.number().optional(),
});
TS
cat > "$TMP_DIR/.env.example" <<'ENV'
API_BASE_URL=
TWENTY_API_KEY=
export OPTIONAL_ENV=
ENV
cat > "$TMP_DIR/src/env.ts" <<'TS'
export const apiBase = process.env.API_BASE_URL;
export const missing = process.env.MISSING_ENV;
const { OPTIONAL_ENV: optionalEnv } = process.env;
export const optional = optionalEnv;
TS

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
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contract-schema-smoke","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    printf '%s\n' "$payload"
  } | CONTRACT_SCHEMA_CACHE_DIR="$CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null
}

scan_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], max_files: 80, max_findings: 20, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"
baseline_args="$("$NODE_BIN" -e '
const repoRoot = process.argv[1];
const baseline = {
  openapi: {
    operations: [
      { method: "GET", path_template: "/users", required_params_count: 0, source_path: "contracts/openapi.json" },
      { method: "DELETE", path_template: "/users/{id}", required_params_count: 1, source_path: "contracts/openapi.json" }
    ],
    schemas: [
      { schema_name: "UserInput", source_path: "contracts/openapi.json", required_fields: ["email", "legacy"], properties_count: 2 }
    ]
  },
  zod: { schemas: [] },
  env: {
    declared_env_vars: ["API_BASE_URL", "REMOVED_ENV"],
    used_env_vars: ["API_BASE_URL"],
    missing_env_examples: [],
    unused_declared_env_vars: ["REMOVED_ENV"],
    source_files: []
  }
};
console.log(JSON.stringify({ repo_root: repoRoot, baseline, max_files: 80, max_findings: 20, metadata: { source: "smoke-local" } }));
' "$TMP_DIR")"
validation_args="$("$NODE_BIN" -e 'console.log(JSON.stringify({ repo_root: process.argv[1], schema: { type: "object", required: ["email"], properties: { email: { type: "string" } } }, payload_sample: { age: 31 }, metadata: { source: "smoke-local" } }))' "$TMP_DIR")"

call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
call_mcp "$(call_tool 3 index_openapi "$scan_args")"
call_mcp "$(call_tool 4 index_zod "$scan_args")"
call_mcp "$(call_tool 5 index_env_contracts "$scan_args")"
call_mcp "$(call_tool 6 create_contract_snapshot "$scan_args")"
call_mcp "$(call_tool 7 validate_payload_sample "$validation_args")"
call_mcp "$(call_tool 8 summarize_breaking_changes "$baseline_args")"
call_mcp "$(call_tool 9 get_measurement_report '{"date":"2026-04-25","metadata":{"source":"smoke-local"}}')"

REDUCED_CACHE_DIR="$(mktemp -d)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contract-schema-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_measurement_report","arguments":{"date":"2026-04-25","metadata":{"source":"smoke-local-reduced-path"}}}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" CONTRACT_SCHEMA_CACHE_DIR="$REDUCED_CACHE_DIR" "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

cat "$OUT_FILE"

grep -q '"name":"index_openapi"' "$OUT_FILE"
grep -q '"name":"index_zod"' "$OUT_FILE"
grep -q '"name":"index_env_contracts"' "$OUT_FILE"
grep -q '"name":"create_contract_snapshot"' "$OUT_FILE"
grep -q '"name":"diff_contracts"' "$OUT_FILE"
grep -q '"name":"validate_payload_sample"' "$OUT_FILE"
grep -q '"name":"summarize_breaking_changes"' "$OUT_FILE"
grep -q 'contract-schema.v0.1' "$OUT_FILE"
grep -q 'contract-schema-measurement.v0.1' "$OUT_FILE"
grep -q 'operations_count' "$OUT_FILE"
grep -q 'zod_schemas_count' "$OUT_FILE"
grep -q 'missing_env_examples_count' "$OUT_FILE"
grep -q 'validation_errors_count' "$OUT_FILE"
grep -q 'breaking_changes_count' "$OUT_FILE"
if rg -q 'process\\.env\\.MISSING_ENV|z\\.string\\(\\)\\.email|/Users/' "$OUT_FILE"; then
  echo "contract-schema-mcp smoke leaked raw code body or absolute path" >&2
  exit 1
fi
echo "contract-schema-mcp smoke ok"
