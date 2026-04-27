import fs from "node:fs/promises";
import { LANGUAGE_GRAPH_MEASUREMENT_SCHEMA_VERSION, LanguageGraphConfig } from "./config.js";
import { round } from "./text-utils.js";

interface RequestLogLine {
  duration_ms?: number;
  ok?: boolean;
  output?: Record<string, unknown>;
  tool?: string;
  transport?: string;
  ts?: string;
}

export interface MeasurementWindowOptions {
  date?: string;
  since_iso?: string;
  until_iso?: string;
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

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateRange(options: MeasurementWindowOptions): { date: string; since: Date; until: Date } {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const since = options.since_iso ? new Date(options.since_iso) : new Date(`${date}T00:00:00.000Z`);
  const until = options.until_iso ? new Date(options.until_iso) : new Date(since.getTime() + 24 * 60 * 60 * 1000);
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

function sumOutput(rows: RequestLogLine[], key: string): number {
  return rows.reduce((sum, line) => sum + number(line.output?.[key]), 0);
}

export async function buildMeasurementReport(config: LanguageGraphConfig, options: MeasurementWindowOptions = {}) {
  const { date, since, until } = dateRange(options);
  const requests = (await readJsonl<RequestLogLine>(config.requestLogPath)).filter((line) => inRange(line.ts, since, until));
  const errors = requests.filter((line) => line.ok === false);
  const okRequests = requests.filter((line) => line.ok !== false);
  const latencies = requests.map((line) => number(line.duration_ms)).filter((value) => value > 0);
  const rawTokens = sumOutput(okRequests, "raw_tokens_estimate");
  const compactTokens = sumOutput(okRequests, "compact_tokens_estimate");
  const savedTokens = sumOutput(okRequests, "saved_tokens_estimate");
  const filesIndexed = sumOutput(okRequests, "files_indexed");
  const symbolsIndexed = sumOutput(okRequests, "symbols_indexed");
  const importsIndexed = sumOutput(okRequests, "imports_indexed");
  const dynamicImportsIndexed = sumOutput(okRequests, "dynamic_imports_indexed");
  const referencesIndexed = sumOutput(okRequests, "references_indexed");
  const referencesReturned = sumOutput(okRequests, "references_returned");
  const blastRadiusFiles = sumOutput(okRequests, "blast_radius_files");
  const staleFiles = sumOutput(okRequests, "stale_files");
  const estimatedUsdSaved = round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4);

  return {
    schema_version: LANGUAGE_GRAPH_MEASUREMENT_SCHEMA_VERSION,
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
      files_indexed: filesIndexed,
      symbols_indexed: symbolsIndexed,
      imports_indexed: importsIndexed,
      dynamic_imports_indexed: dynamicImportsIndexed,
      references_indexed: referencesIndexed,
      references_returned: referencesReturned,
      blast_radius_files: blastRadiusFiles,
      stale_files: staleFiles,
      artifact_outputs: okRequests.filter((line) => line.output?.artifact_file).length,
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
      service: "language-graph-mcp",
      date,
      calls: requests.length,
      ok_calls: okRequests.length,
      errors: errors.length,
      saved_tokens_estimate: savedTokens,
      files_indexed: filesIndexed,
      symbols_indexed: symbolsIndexed,
      imports_indexed: importsIndexed,
      dynamic_imports_indexed: dynamicImportsIndexed,
      references_indexed: referencesIndexed,
      references_returned: referencesReturned,
      blast_radius_files: blastRadiusFiles,
      stale_files: staleFiles,
      p95_latency_ms: percentile(latencies, 95),
      safe_for_pantheon: true,
      data_policy: {
        excludes: ["raw code", "file bodies", "raw queries", "relative paths", "absolute repo paths", "artifact URLs", "local log paths"],
        includes: ["aggregate call counts", "latency", "token estimates", "graph counts", "reference counts", "blast-radius counts"],
      },
    },
  };
}
