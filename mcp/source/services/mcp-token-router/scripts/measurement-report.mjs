#!/usr/bin/env node
// Minimal measurement report for mcp-token-router.
// The router is deterministic (no LLM in the routing path), so there are no
// per-call token savings to aggregate. This script exists to satisfy the
// `measurement:report` script contract required by the repo doctor.

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
const allowed = new Set(["json", "pantheon"]);
if (!allowed.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowed).join(", ")}`);
  process.exit(1);
}

const report = {
  service: "mcp-token-router",
  description: "Deterministic compressor routing MCP — no LLM in the routing path",
  measurement_type: "deterministic",
  note: "Routing decisions are rule-based, not LLM-based. No per-call token savings to aggregate.",
  date: argValue("--date") || new Date().toISOString().slice(0, 10),
};

const payload = format === "pantheon" ? { service: report.service, aggregate_only: true } : report;
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
