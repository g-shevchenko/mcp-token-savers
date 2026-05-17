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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function dailyManifestPath(baseDir, date) {
  return path.join(baseDir, date, `hwai-utility-mcp-daily-manifest-${date}.json`);
}

function addIssue(issues, issue) {
  const existing = issues.find((item) => item.key === issue.key);
  if (existing) {
    existing.count += issue.count;
    existing.days.add(issue.date);
    existing.evidence.push(...issue.evidence);
    return;
  }
  issues.push({ ...issue, days: new Set([issue.date]) });
}

function serviceEntries(manifest) {
  return Object.entries(manifest?.services || {}).map(([name, row]) => ({ name, row }));
}

function classifyIssues(date, manifest, issues) {
  const auto = manifest?.automeasurement || {};
  if (number(auto.unknown_request_count) > 0) {
    addIssue(issues, {
      key: "measurement-unknown-traffic",
      date,
      priority: "P0",
      count: number(auto.unknown_request_count),
      title: "Traffic classification has unknown requests",
      evidence: [`${date}: ${auto.unknown_request_count} unknown request(s)`],
      next: "Fix safe metadata defaults or measurement inference before using this window for proof.",
    });
  }

  for (const { name, row } of serviceEntries(manifest)) {
    if (number(row.actionable_error_count) > 0) {
      addIssue(issues, {
        key: `${name}-actionable-errors`,
        date,
        priority: "P1",
        count: number(row.actionable_error_count),
        title: `${name} has actionable runtime errors`,
        evidence: [`${date}: ${row.actionable_error_count} error(s), tools=${Object.keys(row.by_tool || {}).join(", ") || "unknown"}`],
        next: "Inspect the service request log, classify root cause, and add a regression fixture or clearer fallback.",
      });
    }

    if (number(row.actionable_high_uncertainty_count) > 0) {
      addIssue(issues, {
        key: `${name}-high-uncertainty`,
        date,
        priority: "P1",
        count: number(row.actionable_high_uncertainty_count),
        title: `${name} returns high-uncertainty outputs`,
        evidence: [`${date}: ${row.actionable_high_uncertainty_count} high-uncertainty trace(s), p95=${number(row.p95_latency_ms)}ms`],
        next: "Promote the safest trace into a reviewed fixture, then tune ranking/parser confidence.",
      });
    }

    if (number(row.requests) >= 3 && number(row.savings_pct) < 10 && number(row.source_tokens_estimate) > 0) {
      addIssue(issues, {
        key: `${name}-low-savings`,
        date,
        priority: "P2",
        count: number(row.requests),
        title: `${name} has low token savings on repeated real use`,
        evidence: [`${date}: ${row.requests} request(s), savings=${number(row.savings_pct)}%`],
        next: "Review artifact/profile selection and avoid returning redundant context.",
      });
    }
  }
}

function renderMarkdown({ generatedAt, days, rows, issues }) {
  const lines = [];
  lines.push(`# Greg Dogfood Review Queue - ${days[0]}..${days[days.length - 1]}`);
  lines.push("");
  lines.push("Product: **Token Efficiency Platform for Agentic IDEs**  ");
  lines.push("Technical core: **HWAI Context Router**");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Window");
  lines.push("");
  lines.push(`- Days with reports: ${rows.filter((row) => row.has_report).length}/${days.length}`);
  lines.push(`- Real production-like requests: ${rows.reduce((sum, row) => sum + row.real_requests, 0)}`);
  lines.push(`- Unknown traffic-class requests: ${rows.reduce((sum, row) => sum + row.unknown_requests, 0)}`);
  lines.push("");
  lines.push("## Improvement Queue");
  lines.push("");
  if (issues.length === 0) {
    lines.push("- No actionable MCP improvement signal in this window. Keep collecting real workflows.");
  } else {
    for (const issue of issues.sort((a, b) => a.priority.localeCompare(b.priority) || b.count - a.count)) {
      lines.push(`- ${issue.priority} ${issue.title}`);
      lines.push(`  - Count: ${issue.count}; days: ${[...issue.days].sort().join(", ")}`);
      lines.push(`  - Evidence: ${issue.evidence.slice(0, 4).join("; ")}`);
      lines.push(`  - Next: ${issue.next}`);
    }
  }
  lines.push("");
  lines.push("## Claim Boundary");
  lines.push("");
  lines.push("This queue is internal dogfood evidence. Promote safe cases into reviewed fixtures before public claims.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const endDate = argValue("--end-date", todayLocal());
const daysCount = Number(argValue("--days", "7"));
const baseDir = path.resolve(argValue("--base-dir", path.join(os.homedir(), ".hwai", "token-efficiency-platform", "daily")));
const outPath = path.resolve(argValue("--out", path.join(baseDir, `greg-dogfood-review-queue-${endDate}.md`)));
const days = dateRange(endDate, Number.isFinite(daysCount) && daysCount > 0 ? daysCount : 7);

const rows = [];
const issues = [];
for (const date of days) {
  const manifest = await readJson(dailyManifestPath(baseDir, date));
  const auto = manifest?.automeasurement || {};
  rows.push({
    date,
    has_report: Boolean(manifest),
    real_requests: number(auto.real_production_like_request_count),
    unknown_requests: number(auto.unknown_request_count),
  });
  if (manifest) {
    classifyIssues(date, manifest, issues);
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, renderMarkdown({ generatedAt: new Date().toISOString(), days, rows, issues }), "utf8");
await fs.writeFile(`${outPath.replace(/\.md$/, "")}.json`, `${JSON.stringify({
  schema_version: "hwai-greg-dogfood-review-queue.v1",
  generated_at: new Date().toISOString(),
  window: { start: days[0], end: days[days.length - 1], days: days.length },
  rows,
  issues: issues.map((issue) => ({ ...issue, days: [...issue.days].sort() })),
}, null, 2)}\n`);

console.log(JSON.stringify({ wrote: outPath, issues: issues.length }, null, 2));
