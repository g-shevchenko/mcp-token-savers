#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getRetrievalConfig } from "../dist/config.js";
import { buildMeasurementReport } from "../dist/measurement.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Retrieval MCP Measurement Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Window: ${report.window.since_iso} -> ${report.window.until_iso}`);
  lines.push("");
  lines.push(`Calls: ${report.usage.calls}`);
  lines.push(`Failed calls: ${report.usage.failed_calls}`);
  lines.push(`Saved tokens estimate: ${report.token_savings.saved_tokens_estimate}`);
  lines.push(`Weighted savings: ${report.token_savings.savings_pct}%`);
  lines.push(`Feedback count: ${report.quality.feedback_count}`);
  lines.push(`Miss/partial count: ${report.quality.miss_or_partial_count}`);
  lines.push(`p95 latency ms: ${report.usage.latency_ms.p95}`);
  lines.push("");
  lines.push("## Traffic Classes");
  lines.push("");
  lines.push("| Class | Calls | Saved Tokens | Feedback | Coverage | Miss/Partial | Frontier Search |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const className of ["production_like", "proof", "benchmark", "unknown"]) {
    const item = report.traffic?.[className] || {};
    lines.push(
      `| ${className} | ${item.calls || 0} | ${item.saved_tokens_estimate || 0} | ${item.feedback_count || 0} | ${item.feedback_coverage_pct || 0}% | ${item.miss_or_partial_count || 0} | ${item.frontier_search_count || 0} |`,
    );
  }
  lines.push("");
  lines.push(
    `Feedback discipline: production_like=${report.quality.production_like_feedback_count}/${report.usage.production_like_calls} (${report.quality.production_like_feedback_coverage_pct}%). Record feedback only after real partial/miss/wrong-context/manual-search cases; do not add filler helpful feedback.`,
  );
  lines.push("");
  lines.push(
    "Pantheon-safe export: `--format=pantheon` returns aggregate telemetry without raw queries, code, samples, local paths, or artifact URLs.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const date = argValue("--date", todayUtc());
const sinceIso = argValue("--since", `${date}T00:00:00.000Z`);
const untilIso = argValue("--until", addDays(date, 1));
const format = argValue("--format", "json");
const allowedFormats = new Set(["json", "pantheon", "markdown"]);

if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const report = await buildMeasurementReport(getRetrievalConfig(), {
  date,
  since_iso: sinceIso,
  until_iso: untilIso,
  include_samples: hasFlag("--include-samples"),
});

const rendered =
  format === "pantheon"
    ? `${JSON.stringify(
        {
          schema_version: "retrieval-mcp-pantheon-export.v1",
          generated_at: new Date().toISOString(),
          service: "retrieval-mcp",
          safe_for_pantheon: true,
          data_policy: {
            aggregate_only: true,
            includes_raw_queries: false,
            includes_code: false,
            includes_file_paths: false,
            includes_local_log_paths: false,
            includes_samples: false,
            includes_artifact_urls: false,
          },
          filters: {
            date,
            since_iso: sinceIso,
            until_iso: untilIso,
          },
          summary: {
            calls: report.usage.calls,
            ok_calls: report.usage.ok_calls,
            failed_calls: report.usage.failed_calls,
            production_like_calls: report.usage.production_like_calls,
            proof_calls: report.usage.proof_calls,
            benchmark_calls: report.usage.benchmark_calls,
            unknown_calls: report.usage.unknown_calls,
            saved_tokens_estimate: report.token_savings.saved_tokens_estimate,
            production_like_saved_tokens_estimate: report.traffic?.production_like?.saved_tokens_estimate || 0,
            savings_pct: report.token_savings.savings_pct,
            estimated_usd_saved: report.token_savings.estimated_usd_saved,
            feedback_count: report.quality.feedback_count,
            production_like_feedback_count: report.quality.production_like_feedback_count,
            production_like_feedback_coverage_pct: report.quality.production_like_feedback_coverage_pct,
            miss_or_partial_count: report.quality.miss_or_partial_count,
            frontier_search_count: report.quality.frontier_search_count,
            feedback_coverage_pct: report.quality.feedback_coverage_pct,
            p95_latency_ms: report.usage.latency_ms.p95,
          },
          by_tool: report.usage.by_tool,
          by_transport: report.usage.by_transport,
          by_traffic_class: report.usage.by_traffic_class,
          outcome_counts: report.quality.outcome_counts,
        },
        null,
        2,
      )}\n`
    : format === "markdown"
      ? renderMarkdown(report)
      : `${JSON.stringify(report, null, 2)}\n`;

const outPath = argValue("--out", "");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), format }, null, 2));
} else {
  process.stdout.write(rendered);
}
