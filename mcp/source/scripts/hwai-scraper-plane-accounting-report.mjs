#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultLogPath() {
  const candidates = [
    process.env.SCRAPER_LOG_JSONL_PATH,
    "/var/log/scraper-core/requests.jsonl",
    path.resolve("services/scraper-core/logs/requests.jsonl"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] || path.resolve("services/scraper-core/logs/requests.jsonl");
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
    if (error?.code === "ENOENT" || error?.code === "EACCES") {
      return [];
    }
    throw error;
  }
}

function timestampMs(row) {
  const raw = row?.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 10_000_000_000 ? raw * 1000 : raw;
  }
  const parsed = Date.parse(raw || "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index];
}

function safeLabel(value, fallback = "unknown") {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value.trim().replace(/[^A-Za-z0-9@._:/ -]/g, "_").slice(0, 96) || fallback;
}

function isError(row) {
  return Boolean(row?.error) || Number(row?.status || 0) >= 500;
}

function mcpName(row) {
  return safeLabel(row?.mcp_name || row?.mcp || "direct-http", "direct-http");
}

function endpointName(row) {
  return safeLabel(row?.endpoint || "unknown");
}

function engineName(row) {
  return safeLabel(row?.engine || row?.tier || "unknown");
}

function isBrowserOrPaidLike(row) {
  return /(browser|camoufox|decodo|patchright|real_chrome|scraping|proxy)/i.test(engineName(row));
}

function hasTraceId(row) {
  return typeof row?.trace_id === "string" && row.trace_id.trim().length > 0;
}

function hasContextTag(row) {
  return typeof row?.context === "string" && row.context.trim().length > 0;
}

function pct(part, total) {
  return total > 0 ? round((part / total) * 100) : 0;
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function groupedRollup(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = groups.get(key) || {
      requests: 0,
      errors: 0,
      cache_hits: 0,
      challenge_detected: 0,
      browser_or_paid_like: 0,
      cost_usd: 0,
      durations: [],
    };
    existing.requests += 1;
    existing.errors += isError(row) ? 1 : 0;
    existing.cache_hits += row?.cache_hit === true ? 1 : 0;
    existing.challenge_detected += row?.challenge_detected === true ? 1 : 0;
    existing.browser_or_paid_like += isBrowserOrPaidLike(row) ? 1 : 0;
    existing.cost_usd += number(row?.cost_usd) || number(row?.cost);
    existing.durations.push(number(row?.duration_ms));
    groups.set(key, existing);
  }
  return Object.fromEntries(
    Array.from(groups.entries())
      .sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]))
      .map(([key, value]) => [
        key,
        {
          requests: value.requests,
          errors: value.errors,
          cache_hits: value.cache_hits,
          challenge_detected: value.challenge_detected,
          browser_or_paid_like: value.browser_or_paid_like,
          cost_usd: round(value.cost_usd, 6),
          p95_latency_ms: percentile(value.durations, 0.95),
        },
      ]),
  );
}

function buildPantheonExport(report) {
  return {
    schema_version: "hwai-scraper-plane-accounting-pantheon.v1",
    generated_at: report.generated_at,
    safe_for_pantheon: true,
    data_policy: {
      aggregate_only: true,
      includes_raw_urls: false,
      includes_queries: false,
      includes_html: false,
      includes_markdown: false,
      includes_bodies: false,
      includes_local_log_paths: false,
      includes_samples: false,
    },
    filters: report.filters,
    summary: report.summary,
    by_endpoint: report.by_endpoint,
    by_mcp: report.by_mcp,
    by_engine: report.by_engine,
    by_caller_mcp_endpoint: report.by_caller_mcp_endpoint,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Scraper Plane Accounting Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Window: ${report.filters.since_iso} -> ${report.filters.until_iso}`);
  lines.push("");
  lines.push(`Requests: ${report.summary.requests}`);
  lines.push(`Errors: ${report.summary.errors}`);
  lines.push(`MCP-labeled share: ${report.summary.mcp_labeled_share_pct}%`);
  lines.push(`Direct HTTP share: ${report.summary.direct_http_share_pct}%`);
  lines.push(`Trace-id coverage: ${report.summary.trace_id_coverage_pct}%`);
  lines.push(`Context-tag coverage: ${report.summary.context_tag_coverage_pct}%`);
  lines.push(`Browser/proxy-like requests: ${report.summary.browser_or_paid_like_requests}`);
  lines.push(`Cache hits: ${report.summary.cache_hits}`);
  lines.push(`p95 latency: ${report.summary.p95_latency_ms} ms`);
  lines.push("");
  lines.push("Pantheon-safe export: `--format=pantheon` emits aggregate-only caller/MCP/endpoint/engine accounting without URLs, queries, bodies, HTML, markdown, local log paths, or samples.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const date = argValue("--date", todayUtc());
const sinceIso = argValue("--since", `${date}T00:00:00.000Z`);
const untilIso = argValue("--until", addDays(date, 1));
const sinceMs = Date.parse(sinceIso);
const untilMs = Date.parse(untilIso);
const logPath = path.resolve(argValue("--log", await defaultLogPath()));
const format = argValue("--format", "json");
const outPath = argValue("--out", "");
const rows = (await readJsonl(logPath)).filter((row) => {
  const ts = timestampMs(row);
  return Number.isFinite(ts) && ts >= sinceMs && ts < untilMs;
});
const durations = rows.map((row) => number(row?.duration_ms));
const errors = rows.filter(isError);
const directRows = rows.filter((row) => mcpName(row) === "direct-http");
const mcpRows = rows.filter((row) => mcpName(row) !== "direct-http");
const browserOrPaidLikeRows = rows.filter(isBrowserOrPaidLike);
const traceRows = rows.filter(hasTraceId);
const contextRows = rows.filter(hasContextTag);
const mcpTraceRows = mcpRows.filter(hasTraceId);
const mcpContextRows = mcpRows.filter(hasContextTag);
const costUsd = rows.reduce((sum, row) => sum + (number(row?.cost_usd) || number(row?.cost)), 0);

const report = {
  schema_version: "hwai-scraper-plane-accounting.v1",
  generated_at: new Date().toISOString(),
  request_log_path: logPath,
  filters: {
    date,
    since_iso: sinceIso,
    until_iso: untilIso,
  },
  summary: {
    requests: rows.length,
    ok: rows.length - errors.length,
    errors: errors.length,
    direct_http_requests: directRows.length,
    mcp_labeled_requests: mcpRows.length,
    direct_http_share_pct: pct(directRows.length, rows.length),
    mcp_labeled_share_pct: pct(mcpRows.length, rows.length),
    trace_id_tagged_requests: traceRows.length,
    context_tagged_requests: contextRows.length,
    trace_id_coverage_pct: pct(traceRows.length, rows.length),
    context_tag_coverage_pct: pct(contextRows.length, rows.length),
    mcp_trace_id_tagged_requests: mcpTraceRows.length,
    mcp_context_tagged_requests: mcpContextRows.length,
    mcp_trace_id_coverage_pct: pct(mcpTraceRows.length, mcpRows.length),
    mcp_context_tag_coverage_pct: pct(mcpContextRows.length, mcpRows.length),
    cache_hits: rows.filter((row) => row?.cache_hit === true).length,
    challenge_detected: rows.filter((row) => row?.challenge_detected === true).length,
    browser_or_paid_like_requests: browserOrPaidLikeRows.length,
    cost_usd: round(costUsd, 6),
    p95_latency_ms: percentile(durations, 0.95),
  },
  by_endpoint: groupedRollup(rows, endpointName),
  by_mcp: groupedRollup(rows, mcpName),
  by_engine: groupedRollup(rows, engineName),
  by_caller: countBy(rows, (row) => safeLabel(row?.caller || "unknown")),
  by_caller_mcp_endpoint: groupedRollup(rows, (row) =>
    `${safeLabel(row?.caller || "unknown")}|${mcpName(row)}|${endpointName(row)}`,
  ),
};
report.pantheon_export = buildPantheonExport(report);

const allowedFormats = new Set(["json", "markdown", "pantheon"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const rendered =
  format === "markdown"
    ? renderMarkdown(report)
    : format === "pantheon"
      ? `${JSON.stringify(report.pantheon_export, null, 2)}\n`
      : `${JSON.stringify(report, null, 2)}\n`;

if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), requests: rows.length, format }, null, 2));
} else {
  process.stdout.write(rendered);
}
