#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/retrieval-mcp"
HTTP_PORT="${RETRIEVAL_E2E_HTTP_PORT:-3397}"
HTTP_LOG="/tmp/retrieval-mcp-e2e-http.log"
E2E_CACHE_DIR="$(mktemp -d /tmp/retrieval-mcp-e2e.XXXXXX)"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [[ -n "${HTTP_PID:-}" ]] && kill -0 "$HTTP_PID" >/dev/null 2>&1; then
    kill "$HTTP_PID" >/dev/null 2>&1 || true
    wait "$HTTP_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$E2E_CACHE_DIR"
}
trap cleanup EXIT

need node
need npm
need curl

# Resolve rg the SAME way the runtime does (src/command-utils.ts
# resolveLocalCommand). There may be no `rg` on PATH (e.g. only the
# Codex-bundled binary, or Claude Code's shell-function wrapper which a
# child bash can't inherit) — the runtime/e2e still work via an explicit
# path. Mirror that resolution list as the single source of truth and
# export RETRIEVAL_RG_PATH so the spawned node e2e uses the same binary.
if [[ -z "${RETRIEVAL_RG_PATH:-}" ]]; then
  for _rg in \
    "/Applications/Codex.app/Contents/Resources/rg" \
    "/opt/homebrew/bin/rg" "/usr/local/bin/rg" "/usr/bin/rg" \
    "$SERVICE_DIR/node_modules/.bin/rg"; do
    if [[ -x "$_rg" ]]; then RETRIEVAL_RG_PATH="$_rg"; break; fi
  done
  if [[ -z "${RETRIEVAL_RG_PATH:-}" ]] && command -v rg >/dev/null 2>&1; then
    RETRIEVAL_RG_PATH="$(command -v rg)"
  fi
fi
if [[ -z "${RETRIEVAL_RG_PATH:-}" ]]; then
  echo "Missing required command: rg (set RETRIEVAL_RG_PATH or install ripgrep)" >&2
  exit 1
fi
export RETRIEVAL_RG_PATH
echo "[e2e] rg => $RETRIEVAL_RG_PATH"

cd "$SERVICE_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npm run build
npm run smoke
node ./scripts/benchmark-local.mjs

cd "$ROOT_DIR"
RETRIEVAL_CACHE_DIR="$E2E_CACHE_DIR" node - <<'NODE'
import { getRetrievalConfig } from "./services/retrieval-mcp/dist/config.js";
import { retrieveContext } from "./services/retrieval-mcp/dist/retrieval.js";

const config = getRetrievalConfig();
const result = await retrieveContext("retrieval smoke test local stdio", config, {
  root_path: process.cwd(),
  include_globs: ["services/retrieval-mcp/**"],
  include_tests: false,
  max_files: 8,
  max_snippets: 8,
});
const excluded = result.ranked_files.filter((file) =>
  /node_modules|(__tests__|tests?|specs?|\.(test|spec)\.)/i.test(file.path),
);
if (excluded.length > 0) {
  console.error("Unexpected excluded files:", excluded.map((file) => file.path));
  process.exit(1);
}
console.log(
  JSON.stringify({
    local_retrieval_ok: true,
    ranked_files: result.ranked_files.length,
    snippets: result.snippets.length,
    savings_pct: result.input_stats.savings_pct,
  }),
);
NODE

RETRIEVAL_CACHE_DIR="$E2E_CACHE_DIR" node - <<'NODE'
import { getRetrievalConfig } from "./services/retrieval-mcp/dist/config.js";
import { retrieveContext } from "./services/retrieval-mcp/dist/retrieval.js";

const config = getRetrievalConfig();
const result = await retrieveContext(
  "where is retrieval autopilot documented for Claude Cursor Windsurf agents",
  config,
  {
    root_path: process.cwd(),
    task_intent: "docs",
    include_globs: ["AGENTS.md", "CLAUDE.md", ".claude/**", ".cursor/**", ".windsurf/**", "claude/**"],
    max_files: 8,
    max_snippets: 8,
    max_chars: 8000,
  },
);
if (result.schema_version !== "retrieval.v1" || result.snippets.length === 0) {
  console.error("Broad docs retrieval did not return snippets");
  process.exit(1);
}
const worktreeHits = [
  ...result.ranked_files.map((file) => file.path),
  ...result.snippets.map((snippet) => snippet.path),
].filter((filePath) => filePath.includes(".claude/worktrees/"));
if (worktreeHits.length > 0) {
  console.error("Broad docs retrieval returned Claude worktree noise:", worktreeHits);
  process.exit(1);
}
console.log(
  JSON.stringify({
    broad_docs_retrieval_ok: true,
    ranked_files: result.ranked_files.length,
    snippets: result.snippets.length,
    savings_pct: result.input_stats.savings_pct,
  }),
);
NODE

RETRIEVAL_CACHE_DIR="$E2E_CACHE_DIR" node - <<'NODE'
import { getRetrievalConfig } from "./services/retrieval-mcp/dist/config.js";
import { retrieveContext } from "./services/retrieval-mcp/dist/retrieval.js";
import { buildRepoMap } from "./services/retrieval-mcp/dist/repo-map.js";

const config = getRetrievalConfig();
const root = process.cwd();
const [repoMap, retrieval] = await Promise.all([
  buildRepoMap(config, {
    root_path: root,
    include_globs: ["services/retrieval-mcp/**", "notes/**"],
    max_files: 40,
    max_chars: 2400,
  }),
  retrieveContext("MCP roadmap planned list next steps purpose success criteria", config, {
    root_path: root,
    task_intent: "docs",
    include_globs: ["notes/**"],
    max_files: 8,
    max_snippets: 8,
    include_repo_map: true,
    repo_map_max_chars: 2400,
  }),
]);
if (repoMap.schema_version !== "retrieval-repo-map.v1" || !repoMap.repo_map || !repoMap.artifacts.repo_map_file) {
  console.error("Programmatic repo map did not return expected payload");
  process.exit(1);
}
if (!retrieval.repo_map?.repo_map || !retrieval.artifacts.repo_map_file) {
  console.error("retrieve_context did not embed repo_map payload");
  process.exit(1);
}
console.log(
  JSON.stringify({
    repo_map_ok: true,
    files_mapped: repoMap.input_stats.files_mapped,
    repo_map_file: repoMap.artifacts.repo_map_file,
    retrieve_with_repo_map_ok: true,
    top_hit: retrieval.ranked_files[0]?.path || null,
  }),
);
NODE

RETRIEVAL_CACHE_DIR="$E2E_CACHE_DIR" \
RETRIEVAL_TRANSPORT=http \
RETRIEVAL_HTTP_PORT="$HTTP_PORT" \
RETRIEVAL_PUBLIC_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
  node services/retrieval-mcp/dist/index.js --http >"$HTTP_LOG" 2>&1 &
HTTP_PID=$!

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$HTTP_PORT/health" >/tmp/retrieval-mcp-e2e-health.json 2>/dev/null; then
    break
  fi
  sleep 0.2
done

curl -fsS "http://127.0.0.1:$HTTP_PORT/health" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const health = JSON.parse(raw);
  if (!health.ok || health.service !== "retrieval-mcp" || !health.local_first) process.exit(1);
  if (!String(health.cache_dir || "").includes("/tmp/retrieval-mcp-e2e.")) process.exit(1);
  console.log(JSON.stringify({ http_health_ok: true, port: health.transport_mode === "http" ? process.env.RETRIEVAL_E2E_HTTP_PORT || 3397 : null }));
});
'

REST_RETRIEVAL_RESPONSE="$(curl -fsS "http://127.0.0.1:$HTTP_PORT/api/retrieve/context" \
  -H "content-type: application/json" \
  -d "$(node -e '
const payload = {
  query: "context prep mcp health request log",
  root_path: process.cwd(),
  include_globs: ["services/context-prep-mcp/**"],
  max_files: 5,
  max_snippets: 6,
  max_chars: 6000,
  metadata: {
    source: "e2e-rest",
    surface: "e2e-rest"
  }
};
process.stdout.write(JSON.stringify(payload));
')" )"
printf "%s" "$REST_RETRIEVAL_RESPONSE" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(raw);
  if (result.schema_version !== "retrieval.v1" || !result.compact_context || !result.call_id) process.exit(1);
  console.log(JSON.stringify({ rest_retrieval_ok: true, call_id: result.call_id, savings_pct: result.input_stats.savings_pct }));
});
'

curl -fsS "http://127.0.0.1:$HTTP_PORT/api/retrieve/repo-map" \
  -H "content-type: application/json" \
  -d "$(node -e '
const payload = {
  root_path: process.cwd(),
  include_globs: ["services/retrieval-mcp/**", "notes/**"],
  max_files: 40,
  max_chars: 2400,
  metadata: {
    source: "e2e-rest",
    surface: "e2e-rest"
  }
};
process.stdout.write(JSON.stringify(payload));
')" \
  | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(raw);
  if (result.schema_version !== "retrieval-repo-map.v1" || !result.repo_map || !result.artifacts?.repo_map_file) process.exit(1);
  console.log(JSON.stringify({ rest_repo_map_ok: true, files_mapped: result.input_stats.files_mapped, repo_map_file: result.artifacts.repo_map_file }));
});
'

REST_CALL_ID="$(printf "%s" "$REST_RETRIEVAL_RESPONSE" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).call_id));
')"

curl -fsS "http://127.0.0.1:$HTTP_PORT/api/retrieve/feedback" \
  -H "content-type: application/json" \
  -d "$(REST_CALL_ID="$REST_CALL_ID" node -e '
const payload = {
  call_id: process.env.REST_CALL_ID,
  outcome: "partial",
  frontier_had_to_search: true,
  expected_paths: ["services/context-prep-mcp/src/request-log.ts"],
  missing_paths: ["services/context-prep-mcp/src/request-log.ts"],
  notes: "e2e feedback trace; safe metadata only",
  metadata: {
    source: "e2e-rest",
    surface: "e2e-rest"
  }
};
process.stdout.write(JSON.stringify(payload));
')" \
  | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(raw);
  if (result.schema_version !== "retrieval-feedback.v1" || !result.benchmark_candidate) process.exit(1);
  console.log(JSON.stringify({ feedback_ok: true, feedback_id: result.feedback_id }));
});
'

REPORT_DATE="$(date -u +%F)"
curl -fsS "http://127.0.0.1:$HTTP_PORT/api/retrieve/measurements?date=$REPORT_DATE" \
  | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(raw);
  if (result.schema_version !== "retrieval-measurement.v1") process.exit(1);
  if (result.quality.feedback_count < 1 || result.token_savings.saved_tokens_estimate <= 0) process.exit(1);
  if (!result.usage?.by_surface || result.usage.by_surface["e2e-rest"] < 1) process.exit(1);
  if (!result.usage?.by_traffic_class || result.usage.by_traffic_class.proof < 1) process.exit(1);
  if ((result.usage.by_traffic_class.unknown || 0) !== 0) process.exit(1);
  if (!result.traffic?.proof || result.traffic.proof.feedback_count < 1) process.exit(1);
  console.log(JSON.stringify({
    measurement_ok: true,
    saved_tokens_estimate: result.token_savings.saved_tokens_estimate,
    estimated_usd_saved: result.token_savings.estimated_usd_saved,
    feedback_count: result.quality.feedback_count,
    by_surface: result.usage.by_surface,
    by_traffic_class: result.usage.by_traffic_class,
  }));
});
'

node services/retrieval-mcp/scripts/install-local-configs.mjs --dry-run --agents=codex,claude,cursor,windsurf

echo "retrieval-mcp e2e local ok"
