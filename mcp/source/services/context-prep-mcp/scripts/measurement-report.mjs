#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getContextPrepConfig } from "../dist/config.js";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
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
  const joined = JSON.stringify({
    metadata_source: explicit,
    purpose: input.purpose,
    context: input.context,
  }).toLowerCase();

  if (joined.includes("benchmark") || joined.includes("smoke") || joined.includes("regression")) {
    return "proof_loop";
  }
  if (explicit) {
    return explicit.slice(0, 80);
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
          normalized === "text" ||
          normalized.endsWith("_text") ||
          normalized.includes("body") ||
          normalized.includes("content")
        );
      })
      .map(([key, item]) => [key, sanitizeSampleValue(item)]),
  );
}

function uncertainty(row) {
  return Number(row.output?.uncertainty || 0);
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
    duration_ms: row.duration_ms,
    uncertainty: uncertainty(row),
    input: sanitizeSampleValue(row.input || {}),
    output: {
      prep_mode: row.output?.prep_mode,
      parser_used: row.output?.parser_used,
      warnings_count: row.output?.warnings_count,
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
      raw_tokens_estimate: 0,
      compact_tokens_estimate: 0,
      saved_tokens_estimate: 0,
      durations: [],
    };
    existing.requests += 1;
    existing.ok += row.ok ? 1 : 0;
    existing.errors += row.ok ? 0 : 1;
    existing.raw_tokens_estimate += Number(row.output?.raw_tokens_estimate || 0);
    existing.compact_tokens_estimate += Number(row.output?.compact_tokens_estimate || 0);
    existing.saved_tokens_estimate += Number(row.output?.saved_tokens_estimate || 0);
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
          saved_tokens_estimate: value.saved_tokens_estimate,
          savings_pct:
            value.raw_tokens_estimate > 0
              ? round((value.saved_tokens_estimate / value.raw_tokens_estimate) * 100)
              : 0,
          p95_latency_ms: percentile(value.durations, 0.95),
        },
      ]),
  );
}

function countTraceSources(byTraceSource) {
  const proofLoop = Number(byTraceSource?.proof_loop?.requests || 0);
  const unknown = Number(byTraceSource?.unknown?.requests || 0);
  const labeled = Object.entries(byTraceSource || {}).reduce(
    (sum, [key, value]) => (key === "proof_loop" || key === "unknown" ? sum : sum + Number(value?.requests || 0)),
    0,
  );
  return {
    proof_loop: proofLoop,
    unknown,
    labeled,
  };
}

function buildPantheonExport(payload) {
  return {
    schema_version: "context-prep-mcp-pantheon-export.v1",
    generated_at: payload.generated_at,
    service: "context-prep-mcp",
    safe_for_pantheon: true,
    data_policy: {
      aggregate_only: true,
      includes_raw_inputs: false,
      includes_urls: false,
      includes_local_log_paths: false,
      includes_samples: false,
      includes_artifact_urls: false,
    },
    filters: payload.filters,
    summary: payload.summary,
    by_tool: payload.by_tool,
    by_transport: payload.by_transport,
    by_parser: payload.by_parser,
    by_scraper_fallback_reason: payload.by_scraper_fallback_reason,
    trace_source_counts: countTraceSources(payload.by_trace_source),
  };
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# Context Prep MCP Measurement Report");
  lines.push("");
  lines.push(`Generated: ${payload.generated_at}`);
  lines.push(`Window: ${payload.filters.since_iso || "beginning"} -> ${payload.filters.until_iso || "now"}`);
  lines.push("");
  lines.push(`Requests: ${payload.summary.requests}`);
  lines.push(`Errors: ${payload.summary.errors}`);
  lines.push(`Saved tokens estimate: ${payload.summary.total_saved_tokens_estimate}`);
  lines.push(`Weighted savings: ${payload.summary.weighted_savings_pct}%`);
  lines.push(`High uncertainty: ${payload.summary.high_uncertainty_count}`);
  lines.push(`Actionable high uncertainty: ${payload.summary.actionable_high_uncertainty_count}`);
  lines.push(`p95 latency ms: ${payload.summary.p95_latency_ms}`);
  lines.push("");
  lines.push("Pantheon-safe export: `--format=pantheon` returns aggregate-only telemetry without raw inputs, URLs, local log paths, samples, or artifact URLs.");
  lines.push("");
  lines.push("## By Tool");
  for (const [tool, value] of Object.entries(payload.by_tool)) {
    lines.push(`- ${tool}: ${value.requests} requests, ${value.saved_tokens_estimate} saved tokens, ${value.savings_pct}% savings`);
  }
  lines.push("");
  lines.push("## By Parser");
  for (const [parser, value] of Object.entries(payload.by_parser)) {
    lines.push(`- ${parser}: ${value.requests} requests, ${value.saved_tokens_estimate} saved tokens, ${value.savings_pct}% savings`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const config = getContextPrepConfig();
const logPath = path.resolve(argValue("--log", config.requestLogPath));
const date = argValue("--date", "");
const sinceIso = argValue("--since", date ? `${date}T00:00:00.000Z` : "");
const untilIso = argValue("--until", date ? addDays(date, 1) : "");
const outPath = argValue("--out", "");
const format = argValue("--format", "json");
const allowedFormats = new Set(["json", "markdown", "pantheon"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}
const sinceTime = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
const untilTime = untilIso ? Date.parse(untilIso) : Number.POSITIVE_INFINITY;
const rows = (await readJsonl(logPath)).filter((row) => {
  const ts = Date.parse(row.ts || "");
  return Number.isFinite(ts) && ts >= sinceTime && ts < untilTime;
});

const durations = rows.map((row) => Number(row.duration_ms || 0));
const totalRaw = rows.reduce((sum, row) => sum + Number(row.output?.raw_tokens_estimate || 0), 0);
const totalCompact = rows.reduce((sum, row) => sum + Number(row.output?.compact_tokens_estimate || 0), 0);
const totalSaved = rows.reduce((sum, row) => sum + Number(row.output?.saved_tokens_estimate || 0), 0);
const errors = rows.filter((row) => !row.ok);
const highUncertainty = rows.filter(isHighUncertainty);
const actionableHighUncertainty = highUncertainty.filter((row) => traceSource(row) !== "proof_loop");

const payload = {
  schema_version: "context-prep-measurement-report.v1",
  generated_at: new Date().toISOString(),
  request_log_path: logPath,
  filters: {
    date: hasArg("--date") ? date : null,
    since_iso: sinceIso || null,
    until_iso: untilIso || null,
  },
  summary: {
    requests: rows.length,
    ok: rows.length - errors.length,
    errors: errors.length,
    total_raw_tokens_estimate: totalRaw,
    total_compact_tokens_estimate: totalCompact,
    total_saved_tokens_estimate: totalSaved,
    weighted_savings_pct: totalRaw > 0 ? round((totalSaved / totalRaw) * 100) : 0,
    low_confidence_count: highUncertainty.length,
    high_uncertainty_count: highUncertainty.length,
    actionable_high_uncertainty_count: actionableHighUncertainty.length,
    proof_loop_high_uncertainty_count: highUncertainty.length - actionableHighUncertainty.length,
    p95_latency_ms: percentile(durations, 0.95),
    first_ts: rows[0]?.ts || null,
    last_ts: rows.at(-1)?.ts || null,
  },
  by_tool: rollupBy(rows, (row) => row.tool),
  by_transport: rollupBy(rows, (row) => row.transport),
  by_parser: rollupBy(rows, (row) => row.output?.parser_used || "n/a"),
  by_scraper_fallback_reason: rollupBy(rows, (row) => row.output?.scraper_fallback_reason || "none"),
  by_trace_source: rollupBy(rows, traceSource),
  high_uncertainty_samples: highUncertainty.slice(-10).map(summarizeHighUncertainty),
  error_samples: errors.slice(-10).map((row) => ({
    ts: row.ts,
    tool: row.tool,
    transport: row.transport,
    duration_ms: row.duration_ms,
    error: row.error,
  })),
};
payload.pantheon_export = buildPantheonExport(payload);

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
