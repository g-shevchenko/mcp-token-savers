#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "playwright-trace-mcp-benchmark-"));
process.env.PLAYWRIGHT_TRACE_CACHE_DIR = tempDir;

const { getPlaywrightTraceConfig } = await import("../dist/config.js");
const {
  extractFailureStep,
  prepareTrace,
  prepareTraceScreenshots,
  summarizeConsole,
  summarizeNetwork,
} = await import("../dist/parsers.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getPlaywrightTraceConfig();
const failures = [];
const withReal = process.argv.includes("--with-real");
const realFixturesArg = argValue("--real-fixtures-dir");

function assert(name, condition, details = {}) {
  if (!condition) {
    failures.push({ name, details });
  }
}

async function ensureRealFixtures() {
  const fixturesDir = realFixturesArg
    ? path.resolve(realFixturesArg)
    : await fs.mkdtemp(path.join(os.tmpdir(), "playwright-trace-mcp-real-fixtures-"));
  const manifestPath = path.join(fixturesDir, "manifest.json");
  try {
    await fs.access(manifestPath);
  } catch {
    await fs.mkdir(fixturesDir, { recursive: true });
    const generated = spawnSync(process.execPath, [path.resolve("scripts/generate-real-fixtures.mjs"), `--out=${fixturesDir}`], {
      cwd: path.resolve("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (generated.status !== 0) {
      throw new Error(`real fixture generation failed: ${generated.stderr || generated.stdout}`);
    }
  }
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

const traceRows = [
  { type: "before", callId: "call@1", class: "Page", method: "goto", startTime: 100, params: { url: "https://example.test/dashboard" } },
  { type: "after", callId: "call@1", endTime: 220 },
  { type: "before", callId: "call@2", class: "Frame", method: "click", startTime: 1000, params: { selector: "#refresh" } },
  { type: "console", messageType: "error", text: "ReferenceError: widget is not defined", location: "dashboard.js:10", time: 1040 },
  {
    type: "resource-snapshot",
    snapshot: {
      _monotonicTime: 1050,
      time: 40,
      request: { method: "GET", url: "https://example.test/api/dashboard?token=secret" },
      response: { status: 503, statusText: "Service Unavailable" },
    },
  },
  { type: "after", callId: "call@2", endTime: 1095 },
  { type: "before", callId: "call@3", class: "Frame", method: "click", startTime: 1900, params: { selector: "#missing-after-refresh" } },
  { type: "after", callId: "call@3", endTime: 2400, error: { message: "Timeout 30000ms exceeded" } },
];
const traceJson = traceRows.map((row) => JSON.stringify(row)).join("\n");

const prepared = await prepareTrace(config, { trace_json: traceJson });
const consoleSummary = await summarizeConsole(config, { trace_json: traceJson });
const networkSummary = await summarizeNetwork(config, { trace_json: traceJson });
const failure = await extractFailureStep(config, { trace_json: traceJson });
const screenshots = await prepareTraceScreenshots(config, {});
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const rows = [
  { name: "prepare-status", value: prepared.status },
  { name: "console-errors", value: consoleSummary.console.errors },
  { name: "network-failures", value: networkSummary.network.failures },
  { name: "failure-kind", value: failure.failure?.kind || "none" },
  { name: "screenshots-status", value: screenshots.status },
];
let cases = 10;

assert("prepare-finds-failure", prepared.status === "failed", { status: prepared.status });
assert("console-error-count", consoleSummary.console.errors >= 1, consoleSummary.console);
assert("network-failure-count", networkSummary.network.failures >= 1, networkSummary.network);
assert("failure-step-found", Boolean(failure.failure), failure);
assert("screenshots-empty-safe", screenshots.status === "empty", screenshots);
assert("handoff-scraper", prepared.handoff.scraper_followup_recommended === true, prepared.handoff);
assert("pantheon-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export.data_policy);
assert("measurement-no-raw-url-policy", measurement.pantheon_export.data_policy.includes_urls === false, measurement.pantheon_export.data_policy);
assert("failure-window-present", Boolean(prepared.failure_window), prepared.failure_window);
assert("failure-window-correlates-nearby-network", prepared.failure_window?.nearby_network_failures >= 1, prepared.failure_window);

if (withReal) {
  cases += 2 + 7;
  const manifest = await ensureRealFixtures();
  const harJson = await fs.readFile(manifest.har_path, "utf8");
  const realPrepared = await prepareTrace(config, {
    trace_zip_path: manifest.trace_zip_path,
    screenshot_paths: [manifest.screenshot_path],
    max_screenshots: 4,
  });
  const realNetwork = await summarizeNetwork(config, { har_json: harJson });
  const realFailure = await extractFailureStep(config, { trace_zip_path: manifest.trace_zip_path });
  const realScreenshots = await prepareTraceScreenshots(config, {
    trace_zip_path: manifest.trace_zip_path,
    screenshot_paths: [manifest.screenshot_path],
    max_screenshots: 4,
  });

  assert("real-trace-zip-status", realPrepared.status === "failed", { status: realPrepared.status });
  assert("real-trace-console-errors", realPrepared.console.errors >= 1, realPrepared.console);
  assert("real-trace-network-failures", realPrepared.network.failures >= 1, realPrepared.network);
  assert("real-trace-action-failure", realFailure.failure?.kind === "action", realFailure.failure);
  assert("real-har-5xx", realNetwork.network.status_5xx >= 1, realNetwork.network);
  assert("real-har-slow-request", realNetwork.network.slow_requests >= 1, realNetwork.network);
  assert("real-screenshots-prepared", realScreenshots.image_count >= 1, realScreenshots);
  assert("real-failure-window-present", Boolean(realPrepared.failure_window), realPrepared.failure_window);
  assert("real-failure-window-correlates-console", realPrepared.failure_window?.nearby_console_errors >= 1, realPrepared.failure_window);
  rows.push(
    { name: "real-trace-status", value: realPrepared.status },
    { name: "real-trace-console-errors", value: realPrepared.console.errors },
    { name: "real-trace-network-failures", value: realPrepared.network.failures },
    { name: "real-failure-kind", value: realFailure.failure?.kind || "none" },
    { name: "real-failure-window-network-failures", value: realPrepared.failure_window?.nearby_network_failures || 0 },
    { name: "real-failure-window-console-errors", value: realPrepared.failure_window?.nearby_console_errors || 0 },
    { name: "real-har-slow-requests", value: realNetwork.network.slow_requests },
    { name: "real-screenshots", value: realScreenshots.image_count },
  );
}

const result = {
  benchmark: "playwright-trace-local-golden",
  cases,
  failures,
  rows,
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
