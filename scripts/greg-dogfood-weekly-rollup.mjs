#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function todayLocal() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  return Array.from({ length: days }, (_, index) => addDays(endDate, index - days + 1));
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function dayManifestPath(baseDir, date) {
  return path.join(baseDir, date, `hwai-utility-mcp-daily-manifest-${date}.json`);
}

function dayNotePath(baseDir, date) {
  return path.join(baseDir, date, `greg-dogfood-note-${date}.md`);
}

function serviceCounts(manifest) {
  const rows = Object.values(manifest?.services || {});
  return {
    measured_today: rows.filter((row) => number(row.requests) > 0).length,
    production_like_services: rows.filter((row) => number(row.production_like_request_count) > 0).length,
  };
}

function renderMarkdown({ generatedAt, days, rows, summary }) {
  const lines = [];
  lines.push(`# Greg Dogfood Weekly Rollup - ${days[0]}..${days[days.length - 1]}`);
  lines.push("");
  lines.push("Product: **Token Efficiency Platform for Agentic IDEs**  ");
  lines.push("Technical core: **HWAI Context Router**  ");
  lines.push("Customer zero: Greg on Greg MacBook");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Days with reports: ${summary.days_with_reports}/${days.length}`);
  lines.push(`- Safe days: ${summary.safe_days}/${summary.days_with_reports}`);
  lines.push(`- Requests: ${summary.requests}`);
  lines.push(`- Production-like requests: ${summary.production_like_request_count}`);
  lines.push(`- Synthetic requests: ${summary.synthetic_request_count}`);
  lines.push(`- Real production-like requests: ${summary.real_production_like_request_count}`);
  lines.push(`- Max production-like services/day: ${summary.max_production_like_services}`);
  lines.push(`- Max measured services/day: ${summary.max_measured_services}`);
  lines.push(`- Unknown traffic-class requests: ${summary.unknown_request_count}`);
  lines.push(`- Metadata-labeled coverage: ${summary.metadata_labeled_pct}%`);
  lines.push(`- Saved tokens estimate: ${summary.saved_tokens_estimate}`);
  lines.push(`- Weighted savings: ${summary.savings_pct}%`);
  lines.push(`- Feedback benchmark candidates: ${summary.feedback_benchmark_candidates}`);
  lines.push("");
  lines.push("## Daily Rows");
  lines.push("");
  lines.push("| Date | Report | Safe | Requests | Prod-like Reqs | Synthetic | Real Prod-like | Prod-like Svcs | Measured Svcs | Unknown | Metadata | Saved Tokens | Savings | Note |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.date} | ${row.has_report ? "yes" : "no"} | ${row.safe_for_pantheon ? "yes" : "no"} | ${row.requests} | ${row.production_like_request_count} | ${row.synthetic_request_count} | ${row.real_production_like_request_count} | ${row.production_like_services} | ${row.measured_today} | ${row.unknown_request_count} | ${row.metadata_labeled_pct}% | ${row.saved_tokens_estimate} | ${row.savings_pct}% | ${row.has_note ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Next Tuning Focus");
  lines.push("");
  if (summary.days_with_reports === 0) {
    lines.push("- No daily reports yet. Let the LaunchAgent run or run `scripts/greg-dogfood-automeasurement.sh run-now`.");
  } else {
    if (summary.unknown_request_count > 0) {
      lines.push("- Improve agent metadata wiring: unknown traffic-class requests are still present.");
    }
    if (summary.production_like_request_count < 3) {
      lines.push("- Capture more real Greg workflows before making product claims.");
    }
    if (summary.real_production_like_request_count === 0 && summary.synthetic_request_count > 0) {
      lines.push("- Broad service coverage is synthetic; collect real Greg work before using these counts as product proof.");
    }
    if (summary.max_production_like_services < 15) {
      lines.push("- Run or repair `scripts/greg-dogfood-smoke.sh`; broad production-like service coverage is below target.");
    }
    if (summary.feedback_benchmark_candidates > 0) {
      lines.push("- Review benchmark candidates and promote safe misses into fixtures.");
    }
    if (summary.unknown_request_count === 0 && summary.real_production_like_request_count >= 3 && summary.max_production_like_services >= 15) {
      lines.push("- Metadata, real-work, and broad service coverage look healthy; next focus is misses and fixture promotion.");
    }
  }
  lines.push("");
  lines.push("This rollup is internal solo dogfood evidence. Do not publish it as a benchmark claim without review.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const endDate = argValue("--end-date", todayLocal());
const daysCount = Number(argValue("--days", "7"));
const baseDir = path.resolve(
  argValue("--base-dir", path.join(os.homedir(), ".hwai", "token-efficiency-platform", "daily")),
);
const outPath = path.resolve(argValue("--out", path.join(baseDir, `greg-dogfood-weekly-rollup-${endDate}.md`)));
const days = dateRange(endDate, Number.isFinite(daysCount) && daysCount > 0 ? daysCount : 7);

const rows = [];
for (const date of days) {
  const manifest = await readJson(dayManifestPath(baseDir, date));
  let hasNote = false;
  try {
    await fs.access(dayNotePath(baseDir, date));
    hasNote = true;
  } catch {
    hasNote = false;
  }
  const summary = manifest?.summary || {};
  const automeasurement = manifest?.automeasurement || {};
  const serviceCoverage = serviceCounts(manifest);
  rows.push({
    date,
    has_report: Boolean(manifest),
    has_note: hasNote,
    safe_for_pantheon: manifest?.safe_for_pantheon === true,
    requests: number(summary.requests),
    production_like_request_count: number(automeasurement.production_like_request_count),
    synthetic_request_count: number(automeasurement.synthetic_request_count),
    real_production_like_request_count: number(automeasurement.real_production_like_request_count),
    production_like_services: serviceCoverage.production_like_services,
    measured_today: serviceCoverage.measured_today,
    unknown_request_count: number(automeasurement.unknown_request_count),
    metadata_labeled_request_count: number(automeasurement.metadata_labeled_request_count),
    metadata_labeled_pct: number(automeasurement.metadata_labeled_pct),
    saved_tokens_estimate: number(summary.saved_tokens_estimate),
    source_tokens_estimate: number(summary.source_tokens_estimate),
    savings_pct: number(summary.savings_pct),
    feedback_benchmark_candidates: number(summary.feedback_benchmark_candidates),
  });
}

const summary = rows.reduce(
  (acc, row) => {
    if (row.has_report) acc.days_with_reports += 1;
    if (row.safe_for_pantheon) acc.safe_days += 1;
    acc.requests += row.requests;
    acc.production_like_request_count += row.production_like_request_count;
    acc.synthetic_request_count += row.synthetic_request_count;
    acc.real_production_like_request_count += row.real_production_like_request_count;
    acc.max_production_like_services = Math.max(acc.max_production_like_services, row.production_like_services);
    acc.max_measured_services = Math.max(acc.max_measured_services, row.measured_today);
    acc.unknown_request_count += row.unknown_request_count;
    acc.metadata_labeled_request_count += row.metadata_labeled_request_count;
    acc.saved_tokens_estimate += row.saved_tokens_estimate;
    acc.source_tokens_estimate += row.source_tokens_estimate;
    acc.feedback_benchmark_candidates += row.feedback_benchmark_candidates;
    return acc;
  },
  {
    days_with_reports: 0,
    safe_days: 0,
    requests: 0,
    production_like_request_count: 0,
    synthetic_request_count: 0,
    real_production_like_request_count: 0,
    max_production_like_services: 0,
    max_measured_services: 0,
    unknown_request_count: 0,
    metadata_labeled_request_count: 0,
    saved_tokens_estimate: 0,
    source_tokens_estimate: 0,
    feedback_benchmark_candidates: 0,
  },
);
summary.metadata_labeled_pct = pct(summary.metadata_labeled_request_count, summary.requests);
summary.savings_pct = pct(summary.saved_tokens_estimate, summary.source_tokens_estimate);

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, renderMarkdown({ generatedAt: new Date().toISOString(), days, rows, summary }), "utf8");
console.log(JSON.stringify({ wrote: outPath, summary }, null, 2));
