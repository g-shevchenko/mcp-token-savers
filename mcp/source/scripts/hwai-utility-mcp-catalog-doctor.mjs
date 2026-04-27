#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const UTILITY_MCP_SERVICES = [
  "retrieval-mcp",
  "context-prep-mcp",
  "vision-mcp",
  "static-analysis-mcp",
  "agent-trace-mcp",
  "playwright-trace-mcp",
  "visual-baseline-mcp",
  "repo-history-mcp",
  "golden-dataset-mcp",
  "language-graph-mcp",
  "repo-hygiene-mcp",
  "docs-hygiene-mcp",
  "repo-quality-gate-mcp",
  "contract-schema-mcp",
  "dependency-risk-mcp",
  "docs-sync-mcp",
  "router-lite-mcp",
];

const REQUIRED_SCRIPTS = ["build", "smoke", "measurement:report"];
const RECOMMENDED_SCRIPTS = ["benchmark"];

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function cacheDirFor(service) {
  return path.join(os.homedir(), ".hwai", service);
}

function stdioSnippet(service, includeAbsolute) {
  const repoRelativePath = path.join("services", service, "scripts", "local-stdio.sh");
  const command = includeAbsolute ? path.join(repoRoot, repoRelativePath) : repoRelativePath;
  return { command, args: [] };
}

async function inspectService(service, includeAbsolute) {
  const serviceDir = path.join(repoRoot, "services", service);
  const packagePath = path.join(serviceDir, "package.json");
  const readmePath = path.join(serviceDir, "README.md");
  const stdioPath = path.join(serviceDir, "scripts", "local-stdio.sh");
  const pkg = await readJson(packagePath);
  const readme = await readText(readmePath);
  const scripts = pkg?.scripts || {};
  const issues = [];
  const warnings = [];

  if (!(await pathExists(serviceDir))) {
    issues.push("service_dir_missing");
  }
  if (!pkg) {
    issues.push("package_json_missing_or_invalid");
  }
  for (const scriptName of REQUIRED_SCRIPTS) {
    if (!scripts[scriptName]) {
      issues.push(`script_missing:${scriptName}`);
    }
  }
  for (const scriptName of RECOMMENDED_SCRIPTS) {
    if (!scripts[scriptName]) {
      warnings.push(`script_missing:${scriptName}`);
    }
  }
  if (!(await pathExists(stdioPath))) {
    issues.push("local_stdio_missing");
  } else if (!(await isExecutable(stdioPath))) {
    issues.push("local_stdio_not_executable");
  }
  if (!(await pathExists(readmePath))) {
    warnings.push("readme_missing");
  } else {
    if (!readme.includes("local-stdio.sh")) {
      warnings.push("readme_missing_local_stdio");
    }
    if (!readme.toLowerCase().includes("data policy")) {
      warnings.push("readme_missing_data_policy");
    }
  }

  return {
    service,
    status: issues.length === 0 ? "ok" : "needs_attention",
    package_name: pkg?.name || service,
    version: pkg?.version || "",
    repo_relative_service_dir: path.relative(repoRoot, serviceDir),
    repo_relative_stdio_path: path.relative(repoRoot, stdioPath),
    stdio_snippet: stdioSnippet(service, includeAbsolute),
    durable_cache_dir: includeAbsolute ? cacheDirFor(service) : `$HOME/.hwai/${service}`,
    scripts: Object.keys(scripts).sort(),
    issues,
    warnings,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# HWAI Utility MCP Catalog Doctor");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Repo: ${report.repo_root_label}`);
  lines.push(`Services: ${report.summary.services}`);
  lines.push(`OK: ${report.summary.ok}`);
  lines.push(`Needs attention: ${report.summary.needs_attention}`);
  lines.push(`Warnings: ${report.summary.warnings}`);
  lines.push("");
  lines.push("| Service | Status | Required issues | Warnings | Stdio path | Durable cache |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const service of report.services) {
    lines.push(
      `| ${service.service} | ${service.status} | ${service.issues.join(", ") || "-"} | ${
        service.warnings.join(", ") || "-"
      } | ${service.repo_relative_stdio_path} | ${service.durable_cache_dir} |`,
    );
  }
  lines.push("");
  lines.push("## Team Config Snippets");
  lines.push("");
  lines.push("Use the repo-relative `command` when the client config supports a workspace root; use `--include-absolute` for a local machine-specific config export.");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(Object.fromEntries(report.services.map((item) => [item.service, item.stdio_snippet])), null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Data policy: this doctor is static and does not read request logs, feedback logs, screenshots, traces, local artifacts, env files, credentials, or raw code bodies.");
  return `${lines.join("\n")}\n`;
}

const selected = argValue("--services", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const services = selected.length > 0 ? selected : UTILITY_MCP_SERVICES;
const includeAbsolute = hasFlag("--include-absolute");
const format = argValue("--format", "markdown");
const outPath = argValue("--out");
const failOnIssues = !hasFlag("--no-fail");

const serviceReports = [];
for (const service of services) {
  serviceReports.push(await inspectService(service, includeAbsolute));
}

const report = {
  schema_version: "hwai-utility-mcp-catalog-doctor.v1",
  generated_at: new Date().toISOString(),
  repo_root_label: includeAbsolute ? repoRoot : "<repo-root>",
  data_policy: {
    static_metadata_only: true,
    reads_request_logs: false,
    reads_feedback_logs: false,
    reads_screenshots: false,
    reads_traces: false,
    reads_env_files: false,
    reads_credentials: false,
    includes_absolute_paths: includeAbsolute,
  },
  summary: {
    services: serviceReports.length,
    ok: serviceReports.filter((item) => item.status === "ok").length,
    needs_attention: serviceReports.filter((item) => item.status !== "ok").length,
    warnings: serviceReports.reduce((total, item) => total + item.warnings.length, 0),
  },
  services: serviceReports,
};

const output = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : toMarkdown(report);
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), output, "utf8");
} else {
  process.stdout.write(output);
}

if (failOnIssues && report.summary.needs_attention > 0) {
  process.exit(1);
}
