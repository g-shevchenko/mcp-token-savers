import { AGENT_TRACE_MEASUREMENT_SCHEMA_VERSION, AgentTraceConfig } from "./config.js";
import { readJsonl } from "./event-store.js";
import { exportPantheonSafe, TraceWindowOptions } from "./trace.js";
import { round } from "./text-utils.js";

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

function dateRange(options: TraceWindowOptions): { date: string; since: Date; until: Date } {
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

export async function buildMeasurementReport(config: AgentTraceConfig, options: TraceWindowOptions = {}) {
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
  const pantheonExport = await exportPantheonSafe(config, options);
  const estimatedUsdSaved = round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4);

  return {
    schema_version: AGENT_TRACE_MEASUREMENT_SCHEMA_VERSION,
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
      sessions: pantheonExport.summary.sessions,
      events: pantheonExport.summary.events,
      unknown_source_count: pantheonExport.summary.unknown_source_count,
      high_uncertainty_count: pantheonExport.summary.high_uncertainty_count,
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
      service: "agent-trace-mcp",
      date,
      calls: requests.length,
      ok_calls: okRequests.length,
      errors: errors.length,
      sessions: pantheonExport.summary.sessions,
      events: pantheonExport.summary.events,
      saved_tokens_estimate: savedTokens,
      unknown_source_count: pantheonExport.summary.unknown_source_count,
      p95_latency_ms: percentile(latencies, 95),
      safe_for_pantheon: true,
      data_policy: pantheonExport.data_policy,
    },
  };
}
