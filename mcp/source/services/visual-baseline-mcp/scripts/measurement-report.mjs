#!/usr/bin/env node
import { getVisualBaselineConfig } from "../dist/config.js";
import { buildMeasurementReport } from "../dist/measurement.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
const allowed = new Set(["json", "pantheon", "markdown"]);
if (!allowed.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowed).join(", ")}`);
  process.exit(1);
}

const report = await buildMeasurementReport(getVisualBaselineConfig(), {
  date: argValue("--date") || undefined,
  since_iso: argValue("--since") || undefined,
  until_iso: argValue("--until") || undefined,
});

const rendered =
  format === "pantheon"
    ? `${JSON.stringify(report.pantheon_export, null, 2)}\n`
    : format === "markdown"
      ? [
          "# Visual Baseline MCP Measurement",
          "",
          `Calls: ${report.usage.calls}`,
          `Baselines created: ${report.quality.baselines_created}`,
          `Compares: ${report.quality.compares}`,
          `Changed: ${report.quality.changed}`,
          `Saved tokens estimate: ${report.token_savings.saved_tokens_estimate}`,
          "",
        ].join("\n")
      : `${JSON.stringify(report, null, 2)}\n`;

process.stdout.write(rendered);
