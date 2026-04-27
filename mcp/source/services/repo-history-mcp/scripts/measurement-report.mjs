#!/usr/bin/env node
import { getRepoHistoryConfig } from "../dist/config.js";
import { buildMeasurementReport } from "../dist/measurement.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
const allowed = new Set(["json", "pantheon"]);
if (!allowed.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowed).join(", ")}`);
  process.exit(1);
}

const report = await buildMeasurementReport(getRepoHistoryConfig(), {
  date: argValue("--date") || undefined,
  since_iso: argValue("--since") || undefined,
  until_iso: argValue("--until") || undefined,
});

const payload = format === "pantheon" ? report.pantheon_export : report;
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
