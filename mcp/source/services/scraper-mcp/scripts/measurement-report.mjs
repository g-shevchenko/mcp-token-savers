#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const format = argValue("--format", "json");
if (!["json", "pantheon"].includes(format)) {
  console.error(`unsupported format: ${format}`);
  process.exit(2);
}

const report = {
  schema_version: "hwai-external-context-mcp-measurement.v1",
  generated_at: new Date().toISOString(),
  service: "scraper-mcp",
  format,
  summary: {
    local_wrapper_requests_logged_here: 0,
    accounting_source: "scraper-core /var/log/scraper-core/requests.jsonl",
  },
  data_policy: {
    aggregate_only: true,
    excludes_raw_urls: true,
    excludes_html: true,
    excludes_markdown: true,
    excludes_request_bodies: true,
    excludes_env_values: true,
  },
};

const out = argValue("--out");
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), text);
} else {
  process.stdout.write(text);
}
