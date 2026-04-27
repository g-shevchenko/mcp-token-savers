#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
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

async function ensureTempCaches() {
  if (hasFlag("--durable")) {
    return null;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwai-playwright-vision-proof-"));
  process.env.PLAYWRIGHT_TRACE_CACHE_DIR ||= path.join(root, "playwright-trace-mcp");
  process.env.VISION_MCP_CACHE_DIR ||= path.join(root, "vision-mcp");
  return root;
}

async function ensureRealFixtures() {
  const requested = argValue("--real-fixtures-dir", "");
  const fixturesDir = requested
    ? path.resolve(requested)
    : await fs.mkdtemp(path.join(os.tmpdir(), "playwright-vision-fixture-"));
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

async function serveSingleFile(filePath) {
  const fileName = path.basename(filePath);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (path.basename(decodeURIComponent(url.pathname)) !== fileName) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const buffer = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": String(buffer.length),
      "cache-control": "no-store",
    });
    res.end(buffer);
  });
  const address = await listen(server);
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind local screenshot fixture server");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/${encodeURIComponent(fileName)}`,
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

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function anthropicTokenEstimate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object" && Number.isFinite(value.anthropic_approx)) {
    return value.anthropic_approx;
  }
  return 0;
}

await ensureTempCaches();
process.env.VISION_ALLOWED_HOSTS ||= "127.0.0.1,localhost";
process.env.VISION_MCP_ENABLE_OCR ||= "0";

const source = argValue("--source", "benchmark-local");
const fixture = await ensureRealFixtures();
const { fixturesDir, manifest } = fixture;

const { getPlaywrightTraceConfig } = await import(
  path.join(repoRoot, "services/playwright-trace-mcp/dist/config.js")
);
const { prepareTraceScreenshots } = await import(
  path.join(repoRoot, "services/playwright-trace-mcp/dist/parsers.js")
);
const { getVisionConfig } = await import(path.join(repoRoot, "services/vision-mcp/dist/config.js"));
const { analyzeScreenshotUrl } = await import(
  path.join(repoRoot, "services/vision-mcp/dist/analysis-pipeline.js")
);
const { appendRequestLog } = await import(path.join(repoRoot, "services/vision-mcp/dist/request-log.js"));

const playwrightConfig = getPlaywrightTraceConfig();
const screenshots = await prepareTraceScreenshots(playwrightConfig, {
  trace_zip_path: manifest.trace_zip_path,
  screenshot_paths: [manifest.screenshot_path],
  max_screenshots: 4,
});
assert("playwright-screenshots-prepared", screenshots.image_count >= 1, screenshots);

const firstArtifact = screenshots.screenshot_artifacts[0];
const artifactPath = path.join(playwrightConfig.artifactDir, firstArtifact.file);
const localServer = await serveSingleFile(artifactPath);

let vision;
const startedAt = Date.now();
try {
  const visionConfig = getVisionConfig();
  vision = await analyzeScreenshotUrl(
    localServer.url,
    "Playwright trace screenshot artifact render check",
    visionConfig,
    {
      source,
      task_id: "playwright-vision-proof",
      surface: "codex",
      screenshot_source: "playwright-trace-mcp",
    },
    "bug_report",
  );

  await appendRequestLog(visionConfig, {
    tool: "prepare_screenshot",
    transport: "mcp",
    ok: true,
    duration_ms: Date.now() - startedAt,
    input: {
      url_host: "127.0.0.1",
      url_ext: path.extname(artifactPath).toLowerCase(),
      metadata_source: source,
      metadata_surface: "codex",
      traffic_class: source.includes("benchmark") ? "benchmark" : "proof",
      task_intent: "bug_report",
      source_mcp: "playwright-trace-mcp",
    },
    output: {
      schema_version: vision.compact.schema_version,
      red_regions_detected: vision.compact.detection_summary.red_regions_detected,
      image_urls_for_model_count: vision.compact.image_urls_for_model.length,
      recommended_profile: vision.compact.recommended_profile,
      uncertainty: vision.compact.confidence.uncertainty,
      requires_clarification: vision.compact.autopilot.requires_clarification,
    },
  });

  const requestLog = await readTextIfExists(visionConfig.requestLogPath);
  const forbiddenValues = [
    fixturesDir,
    manifest.trace_zip_path,
    manifest.har_path,
    manifest.screenshot_path,
    artifactPath,
    firstArtifact.url,
    localServer.url,
  ].filter(Boolean);

  for (const [index, forbidden] of forbiddenValues.entries()) {
    assert(`vision-request-log-no-raw-value-${index}`, !requestLog.includes(forbidden), {
      forbidden_kind:
        forbidden === fixturesDir ? "fixtures_dir"
          : forbidden === manifest.trace_zip_path ? "trace_zip_path"
          : forbidden === manifest.har_path ? "har_path"
          : forbidden === manifest.screenshot_path ? "screenshot_path"
          : forbidden === artifactPath ? "artifact_path"
          : forbidden === firstArtifact.url ? "playwright_artifact_url"
          : "local_http_url",
    });
  }

  assert("vision-schema", vision.compact.schema_version === "vision-mcp.v3", {
    schema_version: vision.compact.schema_version,
  });
  assert("vision-full-frame-prepared", Boolean(vision.compact.artifacts.full_frame?.url), vision.compact.artifacts);
  assert("vision-image-url-for-model", vision.compact.image_urls_for_model.length >= 1, {
    image_urls_for_model_count: vision.compact.image_urls_for_model.length,
  });
  assert("vision-no-red-annotations-is-clarification", vision.compact.autopilot.requires_clarification === true, {
    red_regions_detected: vision.compact.detection_summary.red_regions_detected,
    uncertainty: vision.compact.confidence.uncertainty,
  });

  const originalWidth = vision.verbose.original_dimensions?.width || vision.compact.artifacts.full_frame.width || 0;
  const originalHeight = vision.verbose.original_dimensions?.height || vision.compact.artifacts.full_frame.height || 0;
  const preparedTokenEstimate = anthropicTokenEstimate(vision.compact.artifacts.full_frame.estimated_tokens);
  const rawToCompactTokenSavingsEstimate = round(
    Math.max(0, (originalWidth * originalHeight) / 750 - preparedTokenEstimate),
  );

  const result = {
    schema_version: "hwai-playwright-vision-proof.v1",
    status: "passed",
    fixtures: {
      source: fixture.source,
      real_trace_zip_used: true,
      screenshot_artifact_used: true,
    },
    playwright: {
      screenshots_prepared: screenshots.image_count,
      handoff_vision_recommended: screenshots.handoff.vision_recommended === true,
    },
    vision: {
      schema_version: vision.compact.schema_version,
      red_regions_detected: vision.compact.detection_summary.red_regions_detected,
      image_urls_for_model_count: vision.compact.image_urls_for_model.length,
      recommended_profile: vision.compact.recommended_profile,
      uncertainty: vision.compact.confidence.uncertainty,
      requires_clarification: vision.compact.autopilot.requires_clarification,
      prepared_width: vision.compact.artifacts.full_frame.width,
      prepared_height: vision.compact.artifacts.full_frame.height,
      raw_to_compact_token_savings_estimate: rawToCompactTokenSavingsEstimate,
    },
    data_policy: {
      raw_trace_paths_exported: false,
      raw_screenshot_paths_exported: false,
      raw_source_urls_logged: false,
      artifact_urls_exported_to_pantheon: false,
      local_request_log_checked: true,
    },
  };

  const outPath = argValue("--out");
  if (outPath) {
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await close(localServer.server);
}
