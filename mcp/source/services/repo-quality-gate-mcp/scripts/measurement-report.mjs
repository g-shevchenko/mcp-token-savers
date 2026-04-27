#!/usr/bin/env node
import fs from "node:fs/promises";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const { getRepoQualityGateConfig } = await import("../dist/config.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getRepoQualityGateConfig();
const report = await buildMeasurementReport(config, {
  date: argValue("--date") || undefined,
  since_iso: argValue("--since") || undefined,
  until_iso: argValue("--until") || undefined,
});

const format = argValue("--format", "json");
const rendered =
  format === "pantheon"
    ? `${JSON.stringify(report.pantheon_export, null, 2)}\n`
    : format === "markdown"
      ? [
          "# Repo Quality Gate MCP Measurement",
          "",
          `Date: ${report.date}`,
          `Calls: ${report.usage.calls}`,
          `Errors: ${report.usage.failed_calls}`,
          `Budget checks: ${report.quality.budget_checks}`,
          `Over-budget signals: ${report.quality.over_budget_count}`,
          `Changed files: ${report.quality.changed_files}`,
          `Added code lines: ${report.quality.added_code_lines}`,
          `Added doc lines: ${report.quality.added_doc_lines}`,
          `Plan items: ${report.quality.plan_items_count}`,
          `Saved tokens estimate: ${report.token_savings.saved_tokens_estimate}`,
          `Pantheon safe: ${report.pantheon_export.safe_for_pantheon}`,
          "",
        ].join("\n")
      : `${JSON.stringify(report, null, 2)}\n`;

if (!["json", "markdown", "pantheon"].includes(format)) {
  console.error(`Unsupported --format=${format}`);
  process.exit(1);
}

const out = argValue("--out");
if (out) {
  await fs.writeFile(out, rendered, "utf8");
} else {
  process.stdout.write(rendered);
}
