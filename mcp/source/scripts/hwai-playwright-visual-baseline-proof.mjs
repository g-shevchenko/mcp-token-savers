#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
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

function assert(name, condition, details = {}) {
  if (!condition) {
    const error = new Error(`Assertion failed: ${name}`);
    error.details = details;
    throw error;
  }
}

async function ensureTempCaches() {
  if (hasFlag("--durable")) {
    return null;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwai-playwright-visual-baseline-proof-"));
  process.env.PLAYWRIGHT_TRACE_CACHE_DIR ||= path.join(root, "playwright-trace-mcp");
  process.env.VISUAL_BASELINE_CACHE_DIR ||= path.join(root, "visual-baseline-mcp");
  return root;
}

async function ensureRealFixtures() {
  const requested = argValue("--real-fixtures-dir", "");
  const fixturesDir = requested
    ? path.resolve(requested)
    : await fs.mkdtemp(path.join(os.tmpdir(), "playwright-trace-visual-fixture-"));
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
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

function visualSummary(result) {
  const stats = result?.input_stats || {};
  return {
    status: result?.status,
    tool_kind: result?.tool_kind,
    raw_tokens_estimate: stats.raw_tokens_estimate || 0,
    compact_tokens_estimate: stats.compact_tokens_estimate || 0,
    saved_tokens_estimate: stats.saved_tokens_estimate || 0,
    savings_pct: stats.savings_pct || 0,
    changed_pixels: result?.changed_pixels || 0,
    changed_pct: result?.changed_pct || 0,
    dimension_mismatch: result?.dimension_mismatch === true,
    ignored_changed_pixels: result?.ignored_changed_pixels || 0,
    ignore_regions_count: result?.ignore_regions_count || 0,
    mask_preset_regions_count: result?.mask_preset_regions_count || 0,
    mask_presets_applied: result?.mask_presets_applied || 0,
    mask_preset_query_matched: result?.mask_preset_query_matched || 0,
    mask_preset_query_used: result?.mask_preset_query_used === true,
    mask_preset_saved: result?.tool_kind === "mask_preset" && result?.status === "mask_preset_saved",
    mask_preset_applied: result?.tool_kind === "compare" && Number(result?.mask_presets_applied || 0) > 0,
    approval_status: result?.approval_status,
    approval_recorded: result?.tool_kind === "approval" && result?.approval_status === "approved",
    approved_compare: result?.tool_kind === "compare" && result?.approval_status === "approved",
    baseline_approved: result?.approval_status === "approved",
    baseline_created: result?.status === "baseline_created",
  };
}

async function writeChangedCandidate(sharp, sourcePath, outPath) {
  const metadata = await sharp(sourcePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const overlay = Buffer.alloc(width * height * 4);
  const rectWidth = Math.max(16, Math.floor(width * 0.12));
  const rectHeight = Math.max(16, Math.floor(height * 0.12));
  for (let y = 12; y < Math.min(height, 12 + rectHeight); y += 1) {
    for (let x = 12; x < Math.min(width, 12 + rectWidth); x += 1) {
      const offset = (y * width + x) * 4;
      overlay[offset] = 230;
      overlay[offset + 1] = 74;
      overlay[offset + 2] = 66;
      overlay[offset + 3] = 255;
    }
  }
  await sharp(sourcePath)
    .composite([{ input: overlay, raw: { width, height, channels: 4 } }])
    .png()
    .toFile(outPath);
  return { x: 12, y: 12, width: rectWidth, height: rectHeight, label: "dynamic-widget" };
}

async function writeDimensionCandidate(sharp, sourcePath, outPath) {
  const metadata = await sharp(sourcePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  await sharp(sourcePath)
    .resize({ width: width + 64, height, fit: "fill" })
    .png()
    .toFile(outPath);
}

await ensureTempCaches();

const source = argValue("--source", "benchmark-local");
const date = todayUtc();
const manifest = await ensureRealFixtures();
const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "playwright-visual-baseline-candidates-"));
const changedPath = path.join(workingDir, "candidate-changed.png");
const dimensionPath = path.join(workingDir, "candidate-dimension.png");

const visualRequire = createRequire(path.join(repoRoot, "services/visual-baseline-mcp/package.json"));
const sharp = visualRequire("sharp");
const changedRegion = await writeChangedCandidate(sharp, manifest.screenshot_path, changedPath);
await writeDimensionCandidate(sharp, manifest.screenshot_path, dimensionPath);

const { getPlaywrightTraceConfig } = await import(
  path.join(repoRoot, "services/playwright-trace-mcp/dist/config.js")
);
const { prepareTrace, prepareTraceScreenshots } = await import(
  path.join(repoRoot, "services/playwright-trace-mcp/dist/parsers.js")
);
const { getVisualBaselineConfig } = await import(
  path.join(repoRoot, "services/visual-baseline-mcp/dist/config.js")
);
const { approveBaseline, compareScreenshot, createBaseline, saveMaskPreset } = await import(
  path.join(repoRoot, "services/visual-baseline-mcp/dist/image-compare.js")
);
const { buildMeasurementReport } = await import(
  path.join(repoRoot, "services/visual-baseline-mcp/dist/measurement.js")
);
const { appendRequestLog } = await import(
  path.join(repoRoot, "services/visual-baseline-mcp/dist/request-log.js")
);

const playwrightConfig = getPlaywrightTraceConfig();
const visualConfig = getVisualBaselineConfig();
const trace = await prepareTrace(playwrightConfig, {
  trace_zip_path: manifest.trace_zip_path,
  screenshot_paths: [manifest.screenshot_path],
  max_screenshots: 4,
});
const screenshots = await prepareTraceScreenshots(playwrightConfig, {
  trace_zip_path: manifest.trace_zip_path,
  screenshot_paths: [manifest.screenshot_path],
  max_screenshots: 4,
});

const baselineName = argValue("--baseline-name", `playwright-fixture-${date}`);
const baseline = await createBaseline(visualConfig, {
  baseline_name: baselineName,
  image_path: manifest.screenshot_path,
  metadata: { source },
});
const approval = await approveBaseline(visualConfig, {
  baseline_name: baselineName,
  reviewer: source,
  reason: "playwright bridge proof",
  metadata: { source },
});
const same = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: manifest.screenshot_path,
  max_changed_pct: 0.1,
  metadata: { source },
});
const changed = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: changedPath,
  max_changed_pct: 0.1,
  metadata: { source },
});
const masked = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: changedPath,
  ignore_regions: [changedRegion],
  max_changed_pct: 0.1,
  metadata: { source },
});
const maskPresetName = `${baselineName}-dynamic-widget`;
const maskPreset = await saveMaskPreset(visualConfig, {
  preset_name: maskPresetName,
  route: "/playwright-fixture",
  component: "dynamic-widget",
  viewport: "desktop",
  tags: ["dynamic"],
  regions: [changedRegion],
  metadata: { source },
});
const presetMasked = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: changedPath,
  mask_preset_names: [maskPresetName],
  max_changed_pct: 0.1,
  metadata: { source },
});
const queryMasked = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: changedPath,
  mask_preset_query: {
    route: "/playwright-fixture",
    component: "dynamic-widget",
    viewport: "desktop",
    tags: ["dynamic"],
  },
  max_changed_pct: 0.1,
  metadata: { source },
});
const dimension = await compareScreenshot(visualConfig, {
  baseline_name: baselineName,
  image_path: dimensionPath,
  metadata: { source },
});

for (const [tool, result] of [
  ["create_baseline", baseline],
  ["approve_baseline", approval],
  ["compare_screenshot", same],
  ["compare_screenshot", changed],
  ["compare_screenshot", masked],
  ["save_mask_preset", maskPreset],
  ["compare_screenshot", presetMasked],
  ["compare_screenshot", queryMasked],
  ["compare_screenshot", dimension],
]) {
  await appendRequestLog(visualConfig, {
    tool,
    transport: "benchmark",
    ok: true,
    duration_ms: 1,
    input: {
      baseline_name_hash: "playwright-fixture",
      image_path_provided: true,
      metadata_source: source,
      playwright_fixture: true,
    },
    output: visualSummary(result),
  });
}

const measurement = await buildMeasurementReport(visualConfig, { date });
const pantheonJson = JSON.stringify(measurement.pantheon_export);

assert("playwright-trace-failed", trace.status === "failed", { status: trace.status });
assert("playwright-failure-window", Boolean(trace.failure_window), trace.failure_window);
assert("screenshots-prepared", screenshots.image_count >= 1, screenshots);
assert("visual-baseline-created", baseline.status === "baseline_created", baseline);
assert("visual-baseline-approved", approval.status === "approved" && approval.approval_status === "approved", approval);
assert("visual-same-passed", same.status === "passed" && same.changed_pixels === 0, same);
assert("visual-same-approved", same.approval_status === "approved", same);
assert("visual-changed-detected", changed.status === "changed" && changed.changed_pixels > 0, changed);
assert("visual-masked-passed", masked.status === "passed" && masked.ignored_changed_pixels > 0, masked);
assert("visual-mask-preset-saved", maskPreset.status === "mask_preset_saved", maskPreset);
assert(
  "visual-preset-masked-passed",
  presetMasked.status === "passed" &&
    presetMasked.mask_presets_applied === 1 &&
    presetMasked.ignored_changed_pixels > 0,
  presetMasked,
);
assert(
  "visual-query-masked-passed",
  queryMasked.status === "passed" &&
    queryMasked.mask_preset_query_used === true &&
    queryMasked.mask_preset_query_matched === 1 &&
    queryMasked.ignored_changed_pixels > 0,
  queryMasked,
);
assert("visual-dimension-mismatch", dimension.status === "changed" && dimension.dimension_mismatch === true, dimension);
assert("visual-measurement-counts", measurement.usage.calls === 9, measurement.usage);
assert("visual-measurement-savings", measurement.token_savings.saved_tokens_estimate > 0, measurement.token_savings);
assert("pantheon-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("pantheon-no-fixture-path", !pantheonJson.includes(path.dirname(manifest.screenshot_path)), {});
assert("pantheon-no-visual-artifact-url", !pantheonJson.includes("visual-baseline://"), {});
assert("pantheon-no-playwright-artifact-url", !pantheonJson.includes("playwright-trace://"), {});

const result = {
  schema_version: "hwai-playwright-visual-baseline-proof.v1",
  status: "passed",
  source,
  playwright: {
    status: trace.status,
    failure_kind: trace.failure?.kind || "none",
    failure_window_present: Boolean(trace.failure_window),
    screenshots_prepared: screenshots.image_count,
  },
  visual_baseline: {
    baseline_status: baseline.status,
    approval_status: approval.approval_status,
    same_status: same.status,
    same_approval_status: same.approval_status,
    changed_status: changed.status,
    changed_pixels: changed.changed_pixels,
    changed_pct: changed.changed_pct,
    masked_status: masked.status,
    masked_approval_status: masked.approval_status,
    masked_ignored_changed_pixels: masked.ignored_changed_pixels,
    mask_preset_status: maskPreset.status,
    preset_masked_status: presetMasked.status,
    preset_masked_regions: presetMasked.mask_preset_regions_count,
    query_masked_status: queryMasked.status,
    query_masked_matches: queryMasked.mask_preset_query_matched,
    dimension_mismatch: dimension.dimension_mismatch === true,
    measurement_calls: measurement.usage.calls,
    saved_tokens_estimate: measurement.token_savings.saved_tokens_estimate,
    safe_for_pantheon: measurement.pantheon_export.safe_for_pantheon,
  },
  data_policy: {
    raw_trace_paths_exported: false,
    raw_image_paths_exported: false,
    raw_urls_exported: false,
    artifact_urls_exported_to_pantheon: false,
  },
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
