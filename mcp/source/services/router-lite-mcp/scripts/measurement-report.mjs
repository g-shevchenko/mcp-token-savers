#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
if (!["json", "pantheon"].includes(format)) {
  console.error(`Unsupported format: ${format}`);
  process.exit(2);
}

const { getRouterLiteConfig } = await import("../dist/config.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const report = await buildMeasurementReport(getRouterLiteConfig(), {
  date: argValue("--date") || undefined,
  since_iso: argValue("--since") || undefined,
  until_iso: argValue("--until") || undefined,
});
const payload = format === "pantheon" ? report.pantheon_export : report;
const output = `${JSON.stringify(payload, null, 2)}\n`;
const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), output, "utf8");
} else {
  process.stdout.write(output);
}
