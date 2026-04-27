#!/usr/bin/env node
import { spawn } from "node:child_process";
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

const EXTENDED_SCRIPTS = {
  "agent-trace-mcp": ["benchmark:playwright"],
  "playwright-trace-mcp": ["benchmark:real", "benchmark:agent-trace", "benchmark:vision"],
  "vision-mcp": ["benchmark:playwright"],
  "visual-baseline-mcp": ["benchmark:hwai-verify"],
};

const NETWORK_SCRIPTS = {
  "visual-baseline-mcp": ["benchmark:cdn"],
};

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function timestampSafe() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readPackage(service) {
  const packagePath = path.join(repoRoot, "services", service, "package.json");
  try {
    return JSON.parse(await fs.readFile(packagePath, "utf8"));
  } catch (error) {
    return { name: service, scripts: {}, missing: error?.code === "ENOENT" };
  }
}

function npmCommand(script, args = []) {
  return {
    command: "npm",
    args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])],
  };
}

function npmInstallCommand() {
  return {
    command: "npm",
    args: ["ci", "--ignore-scripts"],
  };
}

function commandForStep(service, step, outDir, date) {
  const serviceOut = path.join(outDir, "services", service);
  if (step === "build") {
    return npmCommand("build");
  }
  if (step === "smoke") {
    return npmCommand("smoke");
  }
  if (step === "benchmark") {
    return npmCommand("benchmark", [`--out=${path.join(serviceOut, "benchmark.json")}`]);
  }
  if (step.startsWith("benchmark:")) {
    return npmCommand(step, [`--out=${path.join(serviceOut, `${step.replace(/[:/]/g, "-")}.json`)}`]);
  }
  if (step === "measurement:report") {
    return npmCommand("measurement:report", [
      `--date=${date}`,
      "--format=pantheon",
      `--out=${path.join(serviceOut, "measurement-pantheon.json")}`,
    ]);
  }
  return npmCommand(step);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function shouldInstallDependencies(service, scripts) {
  const serviceDir = path.join(repoRoot, "services", service);
  const lockPath = path.join(serviceDir, "package-lock.json");
  const nodeModulesPath = path.join(serviceDir, "node_modules");
  if (!(await pathExists(lockPath))) {
    return false;
  }
  if (!(await pathExists(nodeModulesPath))) {
    return true;
  }
  const buildScript = scripts.build || "";
  if (buildScript.includes("tsc") && !(await pathExists(path.join(nodeModulesPath, ".bin", "tsc")))) {
    return true;
  }
  return false;
}

async function writeMarkdown(report, filePath) {
  const lines = [];
  lines.push("# HWAI Utility MCP System Audit");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Date: ${report.date}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Install missing dependencies: ${report.install_missing}`);
  lines.push(`Services: ${report.summary.services_total}`);
  lines.push(`Commands: ${report.summary.commands_total}`);
  lines.push(`Passed: ${report.summary.commands_passed}`);
  lines.push(`Failed: ${report.summary.commands_failed}`);
  lines.push(`Skipped: ${report.summary.commands_skipped}`);
  lines.push(`Duration: ${report.summary.duration_ms} ms`);
  lines.push("");
  lines.push("| Service | Step | Status | Duration ms | Log |");
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (const result of report.results) {
    lines.push(
      `| ${result.service} | ${result.step} | ${result.status} | ${result.duration_ms} | ${result.log_file || ""} |`,
    );
  }
  if (report.daily_loop) {
    lines.push("");
    lines.push("## Daily Loop");
    lines.push("");
    lines.push(`Status: ${report.daily_loop.status}`);
    lines.push(`Duration: ${report.daily_loop.duration_ms} ms`);
    lines.push(`Log: ${report.daily_loop.log_file || ""}`);
  }
  lines.push("");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function runCommand({ service, step, cwd, command, args, timeoutMs, logDir }) {
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${service}-${step.replace(/[:/]/g, "-")}.log`);
  const started = Date.now();
  let timedOut = false;
  let stdout = "";
  let stderr = "";
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  await fs.writeFile(
    logFile,
    [
      `$ cwd=${cwd}`,
      `$ ${command} ${args.join(" ")}`,
      `$ exit_code=${exitCode}`,
      `$ timed_out=${timedOut}`,
      "",
      "## stdout",
      stdout,
      "",
      "## stderr",
      stderr,
    ].join("\n"),
    "utf8",
  );
  return {
    service,
    step,
    status: exitCode === 0 && !timedOut ? "passed" : timedOut ? "timeout" : "failed",
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms: durationMs,
    log_file: path.relative(path.dirname(logDir), logFile),
  };
}

const date = argValue("--date", todayUtc());
const mode = hasFlag("--extended") ? "extended" : "local";
const includeNetwork = hasFlag("--network");
const installMissing = !hasFlag("--no-install");
const skipDaily = hasFlag("--skip-daily");
const timeoutMs = Number(argValue("--timeout-ms", "180000"));
const selected = argValue("--services", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const services = selected.length > 0 ? selected : UTILITY_MCP_SERVICES;
const outDir = path.resolve(
  argValue("--out-dir", path.join(os.tmpdir(), `hwai-utility-mcp-system-audit-${date}-${timestampSafe()}`)),
);
const logDir = path.join(outDir, "logs");
const results = [];
const startedAt = Date.now();

await fs.mkdir(outDir, { recursive: true });

for (const service of services) {
  const serviceDir = path.join(repoRoot, "services", service);
  const pkg = await readPackage(service);
  const scripts = pkg.scripts || {};
  const wanted = ["build", "smoke", "benchmark", "measurement:report"];
  if (mode === "extended") {
    wanted.push(...(EXTENDED_SCRIPTS[service] || []));
  }
  if (includeNetwork) {
    wanted.push(...(NETWORK_SCRIPTS[service] || []));
  }

  await fs.mkdir(path.join(outDir, "services", service), { recursive: true });
  let buildFailed = false;
  if (installMissing && (await shouldInstallDependencies(service, scripts))) {
    const install = npmInstallCommand();
    const result = await runCommand({
      service,
      step: "install",
      cwd: serviceDir,
      command: install.command,
      args: install.args,
      timeoutMs,
      logDir,
    });
    results.push(result);
    if (result.status !== "passed") {
      buildFailed = true;
    }
  }
  for (const step of wanted) {
    if (buildFailed && step !== "build") {
      results.push({
        service,
        step,
        status: "skipped",
        reason: "dependency_or_build_prereq_failed",
        duration_ms: 0,
        log_file: "",
      });
      continue;
    }
    if (!scripts[step]) {
      results.push({
        service,
        step,
        status: "skipped",
        reason: "script_missing",
        duration_ms: 0,
        log_file: "",
      });
      continue;
    }
    const command = commandForStep(service, step, outDir, date);
    const result = await runCommand({
      service,
      step,
      cwd: serviceDir,
      command: command.command,
      args: command.args,
      timeoutMs,
      logDir,
    });
    results.push(result);
    if (step === "build" && result.status !== "passed") {
      buildFailed = true;
    }
  }
}

let dailyLoop = null;
if (!skipDaily) {
  const dailyOutDir = path.join(outDir, "daily");
  const result = await runCommand({
    service: "utility-daily-loop",
    step: "daily-loop",
    cwd: repoRoot,
    command: process.execPath,
    args: ["scripts/hwai-utility-mcp-daily-loop.mjs", `--date=${date}`, `--out-dir=${dailyOutDir}`],
    timeoutMs,
    logDir,
  });
  dailyLoop = result;
}

const commandResults = dailyLoop ? [...results, dailyLoop] : results;
const summary = {
  services_total: services.length,
  commands_total: commandResults.length,
  commands_passed: commandResults.filter((item) => item.status === "passed").length,
  commands_failed: commandResults.filter((item) => item.status === "failed" || item.status === "timeout").length,
  commands_skipped: commandResults.filter((item) => item.status === "skipped").length,
  duration_ms: Date.now() - startedAt,
};
const report = {
  schema_version: "hwai-utility-mcp-system-audit.v1",
  generated_at: new Date().toISOString(),
  date,
  mode,
  include_network: includeNetwork,
  install_missing: installMissing,
  timeout_ms: timeoutMs,
  out_dir: outDir,
  summary,
  results,
  daily_loop: dailyLoop,
};
const jsonPath = path.join(outDir, "system-audit.json");
const markdownPath = path.join(outDir, "system-audit.md");
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeMarkdown(report, markdownPath);

console.log(
  JSON.stringify(
    {
      schema_version: report.schema_version,
      out_dir: report.out_dir,
      markdown_path: markdownPath,
      json_path: jsonPath,
      summary: report.summary,
      failures: commandResults
        .filter((item) => item.status === "failed" || item.status === "timeout")
        .map((item) => ({ service: item.service, step: item.step, status: item.status, log_file: item.log_file })),
    },
    null,
    2,
  ),
);

if (summary.commands_failed > 0) {
  process.exit(1);
}
