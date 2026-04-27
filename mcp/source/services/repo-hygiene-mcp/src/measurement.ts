import fs from "node:fs/promises";
import {
  REPO_HYGIENE_MEASUREMENT_SCHEMA_VERSION,
  RepoHygieneConfig,
} from "./config.js";
import { round } from "./text-utils.js";

interface MeasurementArgs {
  date?: string;
  since_iso?: string;
  until_iso?: string;
}

async function readJsonl(filePath: string): Promise<any[]> {
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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index] || 0;
}

function countBy(rows: any[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] || "unknown");
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export async function buildMeasurementReport(config: RepoHygieneConfig, args: MeasurementArgs = {}) {
  const date = args.date || todayUtc();
  const sinceIso = args.since_iso || `${date}T00:00:00.000Z`;
  const untilIso = args.until_iso || addDays(date, 1);
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const rows = (await readJsonl(config.requestLogPath)).filter((row) => {
    const ts = Date.parse(row.ts || "");
    return Number.isFinite(ts) && ts >= sinceMs && ts < untilMs;
  });
  const errors = rows.filter((row) => row.ok === false);
  const okRows = rows.filter((row) => row.ok !== false);
  const rawTokens = okRows.reduce((sum, row) => sum + num(row.output?.raw_tokens_estimate), 0);
  const compactTokens = okRows.reduce((sum, row) => sum + num(row.output?.compact_tokens_estimate), 0);
  const savedTokens = okRows.reduce((sum, row) => sum + num(row.output?.saved_tokens_estimate), 0);
  const latencies = rows.map((row) => num(row.duration_ms)).filter((value) => value > 0);
  const quality = {
    candidates_count: okRows.reduce((sum, row) => sum + num(row.output?.candidates_count), 0),
    dependencies_total: okRows.reduce((sum, row) => sum + num(row.output?.dependencies_total), 0),
    dynamic_imports_seen: okRows.reduce((sum, row) => sum + num(row.output?.dynamic_imports_seen), 0),
    duplicate_groups: okRows.reduce((sum, row) => sum + num(row.output?.duplicate_groups), 0),
    cycles_count: okRows.reduce((sum, row) => sum + num(row.output?.cycles_count), 0),
    hotspots_count: okRows.reduce((sum, row) => sum + num(row.output?.hotspots_count), 0),
    plan_items_count: okRows.reduce((sum, row) => sum + num(row.output?.plan_items_count), 0),
    artifact_outputs: okRows.filter((row) => row.output?.artifact_file).length,
  };

  return {
    schema_version: REPO_HYGIENE_MEASUREMENT_SCHEMA_VERSION,
    date,
    time_basis: "UTC",
    window: {
      since_iso: sinceIso,
      until_iso: untilIso,
    },
    usage: {
      calls: rows.length,
      ok_calls: okRows.length,
      failed_calls: errors.length,
      by_tool: countBy(rows, "tool"),
      by_transport: countBy(rows, "transport"),
      latency_ms: {
        p95: percentile(latencies, 95),
        max: latencies.length ? Math.max(...latencies) : 0,
      },
    },
    quality,
    token_savings: {
      raw_tokens_estimate: rawTokens,
      compact_tokens_estimate: compactTokens,
      saved_tokens_estimate: savedTokens,
      savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
      estimated_usd_saved: round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4),
      usd_per_1m_tokens: config.measurementUsdPer1MTokens,
    },
    pantheon_export: {
      service: "repo-hygiene-mcp",
      date,
      calls: rows.length,
      ok_calls: okRows.length,
      errors: errors.length,
      saved_tokens_estimate: savedTokens,
      ...quality,
      p95_latency_ms: percentile(latencies, 95),
      safe_for_pantheon: true,
      data_policy: {
        aggregate_only: true,
        includes_raw_code: false,
        includes_file_bodies: false,
        includes_absolute_paths: false,
        includes_artifact_urls: false,
      },
    },
  };
}
