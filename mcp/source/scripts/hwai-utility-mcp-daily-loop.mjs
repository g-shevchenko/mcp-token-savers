#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

async function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with exit ${code}: ${process.execPath} ${args.join(" ")}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function scanPantheonExport(value) {
  const leaks = [];
  const forbiddenKeys = new Set([
    "query",
    "corrected_query",
    "notes",
    "request_log_path",
    "feedback_log_path",
    "expected_paths",
    "missing_paths",
    "retrieved_paths",
    "opened_paths",
    "high_uncertainty_samples",
    "candidate_samples",
    "expected_paths",
    "missing_paths",
    "returned_paths",
    "error_samples",
    "raw_search_url",
    "compact_context_url",
    "artifact_url",
  ]);
  const localValuePatterns = [
    /\/Users\//,
    /\/\.hwai\//,
    /requests\.jsonl/,
    /feedback\.jsonl/,
    /raw_search/,
    /compact_context_url/,
  ];

  function visit(item, pathParts) {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, [...pathParts, String(index)]));
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        const nextPath = [...pathParts, key];
        if (forbiddenKeys.has(key)) {
          leaks.push({ path: nextPath.join("."), reason: `forbidden_key:${key}` });
        }
        visit(entry, nextPath);
      }
      return;
    }
    if (typeof item === "string") {
      for (const pattern of localValuePatterns) {
        if (pattern.test(item)) {
          leaks.push({ path: pathParts.join("."), reason: `forbidden_value:${pattern.source}` });
        }
      }
    }
  }

  visit(value, []);
  return leaks;
}

const date = argValue("--date", todayUtc());
const outDir = path.resolve(argValue("--out-dir", homePath(".hwai", "utility-mcp", "daily", date)));
const reportScript = path.join(repoRoot, "scripts", "hwai-utility-mcp-measurement-report.mjs");
const scraperAccountingScript = path.join(repoRoot, "scripts", "hwai-scraper-plane-accounting-report.mjs");
const markdownPath = path.join(outDir, `hwai-utility-mcp-digest-${date}.md`);
const pantheonPath = path.join(outDir, `hwai-utility-mcp-pantheon-${date}.json`);
const scraperMarkdownPath = path.join(outDir, `hwai-scraper-plane-accounting-${date}.md`);
const scraperPantheonPath = path.join(outDir, `hwai-scraper-plane-pantheon-${date}.json`);
const manifestPath = path.join(outDir, `hwai-utility-mcp-daily-manifest-${date}.json`);

await fs.mkdir(outDir, { recursive: true });

await runNode([reportScript, `--date=${date}`, "--format=markdown", `--out=${markdownPath}`]);
await runNode([reportScript, `--date=${date}`, "--format=pantheon", `--out=${pantheonPath}`]);
await runNode([scraperAccountingScript, `--date=${date}`, "--format=markdown", `--out=${scraperMarkdownPath}`]);
await runNode([scraperAccountingScript, `--date=${date}`, "--format=pantheon", `--out=${scraperPantheonPath}`]);

const pantheonExport = JSON.parse(await fs.readFile(pantheonPath, "utf8"));
const scraperPantheonExport = JSON.parse(await fs.readFile(scraperPantheonPath, "utf8"));
const leakageFindings = [
  ...scanPantheonExport(pantheonExport).map((item) => ({ ...item, export: "utility_mcp" })),
  ...scanPantheonExport(scraperPantheonExport).map((item) => ({ ...item, export: "scraper_plane" })),
];
const safeForPantheon =
  pantheonExport.safe_for_pantheon === true &&
  scraperPantheonExport.safe_for_pantheon === true &&
  leakageFindings.length === 0;
const manifest = {
  schema_version: "hwai-utility-mcp-daily-loop.v1",
  generated_at: new Date().toISOString(),
  date,
  safe_for_pantheon: safeForPantheon,
  outputs: {
    inbox_markdown_path: markdownPath,
    pantheon_export_path: pantheonPath,
    scraper_accounting_markdown_path: scraperMarkdownPath,
    scraper_accounting_pantheon_path: scraperPantheonPath,
    manifest_path: manifestPath,
  },
  leakage_scan: {
    passed: leakageFindings.length === 0,
    findings: leakageFindings,
  },
  summary: pantheonExport.summary,
  services: pantheonExport.services,
  scraper_plane: {
    summary: scraperPantheonExport.summary,
    by_endpoint: scraperPantheonExport.by_endpoint,
    by_mcp: scraperPantheonExport.by_mcp,
  },
};

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify(manifest, null, 2));

if (!safeForPantheon) {
  process.exit(1);
}
