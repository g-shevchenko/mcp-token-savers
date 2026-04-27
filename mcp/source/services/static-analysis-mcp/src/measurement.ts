import fs from "node:fs/promises";
import { StaticAnalysisConfig } from "./config.js";

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
  trace_source?: string;
  transport?: string;
  ts?: string;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
  } catch {
    return [];
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

function traceSource(row: RequestLogLine): string {
  const raw = typeof row.trace_source === "string" && row.trace_source.trim()
    ? row.trace_source.trim()
    : "unknown";
  if (raw === "unknown" || raw === "proof_loop") {
    return raw;
  }
  return "labeled";
}

function traceSourceCounts(rows: RequestLogLine[]) {
  return {
    proof_loop: rows.filter((row) => traceSource(row) === "proof_loop").length,
    unknown: rows.filter((row) => traceSource(row) === "unknown").length,
    labeled: rows.filter((row) => traceSource(row) === "labeled").length,
    by_label: countBy(rows, "trace_source"),
  };
}

export async function buildMeasurementReport(config: StaticAnalysisConfig, options: MeasurementOptions = {}) {
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
  const findings = okRequests.reduce((sum, line) => sum + number(line.output?.findings_count), 0);
  const failedRuns = okRequests.filter((line) => line.output?.status === "failed").length;
  const skippedRuns = okRequests.filter((line) => line.output?.status === "skipped").length;
  const p95LatencyMs = percentile(latencies, 95);
  const estimatedUsdSaved = round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4);
  const traceCounts = traceSourceCounts(requests);

  return {
    schema_version: "static-analysis-measurement.v1",
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
      trace_source_counts: traceCounts,
      latency_ms: {
        p95: p95LatencyMs,
        max: latencies.length ? Math.max(...latencies) : 0,
      },
    },
    quality: {
      findings_count: findings,
      failed_runs: failedRuns,
      skipped_runs: skippedRuns,
      proof_loop_calls: traceCounts.proof_loop,
      labeled_calls: traceCounts.labeled,
      unknown_trace_source_calls: traceCounts.unknown,
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
      service: "static-analysis-mcp",
      date,
      calls: requests.length,
      ok_calls: okRequests.length,
      errors: errors.length,
      saved_tokens_estimate: savedTokens,
      findings_count: findings,
      failed_runs: failedRuns,
      skipped_runs: skippedRuns,
      trace_source_counts: {
        proof_loop: traceCounts.proof_loop,
        unknown: traceCounts.unknown,
        labeled: traceCounts.labeled,
      },
      p95_latency_ms: p95LatencyMs,
      safe_for_pantheon: true,
      data_policy: {
        aggregate_only: true,
        includes_raw_command_output: false,
        includes_file_paths: false,
        includes_local_log_paths: false,
        includes_artifact_urls: false,
      },
    },
  };
}
