#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { buildMeasurementReport } from "../dist/measurement.js";
import { getLanguageGraphConfig } from "../dist/config.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
const allowedFormats = new Set(["json", "pantheon"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const report = await buildMeasurementReport(getLanguageGraphConfig(), {
  date: argValue("--date", undefined),
  since_iso: argValue("--since", undefined),
  until_iso: argValue("--until", undefined),
});

const rendered =
  format === "pantheon"
    ? `${JSON.stringify(report.pantheon_export, null, 2)}\n`
    : `${JSON.stringify(report, null, 2)}\n`;

const outPath = argValue("--out", "");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), format }, null, 2));
} else {
  process.stdout.write(rendered);
}
