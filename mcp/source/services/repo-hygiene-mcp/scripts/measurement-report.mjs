#!/usr/bin/env node
import fs from "node:fs/promises";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const { getRepoHygieneConfig } = await import("../dist/config.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getRepoHygieneConfig();
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
          "# Repo Hygiene MCP Measurement",
          "",
          `Date: ${report.date}`,
          `Calls: ${report.usage.calls}`,
          `Errors: ${report.usage.failed_calls}`,
          `Candidates: ${report.quality.candidates_count}`,
          `Duplicate groups: ${report.quality.duplicate_groups}`,
          `Cycles: ${report.quality.cycles_count}`,
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
