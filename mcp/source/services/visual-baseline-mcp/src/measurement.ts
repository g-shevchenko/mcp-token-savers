import fs from "node:fs/promises";
import { VISUAL_BASELINE_MEASUREMENT_SCHEMA_VERSION, VisualBaselineConfig } from "./config.js";
import { round } from "./text-utils.js";

export interface MeasurementOptions {
  date?: string;
  since_iso?: string;
  until_iso?: string;
}

interface RequestLogLine {
  duration_ms?: number;
  ok?: boolean;
  output?: Record<string, unknown>;
  tool?: string;
  transport?: string;
  ts?: string;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function dateRange(options: MeasurementOptions): { date: string; since: Date; until: Date } {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const since = options.since_iso ? new Date(options.since_iso) : new Date(`${date}T00:00:00.000Z`);
  const until = options.until_iso
    ? new Date(options.until_iso)
    : new Date(since.getTime() + 24 * 60 * 60 * 1000);
  return { date, since, until };
}

function inRange(ts: string | undefined, since: Date, until: Date): boolean {
  if (!ts) {
    return false;
  }
  const parsed = new Date(ts);
  return Number.isFinite(parsed.getTime()) && parsed >= since && parsed < until;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function countBy(rows: RequestLogLine[], key: keyof RequestLogLine): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export async function buildMeasurementReport(config: VisualBaselineConfig, options: MeasurementOptions = {}) {
  const { date, since, until } = dateRange(options);
  const requests = (await readJsonl<RequestLogLine>(config.requestLogPath)).filter((line) =>
    inRange(line.ts, since, until),
  );
  const errors = requests.filter((line) => line.ok === false);
  const okRequests = requests.filter((line) => line.ok !== false);
  const latencies = requests.map((line) => number(line.duration_ms)).filter((value) => value > 0);
  const rawTokens = okRequests.reduce((sum, line) => sum + number(line.output?.raw_tokens_estimate), 0);
  const compactTokens = okRequests.reduce((sum, line) => sum + number(line.output?.compact_tokens_estimate), 0);
  const savedTokens = okRequests.reduce((sum, line) => sum + number(line.output?.saved_tokens_estimate), 0);
  const baselinesCreated = okRequests.filter((line) => line.output?.status === "baseline_created").length;
  const baselinesApproved = okRequests.filter((line) => line.output?.tool_kind === "approval").length;
  const maskPresetsSaved = okRequests.filter((line) => line.output?.tool_kind === "mask_preset").length;
  const compares = okRequests.filter((line) => line.output?.tool_kind === "compare").length;
  const approvedCompares = okRequests.filter(
    (line) => line.output?.tool_kind === "compare" && line.output?.approval_status === "approved",
  ).length;
  const unapprovedCompares = okRequests.filter(
    (line) => line.output?.tool_kind === "compare" && line.output?.approval_status === "unapproved",
  ).length;
  const staleApprovalCompares = okRequests.filter(
    (line) => line.output?.tool_kind === "compare" && line.output?.approval_status === "stale",
  ).length;
  const maskPresetCompares = okRequests.filter(
    (line) => line.output?.tool_kind === "compare" && number(line.output?.mask_presets_applied) > 0,
  ).length;
  const maskPresetQueryCompares = okRequests.filter(
    (line) => line.output?.tool_kind === "compare" && line.output?.mask_preset_query_used === true,
  ).length;
  const changed = okRequests.filter((line) => line.output?.status === "changed").length;
  const passed = okRequests.filter((line) => line.output?.status === "passed").length;
  const changedPixels = okRequests.reduce((sum, line) => sum + number(line.output?.changed_pixels), 0);
  const ignoredChangedPixels = okRequests.reduce((sum, line) => sum + number(line.output?.ignored_changed_pixels), 0);
  const maskPresetRegions = okRequests.reduce((sum, line) => sum + number(line.output?.mask_preset_regions_count), 0);
  const maskPresetQueryMatches = okRequests.reduce((sum, line) => sum + number(line.output?.mask_preset_query_matched), 0);
  const estimatedUsdSaved = round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4);

  return {
    schema_version: VISUAL_BASELINE_MEASUREMENT_SCHEMA_VERSION,
    date,
    time_basis: "UTC",
    window: {
      since_iso: since.toISOString(),
      until_iso: until.toISOString(),
    },
    usage: {
      calls: requests.length,
      ok_calls: okRequests.length,
      failed_calls: errors.length,
      by_tool: countBy(requests, "tool"),
      by_transport: countBy(requests, "transport"),
      latency_ms: {
        p95: percentile(latencies, 95),
        max: latencies.length ? Math.max(...latencies) : 0,
      },
    },
    quality: {
      baselines_created: baselinesCreated,
      baselines_approved: baselinesApproved,
      mask_presets_saved: maskPresetsSaved,
      compares,
      approved_compares: approvedCompares,
      unapproved_compares: unapprovedCompares,
      stale_approval_compares: staleApprovalCompares,
      mask_preset_compares: maskPresetCompares,
      mask_preset_query_compares: maskPresetQueryCompares,
      passed,
      changed,
      changed_pixels: changedPixels,
      ignored_changed_pixels: ignoredChangedPixels,
      mask_preset_regions: maskPresetRegions,
      mask_preset_query_matches: maskPresetQueryMatches,
    },
    token_savings: {
      raw_tokens_estimate: rawTokens,
      compact_tokens_estimate: compactTokens,
      saved_tokens_estimate: savedTokens,
      savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
      estimated_usd_saved: estimatedUsdSaved,
      usd_per_1m_tokens: config.measurementUsdPer1MTokens,
    },
    pantheon_export: {
      service: "visual-baseline-mcp",
      date,
      calls: requests.length,
      ok_calls: okRequests.length,
      errors: errors.length,
      baselines_created: baselinesCreated,
      baselines_approved: baselinesApproved,
      mask_presets_saved: maskPresetsSaved,
      compares,
      approved_compares: approvedCompares,
      unapproved_compares: unapprovedCompares,
      stale_approval_compares: staleApprovalCompares,
      mask_preset_compares: maskPresetCompares,
      mask_preset_query_compares: maskPresetQueryCompares,
      passed,
      changed,
      changed_pixels: changedPixels,
      ignored_changed_pixels: ignoredChangedPixels,
      mask_preset_regions: maskPresetRegions,
      mask_preset_query_matches: maskPresetQueryMatches,
      saved_tokens_estimate: savedTokens,
      p95_latency_ms: percentile(latencies, 95),
      safe_for_pantheon: true,
      data_policy: {
        aggregate_only: true,
        includes_raw_images: false,
        includes_image_paths: false,
        includes_image_urls: false,
        includes_artifact_urls: false,
        includes_pixel_samples: false,
      },
    },
  };
}
