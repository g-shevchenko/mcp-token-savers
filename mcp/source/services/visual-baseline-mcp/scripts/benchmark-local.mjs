#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "visual-baseline-mcp-benchmark-"));
process.env.VISUAL_BASELINE_CACHE_DIR = tempDir;

const { getVisualBaselineConfig } = await import("../dist/config.js");
const { approveBaseline, compareScreenshot, createBaseline, saveMaskPreset } = await import("../dist/image-compare.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");
const { appendRequestLog } = await import("../dist/request-log.js");

const config = getVisualBaselineConfig();
const imageDir = path.join(tempDir, "images");
await fs.mkdir(imageDir, { recursive: true });

const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) {
    failures.push({ name, details });
  }
}

async function writeImage(filePath, width, height, mutate) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    pixels[offset] = 34;
    pixels[offset + 1] = 48;
    pixels[offset + 2] = 72;
    pixels[offset + 3] = 255;
  }
  mutate?.(pixels, width, height);
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

const baselinePath = path.join(imageDir, "baseline.png");
const samePath = path.join(imageDir, "same.png");
const changedPath = path.join(imageDir, "changed.png");
const dimensionPath = path.join(imageDir, "dimension.png");

await writeImage(baselinePath, 64, 64);
await writeImage(samePath, 64, 64);
await writeImage(changedPath, 64, 64, (pixels, width) => {
  for (let y = 10; y < 22; y += 1) {
    for (let x = 10; x < 22; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 235;
      pixels[offset + 1] = 82;
      pixels[offset + 2] = 76;
    }
  }
});
await writeImage(dimensionPath, 80, 64);

async function logBenchmarkResult(tool, result) {
  await appendRequestLog(config, {
    tool,
    transport: "benchmark",
    ok: true,
    duration_ms: 1,
    input: {
      baseline_name_hash: "benchmark-dashboard-main",
      image_path_provided: true,
      metadata_source: "benchmark-local",
    },
    output: {
      status: result.status,
      tool_kind: result.tool_kind,
      raw_tokens_estimate: result.input_stats?.raw_tokens_estimate,
      compact_tokens_estimate: result.input_stats?.compact_tokens_estimate,
      saved_tokens_estimate: result.input_stats?.saved_tokens_estimate,
      savings_pct: result.input_stats?.savings_pct,
      changed_pixels: result.changed_pixels,
      changed_pct: result.changed_pct,
      dimension_mismatch: result.dimension_mismatch === true,
      ignored_changed_pixels: result.ignored_changed_pixels,
      ignore_regions_count: result.ignore_regions_count,
      mask_preset_regions_count: result.mask_preset_regions_count,
      mask_presets_applied: result.mask_presets_applied,
      mask_preset_query_matched: result.mask_preset_query_matched,
      mask_preset_query_used: result.mask_preset_query_used,
      mask_preset_saved: result.tool_kind === "mask_preset" && result.status === "mask_preset_saved",
      mask_preset_applied: result.tool_kind === "compare" && Number(result.mask_presets_applied || 0) > 0,
      approval_status: result.approval_status,
      approval_recorded: result.tool_kind === "approval" && result.approval_status === "approved",
      approved_compare: result.tool_kind === "compare" && result.approval_status === "approved",
      unapproved_compare: result.tool_kind === "compare" && result.approval_status === "unapproved",
      stale_approval_compare: result.tool_kind === "compare" && result.approval_status === "stale",
      baseline_approved: result.approval_status === "approved",
      baseline_approval_stale: result.approval_status === "stale",
      baseline_created: result.status === "baseline_created",
    },
  });
}

const created = await createBaseline(config, {
  baseline_name: "dashboard-main",
  image_path: baselinePath,
  metadata: { source: "benchmark-local" },
});
const approved = await approveBaseline(config, {
  baseline_name: "dashboard-main",
  reviewer: "benchmark-local",
  reason: "golden fixture",
  metadata: { source: "benchmark-local" },
});
const same = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: samePath,
  metadata: { source: "benchmark-local" },
});
const changed = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  max_changed_pct: 0.1,
  metadata: { source: "benchmark-local" },
});
const masked = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  ignore_regions: [{ x: 10, y: 10, width: 12, height: 12, label: "dynamic-widget" }],
  max_changed_pct: 0.1,
  metadata: { source: "benchmark-local" },
});
const maskPreset = await saveMaskPreset(config, {
  preset_name: "dashboard-dynamic-widget",
  route: "/dashboard",
  component: "revenue-widget",
  viewport: "desktop",
  tags: ["dynamic", "widget"],
  regions: [{ x: 10, y: 10, width: 12, height: 12, label: "dynamic-widget" }],
  metadata: { source: "benchmark-local" },
});
const presetMasked = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  mask_preset_names: ["dashboard-dynamic-widget"],
  max_changed_pct: 0.1,
  metadata: { source: "benchmark-local" },
});
const queryMasked = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  mask_preset_query: { route: "/dashboard", component: "revenue-widget", viewport: "desktop", tags: ["dynamic"] },
  max_changed_pct: 0.1,
  metadata: { source: "benchmark-local" },
});
const dimension = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: dimensionPath,
  metadata: { source: "benchmark-local" },
});
const replaced = await createBaseline(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  metadata: { source: "benchmark-local" },
});
const stale = await compareScreenshot(config, {
  baseline_name: "dashboard-main",
  image_path: changedPath,
  metadata: { source: "benchmark-local" },
});
await logBenchmarkResult("create_baseline", created);
await logBenchmarkResult("approve_baseline", approved);
await logBenchmarkResult("compare_screenshot", same);
await logBenchmarkResult("compare_screenshot", changed);
await logBenchmarkResult("compare_screenshot", masked);
await logBenchmarkResult("save_mask_preset", maskPreset);
await logBenchmarkResult("compare_screenshot", presetMasked);
await logBenchmarkResult("compare_screenshot", queryMasked);
await logBenchmarkResult("compare_screenshot", dimension);
await logBenchmarkResult("create_baseline", replaced);
await logBenchmarkResult("compare_screenshot", stale);
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });

assert("baseline-created", created.status === "baseline_created", created);
assert("baseline-approved", approved.status === "approved" && approved.approval_status === "approved", approved);
assert("same-passed", same.status === "passed", same);
assert("same-zero-change", same.changed_pixels === 0, same);
assert("same-approved-baseline", same.approval_status === "approved", same);
assert("changed-detected", changed.status === "changed", changed);
assert("changed-pixels", changed.changed_pixels >= 100, changed);
assert("masked-change-passed", masked.status === "passed" && masked.changed_pixels === 0, masked);
assert("masked-change-ignored", masked.ignored_changed_pixels >= 100, masked);
assert("mask-preset-saved", maskPreset.status === "mask_preset_saved" && maskPreset.region_count === 1, maskPreset);
assert(
  "mask-preset-applied",
  presetMasked.status === "passed" &&
    presetMasked.mask_presets_applied === 1 &&
    presetMasked.mask_preset_regions_count === 1 &&
    presetMasked.ignored_changed_pixels >= 100,
  presetMasked,
);
assert(
  "mask-preset-query-applied",
  queryMasked.status === "passed" &&
    queryMasked.mask_preset_query_used === true &&
    queryMasked.mask_preset_query_matched === 1 &&
    queryMasked.mask_presets_applied === 1 &&
    queryMasked.ignored_changed_pixels >= 100,
  queryMasked,
);
assert("dimension-mismatch", dimension.dimension_mismatch === true && dimension.status === "changed", dimension);
assert("replaced-baseline-created", replaced.status === "baseline_created", replaced);
assert("stale-approval-detected", stale.status === "passed" && stale.approval_status === "stale", stale);
assert("measurement-pantheon-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("measurement-counts-benchmark-rows", measurement.usage.calls === 11, measurement.usage);
assert("measurement-counts-approvals", measurement.quality.baselines_approved === 1, measurement.quality);
assert("measurement-counts-approved-compares", measurement.quality.approved_compares === 6, measurement.quality);
assert("measurement-counts-stale-approvals", measurement.quality.stale_approval_compares === 1, measurement.quality);
assert("measurement-counts-mask-presets", measurement.quality.mask_presets_saved === 1, measurement.quality);
assert("measurement-counts-mask-preset-compares", measurement.quality.mask_preset_compares === 2, measurement.quality);
assert("measurement-counts-mask-preset-query", measurement.quality.mask_preset_query_compares === 1, measurement.quality);
assert("measurement-counts-changed-pixels", measurement.quality.changed_pixels >= 100, measurement.quality);
assert("measurement-counts-ignored-pixels", measurement.quality.ignored_changed_pixels >= 100, measurement.quality);
assert("measurement-token-savings", measurement.token_savings.saved_tokens_estimate > 0, measurement.token_savings);
assert(
  "measurement-no-raw-image-policy",
  measurement.pantheon_export.data_policy.includes_raw_images === false &&
    measurement.pantheon_export.data_policy.includes_image_paths === false,
  measurement.pantheon_export.data_policy,
);

const result = {
  benchmark: "visual-baseline-local-golden",
  cases: 29,
  failures,
  rows: [
    { name: "baseline-status", value: created.status },
    { name: "approval-status", value: approved.approval_status },
    { name: "same-status", value: same.status },
    { name: "same-approval-status", value: same.approval_status },
    { name: "changed-status", value: changed.status },
    { name: "changed-pct", value: changed.changed_pct },
    { name: "masked-status", value: masked.status },
    { name: "masked-ignored-changed-pixels", value: masked.ignored_changed_pixels },
    { name: "mask-preset-status", value: maskPreset.status },
    { name: "preset-masked-status", value: presetMasked.status },
    { name: "preset-masked-regions", value: presetMasked.mask_preset_regions_count },
    { name: "query-masked-status", value: queryMasked.status },
    { name: "query-masked-matches", value: queryMasked.mask_preset_query_matched },
    { name: "dimension-mismatch", value: dimension.dimension_mismatch === true },
    { name: "stale-approval-status", value: stale.approval_status },
    { name: "measurement-calls", value: measurement.usage.calls },
    { name: "measurement-approvals", value: measurement.quality.baselines_approved },
    { name: "measurement-stale-approvals", value: measurement.quality.stale_approval_compares },
    { name: "measurement-mask-presets", value: measurement.quality.mask_presets_saved },
    { name: "measurement-mask-preset-query-compares", value: measurement.quality.mask_preset_query_compares },
    { name: "saved-tokens", value: measurement.token_savings.saved_tokens_estimate },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
