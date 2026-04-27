import fs from "node:fs/promises";
import { REPO_QUALITY_GATE_MEASUREMENT_SCHEMA_VERSION, RepoQualityGateConfig } from "./config.js";
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

export async function buildMeasurementReport(config: RepoQualityGateConfig, args: MeasurementArgs = {}) {
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
    added_code_lines: okRows.reduce((sum, row) => sum + num(row.output?.added_code_lines), 0),
    added_doc_lines: okRows.reduce((sum, row) => sum + num(row.output?.added_doc_lines), 0),
    artifact_outputs: okRows.filter((row) => row.output?.artifact_file).length,
    budget_checks: okRows.filter((row) => String(row.tool || "").includes("budget")).length,
    changed_code_files: okRows.reduce((sum, row) => sum + num(row.output?.changed_code_files), 0),
    changed_doc_files: okRows.reduce((sum, row) => sum + num(row.output?.changed_doc_files), 0),
    changed_files: okRows.reduce((sum, row) => sum + num(row.output?.changed_files), 0),
    context_pressure_score: okRows.reduce((sum, row) => sum + num(row.output?.context_pressure_score), 0),
    frontmatter_missing_count: okRows.reduce((sum, row) => sum + num(row.output?.frontmatter_missing_count), 0),
    growth_findings_count: okRows.reduce((sum, row) => sum + num(row.output?.growth_findings_count), 0),
    large_docs_count: okRows.reduce((sum, row) => sum + num(row.output?.large_docs_count), 0),
    over_budget_count: okRows.reduce((sum, row) => sum + num(row.output?.over_budget_count), 0),
    plan_items_count: okRows.reduce((sum, row) => sum + num(row.output?.plan_items_count), 0),
    scan_truncated_count: okRows.reduce((sum, row) => sum + num(row.output?.scan_truncated_count), 0),
    snapshot_candidate_files_seen: okRows.reduce((sum, row) => sum + num(row.output?.snapshot_candidate_files_seen), 0),
    snapshot_code_lines: okRows.reduce((sum, row) => sum + num(row.output?.snapshot_code_lines || row.output?.code_lines), 0),
    snapshot_doc_lines: okRows.reduce((sum, row) => sum + num(row.output?.snapshot_doc_lines || row.output?.doc_lines), 0),
    snapshot_files: okRows.reduce((sum, row) => sum + num(row.output?.snapshot_files || row.output?.scanned_files), 0),
  };

  return {
    schema_version: REPO_QUALITY_GATE_MEASUREMENT_SCHEMA_VERSION,
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
      service: "repo-quality-gate-mcp",
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
        includes_raw_code_bodies: false,
        includes_raw_doc_bodies: false,
        includes_absolute_paths: false,
        includes_local_log_paths: false,
        includes_artifact_urls: false,
      },
    },
  };
}
