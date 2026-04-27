#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/vision-mcp"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CACHE_DIR="$(mktemp -d)"
REDUCED_CACHE_DIR="$(mktemp -d)"
PORT_FILE="$(mktemp)"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/vision-mcp-smoke.XXXXXX")"
REPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/vision-mcp-smoke-report.XXXXXX")"
SMOKE_DATE="$("$NODE_BIN" -e 'console.log(new Date().toISOString().slice(0, 10))')"

cd "$SERVICE_DIR"
npm run build >/dev/null

"$NODE_BIN" - "$PORT_FILE" <<'NODE' &
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
    if (req.url !== "/smoke.png") {
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
SERVER_PID="$!"
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$CACHE_DIR" "$REDUCED_CACHE_DIR"; rm -f "$PORT_FILE" "$OUT_FILE" "$REPORT_FILE"' EXIT

for _ in $(seq 1 50); do
  if [[ -s "$PORT_FILE" ]]; then
    break
  fi
  sleep 0.1
done

PORT="$(cat "$PORT_FILE")"
SCREENSHOT_URL="http://127.0.0.1:${PORT}/smoke.png"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vision-smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  "$NODE_BIN" - "$SCREENSHOT_URL" <<'NODE'
const url = process.argv[2];
console.log(JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "prepare_screenshot",
    arguments: {
      url,
      context: "local stdio smoke",
      task_intent: "bug_report",
      metadata: { source: "smoke-local", page_url: "http://local.invalid/smoke" }
    }
  }
}));
NODE
} | ALLOW_ANY_IMAGE_URL=1 \
  VISION_MCP_CACHE_DIR="$CACHE_DIR" \
  VISION_MCP_ENABLE_OCR=0 \
  "$SERVICE_DIR/scripts/local-stdio.sh" | tee "$OUT_FILE" >/dev/null

grep -q '"name":"prepare_screenshot"' "$OUT_FILE"
grep -q '"name":"prepare_screenshot_diff"' "$OUT_FILE"
grep -q 'vision-mcp.v3' "$OUT_FILE"
grep -q 'screenshot-prep' "$OUT_FILE"

if rg -q 'smoke.png|/tmp/|'"$CACHE_DIR" "$CACHE_DIR/requests.jsonl"; then
  echo "vision-mcp smoke leaked raw screenshot path/url into request log" >&2
  exit 1
fi

node ./scripts/measurement-report.mjs \
  --date="$SMOKE_DATE" \
  --log="$CACHE_DIR/requests.jsonl" \
  --format=pantheon \
  --out="$REPORT_FILE" >/dev/null

"$NODE_BIN" - "$REPORT_FILE" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.safe_for_pantheon !== true) process.exit(1);
if (report.summary.requests !== 1) process.exit(1);
if (report.summary.proof_requests !== 1) process.exit(1);
if (report.summary.production_like_requests !== 0) process.exit(1);
if (report.by_traffic_class?.proof?.requests !== 1) process.exit(1);
NODE

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vision-smoke-reduced-path","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | PATH="/usr/bin:/bin" NODE_BIN="$NODE_BIN" VISION_MCP_CACHE_DIR="$REDUCED_CACHE_DIR" \
  "$SERVICE_DIR/scripts/local-stdio.sh" | tee -a "$OUT_FILE" >/dev/null

grep -q '"name":"prepare_screenshot"' "$OUT_FILE"
echo "vision-mcp smoke ok"
