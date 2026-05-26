#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SERVICE_DIR"
npm run build >/dev/null

node <<'NODE'
const { spawn } = require("node:child_process");

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "context-handoff-smoke", version: "1.0.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "ctx_pre_score",
    arguments: { context_window_tokens: 1000000, estimated_context_tokens: 720000 },
  },
});

setTimeout(() => child.kill("SIGTERM"), 500);

child.on("close", () => {
  const messages = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  const tools = messages.find((message) => message.id === 2);
  const call = messages.find((message) => message.id === 3);
  const toolCount = tools?.result?.tools?.length || 0;
  const text = call?.result?.content?.[0]?.text || "";
  const ok = toolCount >= 5 && text.includes('"gate": "handoff_required"');
  if (!ok) {
    console.error(JSON.stringify({ toolCount, text, stderr }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "passed", tool_count: toolCount, pre_score: "handoff_required" }, null, 2));
});
NODE
