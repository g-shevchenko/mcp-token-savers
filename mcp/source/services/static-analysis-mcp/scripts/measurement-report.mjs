#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
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
  } catch {
    return [];
  }
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
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = String(row[key] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function safeTraceLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80);
}

function traceSource(row) {
  const direct = safeTraceLabel(row.trace_source);
  if (direct) {
    return direct;
  }
  const metadataSource = safeTraceLabel(row.input?.metadata_source);
  if (!metadataSource) {
    return "unknown";
  }
  const lower = metadataSource.toLowerCase();
  if (
    lower.includes("benchmark") ||
    lower.includes("smoke") ||
    lower.includes("regression") ||
    lower.includes("proof")
  ) {
    return "proof_loop";
  }
  return metadataSource;
}

function traceSourceCounts(rows) {
  const labels = rows.map((row) => ({ ...row, _trace_source: traceSource(row) }));
  const byLabel = countBy(labels, "_trace_source");
  return {
    proof_loop: labels.filter((row) => row._trace_source === "proof_loop").length,
    unknown: labels.filter((row) => row._trace_source === "unknown").length,
    labeled: labels.filter((row) => row._trace_source !== "proof_loop" && row._trace_source !== "unknown").length,
    by_label: byLabel,
  };
}

const date = argValue("--date", todayUtc());
const sinceIso = argValue("--since", `${date}T00:00:00.000Z`);
const untilIso = argValue("--until", addDays(date, 1));
const requestLogPath =
  process.env.STATIC_ANALYSIS_REQUEST_LOG_PATH ||
  path.join(os.homedir(), ".hwai", "static-analysis-mcp", "requests.jsonl");
const sinceMs = Date.parse(sinceIso);
const untilMs = Date.parse(untilIso);
const requests = (await readJsonl(requestLogPath)).filter((row) => {
  const ts = Date.parse(row.ts || "");
  return Number.isFinite(ts) && ts >= sinceMs && ts < untilMs;
});
const errors = requests.filter((row) => row.ok === false);
const okRequests = requests.filter((row) => row.ok !== false);
const latencies = requests.map((row) => number(row.duration_ms)).filter((value) => value > 0);
const rawTokens = okRequests.reduce((sum, row) => sum + number(row.output?.raw_tokens_estimate), 0);
const compactTokens = okRequests.reduce((sum, row) => sum + number(row.output?.compact_tokens_estimate), 0);
const savedTokens = okRequests.reduce((sum, row) => sum + number(row.output?.saved_tokens_estimate), 0);
const findings = okRequests.reduce((sum, row) => sum + number(row.output?.findings_count), 0);
const traceCounts = traceSourceCounts(requests);

const pantheonExport = {
  schema_version: "static-analysis-mcp-pantheon-export.v1",
  generated_at: new Date().toISOString(),
  service: "static-analysis-mcp",
  safe_for_pantheon: true,
  data_policy: {
    aggregate_only: true,
    includes_raw_command_output: false,
    includes_file_paths: false,
    includes_local_log_paths: false,
    includes_samples: false,
    includes_artifact_urls: false,
  },
  filters: { date, since_iso: sinceIso, until_iso: untilIso },
  summary: {
    requests: requests.length,
    ok: okRequests.length,
    errors: errors.length,
    total_raw_tokens_estimate: rawTokens,
    total_compact_tokens_estimate: compactTokens,
    total_saved_tokens_estimate: savedTokens,
    weighted_savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
    findings_count: findings,
    failed_runs: okRequests.filter((row) => row.output?.status === "failed").length,
    skipped_runs: okRequests.filter((row) => row.output?.status === "skipped").length,
    trace_source_counts: {
      proof_loop: traceCounts.proof_loop,
      unknown: traceCounts.unknown,
      labeled: traceCounts.labeled,
    },
    p95_latency_ms: percentile(latencies, 95),
  },
  by_tool: countBy(requests, "tool"),
  by_transport: countBy(requests, "transport"),
  by_trace_source: traceCounts.by_label,
};

const format = argValue("--format", "json");
const allowedFormats = new Set(["json", "pantheon", "markdown"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const fullReport = {
  schema_version: "static-analysis-measurement-report.v1",
  generated_at: new Date().toISOString(),
  request_log_path: requestLogPath,
  pantheon_export: pantheonExport,
};

const rendered =
  format === "pantheon"
    ? `${JSON.stringify(pantheonExport, null, 2)}\n`
    : format === "markdown"
      ? `# Static Analysis MCP Measurement\n\nRequests: ${pantheonExport.summary.requests}\nSaved tokens estimate: ${pantheonExport.summary.total_saved_tokens_estimate}\nFindings: ${pantheonExport.summary.findings_count}\nProof-loop calls: ${traceCounts.proof_loop}\nLabeled calls: ${traceCounts.labeled}\nUnknown trace-source calls: ${traceCounts.unknown}\n`
      : `${JSON.stringify(fullReport, null, 2)}\n`;

const outPath = argValue("--out", "");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), format }, null, 2));
} else {
  process.stdout.write(rendered);
}
