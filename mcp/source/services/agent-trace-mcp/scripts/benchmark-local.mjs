#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-trace-mcp-benchmark-"));
process.env.AGENT_TRACE_CACHE_DIR = tempDir;

const { getAgentTraceConfig } = await import("../dist/config.js");
const {
  compareSessions,
  exportPantheonSafe,
  recordStep,
  recordToolResult,
  startTrace,
  summarizeSession,
} = await import("../dist/trace.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getAgentTraceConfig();
const sessionId = "agent-trace-benchmark";
const candidateSessionId = "agent-trace-benchmark-candidate";
const failures = [];

function assert(name, condition, details = {}) {
  if (!condition) {
    failures.push({ name, details });
  }
}

await startTrace(config, {
  session_id: sessionId,
  task_id: "benchmark",
  surface: "codex",
  source: "benchmark-local",
  title: "Sensitive prompt should not leave local export",
});
await recordStep(config, {
  session_id: sessionId,
  source: "benchmark-local",
  step_type: "proof_loop",
  status: "ok",
  summary: "Sensitive prompt should not leave local export",
  raw_tokens_estimate: 1000,
  compact_tokens_estimate: 200,
});
await recordToolResult(config, {
  session_id: sessionId,
  source: "benchmark-local",
  utility_mcp: "context-prep-mcp",
  tool_name: "prep_text",
  status: "ok",
  raw_tokens_estimate: 6000,
  compact_tokens_estimate: 900,
  uncertainty: 0.01,
});
await startTrace(config, {
  session_id: candidateSessionId,
  task_id: "benchmark",
  surface: "codex",
  source: "benchmark-local",
  title: "Candidate sensitive prompt should not leave local diff",
});
await recordStep(config, {
  session_id: candidateSessionId,
  source: "benchmark-local",
  step_type: "proof_loop",
  status: "ok",
  summary: "Candidate sensitive prompt should not leave local diff",
  raw_tokens_estimate: 1000,
  compact_tokens_estimate: 500,
});
await recordToolResult(config, {
  session_id: candidateSessionId,
  utility_mcp: "static-analysis-mcp",
  tool_name: "run_tsc",
  status: "failed",
  raw_tokens_estimate: 6000,
  compact_tokens_estimate: 4500,
  uncertainty: 0.08,
});

const session = await summarizeSession(config, { session_id: sessionId });
const diff = await compareSessions(config, {
  baseline_session_id: sessionId,
  candidate_session_id: candidateSessionId,
});
const pantheon = await exportPantheonSafe(config, { date: new Date().toISOString().slice(0, 10) });
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const pantheonJson = JSON.stringify(pantheon);
const diffJson = JSON.stringify(diff);

assert("session-has-three-events", session.events === 3, { events: session.events });
assert("session-token-savings", session.saved_tokens_estimate === 5900, {
  saved_tokens_estimate: session.saved_tokens_estimate,
});
assert("pantheon-safe", pantheon.safe_for_pantheon === true, pantheon.data_policy);
assert("pantheon-no-sensitive-summary", !pantheonJson.includes("Sensitive prompt"), {});
assert("session-diff-schema", diff.schema_version === "agent-trace-session-diff.v1", { schema_version: diff.schema_version });
assert("session-diff-detects-failed-event", diff.delta.failed_events === 1, diff.delta);
assert("session-diff-detects-unknown-source", diff.delta.unknown_source_count === 1, diff.delta);
assert("session-diff-detects-high-uncertainty", diff.delta.high_uncertainty_count === 1, diff.delta);
assert("session-diff-detects-token-regression", diff.delta.saved_tokens_estimate < 0, diff.delta);
assert("session-diff-no-sensitive-summary", !diffJson.includes("Candidate sensitive prompt"), {});
assert("measurement-sees-sessions", measurement.quality.sessions === 2 && measurement.quality.events === 6, measurement.quality);

const result = {
  benchmark: "agent-trace-local-golden",
  cases: 11,
  failures,
  rows: [
    { name: "session-events", value: session.events },
    { name: "session-diff-failed-events-delta", value: diff.delta.failed_events },
    { name: "session-diff-unknown-source-delta", value: diff.delta.unknown_source_count },
    { name: "session-diff-regressions", value: diff.regressions },
    { name: "session-saved-tokens", value: session.saved_tokens_estimate },
    { name: "pantheon-events", value: pantheon.summary.events },
    { name: "pantheon-unknown-source", value: pantheon.summary.unknown_source_count },
    { name: "measurement-calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
