#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureTempCaches() {
  if (hasFlag("--durable")) {
    return null;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwai-playwright-agent-trace-proof-"));
  process.env.PLAYWRIGHT_TRACE_CACHE_DIR ||= path.join(root, "playwright-trace-mcp");
  process.env.AGENT_TRACE_CACHE_DIR ||= path.join(root, "agent-trace-mcp");
  return root;
}

async function ensureRealFixtures() {
  const requested = argValue("--real-fixtures-dir", "");
  const fixturesDir = requested
    ? path.resolve(requested)
    : await fs.mkdtemp(path.join(os.tmpdir(), "playwright-agent-trace-fixture-"));
  const manifestPath = path.join(fixturesDir, "manifest.json");
  try {
    await fs.access(manifestPath);
  } catch {
    await fs.mkdir(fixturesDir, { recursive: true });
    const generated = spawnSync(process.execPath, [
      path.join(repoRoot, "services/playwright-trace-mcp/scripts/generate-real-fixtures.mjs"),
      `--out=${fixturesDir}`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (generated.status !== 0) {
      throw new Error(`real fixture generation failed: ${generated.stderr || generated.stdout}`);
    }
  }
  return {
    fixturesDir,
    manifest: JSON.parse(await fs.readFile(manifestPath, "utf8")),
    source: requested ? "provided" : "generated",
  };
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function assert(name, condition, details = {}) {
  if (!condition) {
    const error = new Error(`Assertion failed: ${name}`);
    error.details = details;
    throw error;
  }
}

function safeToolResult(result) {
  const inputStats = result?.input_stats || {};
  return {
    status: "ok",
    raw_tokens_estimate: inputStats.raw_tokens_estimate || 0,
    compact_tokens_estimate: inputStats.compact_tokens_estimate || 0,
    saved_tokens_estimate: inputStats.saved_tokens_estimate || 0,
  };
}

await ensureTempCaches();

const sessionId = argValue("--session-id", `playwright-agent-trace-proof-${todayUtc()}`);
const taskId = argValue("--task-id", "playwright-agent-trace-proof");
const source = argValue("--source", "benchmark-local");
const fixture = await ensureRealFixtures();
const { fixturesDir, manifest } = fixture;

const { getPlaywrightTraceConfig } = await import(
  path.join(repoRoot, "services/playwright-trace-mcp/dist/config.js")
);
const {
  extractFailureStep,
  prepareTrace,
  prepareTraceScreenshots,
  summarizeNetwork,
} = await import(path.join(repoRoot, "services/playwright-trace-mcp/dist/parsers.js"));
const { getAgentTraceConfig } = await import(path.join(repoRoot, "services/agent-trace-mcp/dist/config.js"));
const {
  exportPantheonSafe,
  recordStep,
  recordToolResult,
  startTrace,
  summarizeSession,
} = await import(path.join(repoRoot, "services/agent-trace-mcp/dist/trace.js"));

const playwrightConfig = getPlaywrightTraceConfig();
const agentConfig = getAgentTraceConfig();
const startedAt = Date.now();

await startTrace(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  title: "Playwright trace proof loop",
  summary: "Playwright trace proof loop with agent-trace linkage; raw trace paths and URLs stay local.",
  tags: ["playwright-trace", "agent-trace", "proof-loop"],
});

await recordStep(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  step_type: "proof_loop",
  status: "ok",
  summary: "Loaded generated local Playwright fixture manifest and started browser-debug proof loop.",
});

const prepared = await prepareTrace(playwrightConfig, {
  trace_zip_path: manifest.trace_zip_path,
  screenshot_paths: [manifest.screenshot_path],
  max_screenshots: 4,
});
await recordToolResult(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  utility_mcp: "playwright-trace-mcp",
  tool_name: "prepare_trace",
  ...safeToolResult(prepared),
});

const harJson = await fs.readFile(manifest.har_path, "utf8");
const network = await summarizeNetwork(playwrightConfig, { har_json: harJson });
await recordToolResult(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  utility_mcp: "playwright-trace-mcp",
  tool_name: "summarize_network",
  ...safeToolResult(network),
});

const failure = await extractFailureStep(playwrightConfig, { trace_zip_path: manifest.trace_zip_path });
await recordToolResult(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  utility_mcp: "playwright-trace-mcp",
  tool_name: "extract_failure_step",
  ...safeToolResult(failure),
});

const screenshots = await prepareTraceScreenshots(playwrightConfig, {
  trace_zip_path: manifest.trace_zip_path,
  screenshot_paths: [manifest.screenshot_path],
  max_screenshots: 4,
});
await recordToolResult(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  utility_mcp: "playwright-trace-mcp",
  tool_name: "prepare_trace_screenshots",
  ...safeToolResult(screenshots),
});

await recordStep(agentConfig, {
  session_id: sessionId,
  task_id: taskId,
  surface: "codex",
  source,
  step_type: "proof_loop",
  status: "ok",
  summary: "Recorded Playwright trace tool results into agent-trace using only aggregate token/status counters.",
  duration_ms: Date.now() - startedAt,
});

const session = await summarizeSession(agentConfig, { session_id: sessionId });
const pantheon = await exportPantheonSafe(agentConfig, { date: todayUtc() });
const pantheonJson = JSON.stringify(pantheon);
const localAgentTraceLogs = [
  await readTextIfExists(agentConfig.eventsLogPath),
  await readTextIfExists(agentConfig.requestLogPath),
].join("\n");
const forbiddenLocalLogValues = [
  fixturesDir,
  manifest.trace_zip_path,
  manifest.har_path,
  manifest.screenshot_path,
  "playwright-trace://",
  "http://127.0.0.1:",
].filter(Boolean);

assert("session-has-playwright-tool-results", session.by_utility_mcp?.["playwright-trace-mcp"] === 4, session.by_utility_mcp);
assert("session-has-no-unknown-source", session.by_source?.unknown === undefined, session.by_source);
assert("pantheon-safe", pantheon.safe_for_pantheon === true, pantheon.data_policy);
assert("pantheon-no-fixture-path", !pantheonJson.includes(fixturesDir), {});
assert("pantheon-no-artifact-url", !pantheonJson.includes("playwright-trace://"), {});
for (const [index, forbidden] of forbiddenLocalLogValues.entries()) {
  assert(`local-agent-trace-log-no-raw-value-${index}`, !localAgentTraceLogs.includes(forbidden), {
    forbidden_kind:
      forbidden === fixturesDir ? "fixtures_dir"
        : forbidden === manifest.trace_zip_path ? "trace_zip_path"
        : forbidden === manifest.har_path ? "har_path"
        : forbidden === manifest.screenshot_path ? "screenshot_path"
        : forbidden.startsWith("http://127.0.0.1:") ? "local_url"
        : "artifact_url",
  });
}
assert("playwright-failure-window-recorded", Boolean(prepared.failure_window), prepared.failure_window);

const result = {
  schema_version: "hwai-playwright-agent-trace-proof.v1",
  status: "passed",
  session_id: sessionId,
  task_id: taskId,
  source,
  fixtures: {
    source: fixture.source,
    real_trace_zip_used: true,
    har_used: true,
    screenshot_used: true,
  },
  playwright: {
    status: prepared.status,
    failure_kind: prepared.failure?.kind || "none",
    failure_window_present: Boolean(prepared.failure_window),
    failure_window_console_errors: prepared.failure_window?.nearby_console_errors || 0,
    failure_window_network_failures: prepared.failure_window?.nearby_network_failures || 0,
    network_failures: prepared.network?.failures || 0,
    slow_requests: network.network?.slow_requests || 0,
    screenshots_prepared: screenshots.image_count || 0,
    saved_tokens_estimate:
      (prepared.input_stats?.saved_tokens_estimate || 0) +
      (network.input_stats?.saved_tokens_estimate || 0) +
      (failure.input_stats?.saved_tokens_estimate || 0) +
      (screenshots.input_stats?.saved_tokens_estimate || 0),
  },
  agent_trace: {
    events: session.events,
    by_event_type: session.by_event_type,
    by_utility_mcp: session.by_utility_mcp,
    saved_tokens_estimate: session.saved_tokens_estimate,
    safe_for_pantheon: pantheon.safe_for_pantheon,
  },
  data_policy: {
    raw_trace_paths_exported: false,
    raw_urls_exported: false,
    artifact_urls_exported_to_pantheon: false,
    local_agent_trace_logs_checked: true,
  },
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
