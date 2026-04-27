import fs from "node:fs/promises";
import { DOCS_SYNC_MEASUREMENT_SCHEMA_VERSION, DocsSyncConfig } from "./config.js";
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

const QUALITY_KEYS = [
  "action_docs_count",
  "action_items_count",
  "doc_count",
  "mirror_count",
  "missing_mirror_count",
  "missing_registry_entries_count",
  "missing_source_count",
  "scanned_docs_count",
  "stale_mirrors_count",
  "stale_registry_entries_count",
  "synced_mirror_count",
  "title_mismatch_count",
  "update_candidates_count",
];

function qualityCounters(rows: any[]): Record<string, number> {
  const quality: Record<string, number> = { artifact_outputs: rows.filter((row) => row.output?.artifact_file).length };
  for (const row of rows) {
    for (const key of QUALITY_KEYS) {
      const value = row.output?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        quality[key] = (quality[key] || 0) + value;
      }
    }
  }
  return Object.fromEntries(Object.entries(quality).sort((a, b) => a[0].localeCompare(b[0])));
}

export async function buildMeasurementReport(config: DocsSyncConfig, args: MeasurementArgs = {}) {
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
  const quality = qualityCounters(okRows);

  return {
    schema_version: DOCS_SYNC_MEASUREMENT_SCHEMA_VERSION,
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
      service: "docs-sync-mcp",
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
        includes_raw_doc_bodies: false,
        includes_notion_content: false,
        includes_notion_urls: false,
        includes_absolute_paths: false,
        includes_local_log_paths: false,
        includes_artifact_urls: false,
      },
    },
  };
}
