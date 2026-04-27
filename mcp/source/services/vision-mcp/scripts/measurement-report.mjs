#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getVisionConfig } from "../dist/config.js";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function traceSource(row) {
  const input = row.input || {};
  const explicit = typeof input.metadata_source === "string" ? input.metadata_source.trim() : "";
  const surface = typeof input.metadata_surface === "string" ? input.metadata_surface.trim() : "";

  if (trafficClass(row) === "proof") {
    return "proof_loop";
  }
  if (trafficClass(row) === "benchmark") {
    return "benchmark";
  }
  if (explicit) {
    return explicit.slice(0, 80);
  }
  if (surface) {
    return surface.slice(0, 80);
  }
  return "unknown";
}

function cleanLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 80);
}

function inferSurfaceFromSource(source) {
  const normalized = (source || "").toLowerCase();
  for (const surface of ["claude", "codex", "cursor", "windsurf"]) {
    if (normalized.includes(surface)) {
      return surface;
    }
  }
  return "";
}

function trafficClass(row) {
  const input = row.input || {};
  const explicit = cleanLabel(input.traffic_class);
  if (["production_like", "proof", "benchmark", "unknown"].includes(explicit)) {
    return explicit;
  }

  const source = cleanLabel(input.metadata_source);
  const surface = cleanLabel(input.metadata_surface) || inferSurfaceFromSource(source);
  const haystack = JSON.stringify({
    source,
    surface,
    tool: row.tool,
    purpose: input.purpose,
    context: input.context,
  }).toLowerCase();

  if (
    haystack.includes("golden") ||
    haystack.includes("benchmark") ||
    haystack.includes("bench") ||
    haystack.includes("dataset") ||
    haystack.includes("regression")
  ) {
    return "benchmark";
  }
  if (
    haystack.includes("smoke") ||
    haystack.includes("e2e") ||
    haystack.includes("proof") ||
    haystack.includes("test") ||
    haystack.includes("fixture")
  ) {
    return "proof";
  }
  if (/\b(claude|codex|cursor|windsurf|agent)\b/.test(haystack)) {
    return "production_like";
  }
  return "unknown";
}

function sanitizeSampleValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeSampleValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.toLowerCase();
        return !(
          normalized === "url" ||
          normalized === "before_url" ||
          normalized === "after_url" ||
          normalized.endsWith("_url") ||
          normalized.includes("body") ||
          normalized.includes("content")
        );
      })
      .map(([key, item]) => [key, sanitizeSampleValue(item)]),
  );
}

function uncertainty(row) {
  return Number(row.output?.uncertainty || row.output?.max_uncertainty || 0);
}

function isHighUncertainty(row) {
  return uncertainty(row) > 0.03 || row.output?.requires_clarification === true;
}

function summarizeHighUncertainty(row) {
  return {
    ts: row.ts,
    tool: row.tool,
    transport: row.transport,
    trace_source: traceSource(row),
    traffic_class: trafficClass(row),
    duration_ms: row.duration_ms,
    uncertainty: uncertainty(row),
    requires_clarification: row.output?.requires_clarification === true,
    input: sanitizeSampleValue(row.input || {}),
    output: {
      prep_mode: row.output?.prep_mode,
      recommended_profile: row.output?.recommended_profile,
      image_urls_for_model_count: row.output?.image_urls_for_model_count,
      annotation_regions_count: row.output?.annotation_regions_count,
      changed_regions_count: row.output?.changed_regions_count,
      savings_pct: row.output?.savings_pct,
    },
  };
}

function rollupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    const existing = groups.get(key) || {
      requests: 0,
      ok: 0,
      errors: 0,
      full_tokens_estimate: 0,
      compact_tokens_estimate: 0,
      saved_tokens_estimate: 0,
      image_urls_for_model_count: 0,
      durations: [],
    };
    existing.requests += 1;
    existing.ok += row.ok ? 1 : 0;
    existing.errors += row.ok ? 0 : 1;
    existing.full_tokens_estimate += Number(row.output?.full_tokens_estimate || 0);
    existing.compact_tokens_estimate += Number(row.output?.compact_tokens_estimate || 0);
    existing.saved_tokens_estimate += Number(row.output?.saved_tokens_estimate || 0);
    existing.image_urls_for_model_count += Number(row.output?.image_urls_for_model_count || 0);
    existing.durations.push(Number(row.duration_ms || 0));
    groups.set(key, existing);
  }

  return Object.fromEntries(
    Array.from(groups.entries())
      .sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
      .map(([key, value]) => [
        key,
        {
          requests: value.requests,
          ok: value.ok,
          errors: value.errors,
          compact_tokens_estimate: value.compact_tokens_estimate,
          full_tokens_estimate: value.full_tokens_estimate,
          saved_tokens_estimate: value.saved_tokens_estimate,
          savings_pct:
            value.full_tokens_estimate > 0
              ? round((value.saved_tokens_estimate / value.full_tokens_estimate) * 100)
              : 0,
          avg_image_urls_for_model:
            value.requests > 0 ? round(value.image_urls_for_model_count / value.requests, 2) : 0,
          p95_latency_ms: percentile(value.durations, 0.95),
        },
      ]),
  );
}

function sumRequests(object, predicate = () => true) {
  return Object.entries(object || {}).reduce(
    (sum, [key, value]) => (predicate(key) ? sum + Number(value?.requests || 0) : sum),
    0,
  );
}

function traceSourceCounts(byTraceSource) {
  return {
    proof_loop: Number(byTraceSource?.proof_loop?.requests || 0),
    benchmark: Number(byTraceSource?.benchmark?.requests || 0),
    unknown: Number(byTraceSource?.unknown?.requests || 0),
    labeled: sumRequests(byTraceSource, (key) => key !== "proof_loop" && key !== "benchmark" && key !== "unknown"),
  };
}

function buildPantheonExport(report) {
  return {
    schema_version: "vision-mcp-pantheon-export.v1",
    generated_at: report.generated_at,
    service: "vision-mcp",
    safe_for_pantheon: true,
    data_policy: {
      aggregate_only: true,
      includes_raw_images: false,
      includes_raw_urls: false,
      includes_local_log_paths: false,
      includes_samples: false,
      includes_artifact_urls: false,
      includes_ocr_text: false,
    },
    filters: report.filters,
    summary: report.summary,
    by_tool: report.by_tool,
    by_profile: report.by_profile,
    by_traffic_class: report.by_traffic_class,
    trace_source_counts: traceSourceCounts(report.by_trace_source),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Vision MCP Measurement Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Window: ${report.filters.since_iso || "beginning"} -> ${report.filters.until_iso || "now"}`);
  lines.push("");
  lines.push(`Requests: ${report.summary.requests}`);
  lines.push(`Errors: ${report.summary.errors}`);
  lines.push(`Saved tokens estimate: ${report.summary.saved_tokens_estimate}`);
  lines.push(`Savings: ${report.summary.savings_pct}%`);
  lines.push(`High uncertainty: ${report.summary.high_uncertainty_count}`);
  lines.push(`Actionable high uncertainty: ${report.summary.actionable_high_uncertainty_count}`);
  lines.push(`Production-like requests: ${report.summary.production_like_requests}`);
  lines.push(`Proof requests: ${report.summary.proof_requests}`);
  lines.push(`Benchmark requests: ${report.summary.benchmark_requests}`);
  lines.push(`Unknown attribution requests: ${report.summary.unknown_requests}`);
  lines.push(`p95 latency: ${report.summary.p95_latency_ms} ms`);
  lines.push("");
  lines.push("Pantheon-safe export: `--format=pantheon` emits aggregate-only telemetry without raw URLs, images, OCR text, local log paths, samples, or artifact URLs.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const config = getVisionConfig();
const logPath = path.resolve(argValue("--log", config.requestLogPath));
const date = argValue("--date", "");
const sinceIso = argValue("--since", date ? `${date}T00:00:00.000Z` : "");
const untilIso = argValue("--until", date ? addDays(date, 1) : "");
const outPath = argValue("--out", "");
const format = argValue("--format", "json");
const sinceTime = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
const untilTime = untilIso ? Date.parse(untilIso) : Number.POSITIVE_INFINITY;
const rows = (await readJsonl(logPath)).filter((row) => {
  const ts = Date.parse(row.ts || "");
  return Number.isFinite(ts) && ts >= sinceTime && ts < untilTime;
});

const durations = rows.map((row) => Number(row.duration_ms || 0));
const errors = rows.filter((row) => !row.ok);
const fullTokens = rows.reduce((sum, row) => sum + Number(row.output?.full_tokens_estimate || 0), 0);
const compactTokens = rows.reduce((sum, row) => sum + Number(row.output?.compact_tokens_estimate || 0), 0);
const savedTokens = rows.reduce((sum, row) => sum + Number(row.output?.saved_tokens_estimate || 0), 0);
const clarificationCount = rows.filter((row) => row.output?.requires_clarification === true).length;
const highUncertainty = rows.filter(isHighUncertainty);
const actionableHighUncertainty = highUncertainty.filter((row) => !["proof", "benchmark"].includes(trafficClass(row)));
const productionLikeRows = rows.filter((row) => trafficClass(row) === "production_like");
const productionLikeSavedTokens = productionLikeRows.reduce(
  (sum, row) => sum + Number(row.output?.saved_tokens_estimate || 0),
  0,
);
const trafficClassCounts = {
  production_like: rows.filter((row) => trafficClass(row) === "production_like").length,
  proof: rows.filter((row) => trafficClass(row) === "proof").length,
  benchmark: rows.filter((row) => trafficClass(row) === "benchmark").length,
  unknown: rows.filter((row) => trafficClass(row) === "unknown").length,
};

const payload = {
  schema_version: "vision-mcp-measurement-report.v1",
  generated_at: new Date().toISOString(),
  request_log_path: logPath,
  filters: {
    date: date || null,
    since_iso: sinceIso || null,
    until_iso: untilIso || null,
  },
  summary: {
    requests: rows.length,
    ok: rows.length - errors.length,
    errors: errors.length,
    full_tokens_estimate: fullTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: fullTokens > 0 ? round((savedTokens / fullTokens) * 100) : 0,
    clarification_count: clarificationCount,
    high_uncertainty_count: highUncertainty.length,
    actionable_high_uncertainty_count: actionableHighUncertainty.length,
    production_like_high_uncertainty_count: highUncertainty.filter((row) => trafficClass(row) === "production_like").length,
    proof_loop_high_uncertainty_count: highUncertainty.filter((row) => trafficClass(row) === "proof").length,
    benchmark_high_uncertainty_count: highUncertainty.filter((row) => trafficClass(row) === "benchmark").length,
    unknown_high_uncertainty_count: highUncertainty.filter((row) => trafficClass(row) === "unknown").length,
    production_like_requests: trafficClassCounts.production_like,
    proof_requests: trafficClassCounts.proof,
    benchmark_requests: trafficClassCounts.benchmark,
    unknown_requests: trafficClassCounts.unknown,
    production_like_saved_tokens_estimate: productionLikeSavedTokens,
    p95_latency_ms: percentile(durations, 0.95),
    first_ts: rows[0]?.ts || null,
    last_ts: rows.at(-1)?.ts || null,
  },
  by_tool: rollupBy(rows, (row) => row.tool),
  by_profile: rollupBy(rows, (row) => row.output?.recommended_profile || "n/a"),
  by_traffic_class: rollupBy(rows, trafficClass),
  by_trace_source: rollupBy(rows, traceSource),
  high_uncertainty_samples: highUncertainty.slice(-10).map(summarizeHighUncertainty),
  error_samples: errors.slice(-10).map((row) => ({
    ts: row.ts,
    tool: row.tool,
    duration_ms: row.duration_ms,
    error: row.error,
  })),
};
payload.pantheon_export = buildPantheonExport(payload);

const allowedFormats = new Set(["json", "markdown", "pantheon"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const rendered =
  format === "markdown"
    ? renderMarkdown(payload)
    : format === "pantheon"
      ? `${JSON.stringify(payload.pantheon_export, null, 2)}\n`
      : `${JSON.stringify(payload, null, 2)}\n`;
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), requests: rows.length, format }, null, 2));
} else {
  process.stdout.write(rendered);
}
