import fs from "node:fs/promises";
import { ROUTER_LITE_MEASUREMENT_SCHEMA_VERSION, RouterLiteConfig } from "./config.js";
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

function countBy(rows: any[], keyFn: (row: any) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index] || 0;
}

export async function buildMeasurementReport(config: RouterLiteConfig, args: MeasurementArgs = {}) {
  const date = args.date || todayUtc();
  const sinceIso = args.since_iso || `${date}T00:00:00.000Z`;
  const untilIso = args.until_iso || addDays(date, 1);
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const rows = (await readJsonl(config.requestLogPath)).filter((row) => {
    const ts = Date.parse(row.ts || "");
    return Number.isFinite(ts) && ts >= sinceMs && ts < untilMs;
  });
  const okRows = rows.filter((row) => row.ok !== false);
  const errors = rows.filter((row) => row.ok === false);
  const latencies = rows.map((row) => num(row.duration_ms)).filter((value) => value > 0);
  const rawTokens = okRows.reduce((sum, row) => sum + num(row.output?.raw_tokens_estimate), 0);
  const compactTokens = okRows.reduce((sum, row) => sum + num(row.output?.compact_tokens_estimate), 0);
  const savedTokens = okRows.reduce((sum, row) => sum + num(row.output?.saved_tokens_estimate), 0);
  const quality = {
    trigger_recommended_count: okRows.reduce((sum, row) => sum + num(row.output?.trigger_recommended), 0),
    skip_recommended_count: okRows.reduce((sum, row) => sum + num(row.output?.skip_recommended), 0),
    clarification_recommended_count: okRows.reduce((sum, row) => sum + num(row.output?.clarification_recommended), 0),
    frontier_required_count: okRows.reduce((sum, row) => sum + num(row.output?.frontier_required), 0),
    vision_recommended: okRows.reduce((sum, row) => sum + num(row.output?.vision_recommended), 0),
    context_prep_recommended: okRows.reduce((sum, row) => sum + num(row.output?.context_prep_recommended), 0),
    retrieval_recommended: okRows.reduce((sum, row) => sum + num(row.output?.retrieval_recommended), 0),
    scraper_recommended: okRows.reduce((sum, row) => sum + num(row.output?.scraper_recommended), 0),
  };

  return {
    schema_version: ROUTER_LITE_MEASUREMENT_SCHEMA_VERSION,
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
      by_tool: countBy(rows, (row) => String(row.tool || "unknown")),
      by_decision: countBy(okRows, (row) => String(row.output?.decision || "unknown")),
      by_recommended_mcp: countBy(
        okRows.flatMap((row) => (Array.isArray(row.output?.recommended_mcps) ? row.output.recommended_mcps : [])),
        (row) => String(row),
      ),
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
      service: "router-lite-mcp",
      date,
      calls: rows.length,
      ok_calls: okRows.length,
      errors: errors.length,
      ...quality,
      p95_latency_ms: percentile(latencies, 95),
      safe_for_pantheon: true,
      data_policy: {
        aggregate_only: true,
        includes_raw_prompts: false,
        includes_raw_code_bodies: false,
        includes_raw_doc_bodies: false,
        includes_urls: false,
        includes_absolute_paths: false,
        includes_artifact_urls: false,
      },
    },
  };
}
