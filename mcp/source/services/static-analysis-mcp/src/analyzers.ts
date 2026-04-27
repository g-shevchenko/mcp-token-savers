import path from "node:path";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import { commandExists, fileExists, readPackageJson, resolveRoot, runCommand } from "./command-runner.js";
import {
  CommandPolicyDecision,
  resolveCommandPolicy,
  resolveCommandPolicySummary,
} from "./command-policy.js";
import {
  STATIC_ANALYSIS_PIPELINE_VERSION,
  STATIC_ANALYSIS_SCHEMA_VERSION,
  StaticAnalysisConfig,
} from "./config.js";
import { summarizeSarifObject } from "./sarif.js";
import { clampText, tokenStats } from "./text-utils.js";

export type Severity = "error" | "warning" | "notice";
export type AnalysisStatus = "passed" | "failed" | "skipped" | "error";

export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  rule_id?: string;
  severity: Severity;
  source: string;
}

export interface AnalysisOptions {
  changed_files?: string[];
  command?: string[];
  command_policy_preset?: string;
  config?: string;
  max_output_chars?: number;
  metadata?: unknown;
  project?: string;
  root_path?: string;
  timeout_ms?: number;
}

function maxOutputChars(options: AnalysisOptions): number {
  return typeof options.max_output_chars === "number" && options.max_output_chars > 0
    ? Math.min(options.max_output_chars, 300_000)
    : 120_000;
}

function timeoutMs(config: StaticAnalysisConfig, options: AnalysisOptions): number {
  return typeof options.timeout_ms === "number" && options.timeout_ms > 0
    ? Math.min(options.timeout_ms, 120_000)
    : config.commandTimeoutMs;
}

function relativeFile(root: string, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalized = filePath.replace(/\\/g, "/");
  if (!path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.relative(root, normalized).replace(/\\/g, "/");
}

function statusFromExit(exitCode: number | null, findings: Finding[], timedOut: boolean): AnalysisStatus {
  if (timedOut || exitCode === null || exitCode === 127) {
    return "error";
  }
  if (exitCode === 0 && findings.filter((finding) => finding.severity === "error").length === 0) {
    return "passed";
  }
  return "failed";
}

function commandDisplay(command: string[]): string {
  return command.join(" ");
}

function buildCompactMarkdown(input: {
  command: string[];
  cwd: string;
  duration_ms: number;
  exit_code: number | null;
  findings: Finding[];
  status: AnalysisStatus;
  stderr: string;
  stdout: string;
  tool_kind: string;
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.tool_kind} summary`);
  lines.push("");
  lines.push(`Status: ${input.status}`);
  lines.push(`Exit code: ${input.exit_code ?? "n/a"}`);
  lines.push(`Duration ms: ${input.duration_ms}`);
  lines.push(`Command: ${commandDisplay(input.command)}`);
  lines.push("");
  lines.push(`Findings: ${input.findings.length}`);
  for (const finding of input.findings.slice(0, 30)) {
    const loc = [finding.file, finding.line, finding.column].filter(Boolean).join(":");
    lines.push(
      `- ${finding.severity.toUpperCase()} ${finding.source}${finding.rule_id ? `/${finding.rule_id}` : ""}${loc ? ` ${loc}` : ""}: ${finding.message}`,
    );
  }
  if (input.findings.length === 0) {
    const combined = `${input.stderr}\n${input.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /error|warning|failed|fail/i.test(line))
      .slice(0, 15);
    for (const line of combined) {
      lines.push(`- ${clampText(line, 260)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseTypescriptDiagnostics(root: string, output: string): Finding[] {
  const findings: Finding[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
  for (const line of output.split("\n")) {
    const match = regex.exec(line.trim());
    if (!match) {
      continue;
    }
    findings.push({
      file: relativeFile(root, match[1]),
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      message: match[6].trim(),
      rule_id: match[5],
      severity: match[4] === "warning" ? "warning" : "error",
      source: "tsc",
    });
  }
  return findings;
}

function parseEslintDiagnostics(root: string, output: string): Finding[] {
  const findings: Finding[] = [];
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      for (const fileResult of parsed) {
        const filePath = typeof fileResult.filePath === "string" ? fileResult.filePath : undefined;
        for (const message of Array.isArray(fileResult.messages) ? fileResult.messages : []) {
          findings.push({
            file: relativeFile(root, filePath),
            line: typeof message.line === "number" ? message.line : undefined,
            column: typeof message.column === "number" ? message.column : undefined,
            message: String(message.message || "ESLint finding"),
            rule_id: typeof message.ruleId === "string" ? message.ruleId : undefined,
            severity: message.severity === 2 ? "error" : "warning",
            source: "eslint",
          });
        }
      }
      return findings;
    }
  } catch {
    // Fall back to text parsing below.
  }

  const regex = /^(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s+([@\w/-]+))?$/;
  for (const line of output.split("\n")) {
    const match = regex.exec(line.trim());
    if (!match) {
      continue;
    }
    findings.push({
      file: relativeFile(root, match[1]),
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      message: match[5].trim(),
      rule_id: match[6],
      severity: match[4] === "error" ? "error" : "warning",
      source: "eslint",
    });
  }
  return findings;
}

function parseSemgrepDiagnostics(root: string, output: string): Finding[] {
  try {
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed.results) ? parsed.results : []).map((result: any) => ({
      file: relativeFile(root, result.path),
      line: typeof result.start?.line === "number" ? result.start.line : undefined,
      column: typeof result.start?.col === "number" ? result.start.col : undefined,
      message: String(result.extra?.message || "Semgrep finding"),
      rule_id: typeof result.check_id === "string" ? result.check_id : undefined,
      severity: String(result.extra?.severity || "").toLowerCase() === "error" ? "error" : "warning",
      source: "semgrep",
    }));
  } catch {
    return [];
  }
}

function parseGitleaksDiagnostics(root: string, output: string): Finding[] {
  try {
    const parsed = JSON.parse(output || "[]");
    return (Array.isArray(parsed) ? parsed : []).map((result: any) => ({
      file: relativeFile(root, result.File),
      line: typeof result.StartLine === "number" ? result.StartLine : undefined,
      message: String(result.Description || "Potential secret detected"),
      rule_id: typeof result.RuleID === "string" ? result.RuleID : undefined,
      severity: "error",
      source: "gitleaks",
    }));
  } catch {
    return [];
  }
}

function parseTestFailures(output: string): Finding[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /fail|failed|error|exception/i.test(line))
    .slice(0, 30)
    .map((line) => ({
      message: clampText(line, 500),
      severity: /warn/i.test(line) ? "warning" : "error",
      source: "tests",
    }));
}

async function finalizeRun(
  config: StaticAnalysisConfig,
  toolKind: string,
  root: string,
  command: string[],
  stdout: string,
  stderr: string,
  durationMs: number,
  exitCode: number | null,
  timedOut: boolean,
  findings: Finding[],
) {
  const status = statusFromExit(exitCode, findings, timedOut);
  const rawOutput = `${stderr}${stderr && stdout ? "\n" : ""}${stdout}`;
  const compactMarkdown = buildCompactMarkdown({
    command,
    cwd: root,
    duration_ms: durationMs,
    exit_code: exitCode,
    findings,
    status,
    stderr,
    stdout,
    tool_kind: toolKind,
  });
  const key = stableKey(toolKind, `${root}\n${commandDisplay(command)}\n${rawOutput}\n${Date.now()}`);
  const rawArtifact = await persistArtifactText(config, key, "log", rawOutput);
  const compactArtifact = await persistArtifactText(config, `${key}-compact`, "md", compactMarkdown);
  const result = {
    schema_version: STATIC_ANALYSIS_SCHEMA_VERSION,
    pipeline_version: STATIC_ANALYSIS_PIPELINE_VERSION,
    tool_kind: toolKind,
    status,
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms: durationMs,
    command,
    findings: findings.slice(0, 100),
    finding_counts: {
      total: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      notices: findings.filter((finding) => finding.severity === "notice").length,
    },
    compact_markdown: compactMarkdown,
    input_stats: tokenStats(rawOutput, compactMarkdown),
    artifacts: {
      raw_output_file: rawArtifact.fileName,
      raw_output_url: rawArtifact.url,
      compact_summary_file: compactArtifact.fileName,
      compact_summary_url: compactArtifact.url,
    },
    autopilot: {
      requires_frontier_review: findings.length > 0 || status === "error",
      suggested_action:
        findings.length > 0
          ? "Inspect exact files/lines before edits; use compact findings as triage evidence."
          : status === "passed"
            ? "No deterministic findings; continue with normal frontier reasoning if the task requires judgment."
            : "Inspect raw artifact or rerun with a narrower command.",
    },
  };
  await persistArtifactJson(config, `${key}-summary`, result);
  return result;
}

async function skipped(config: StaticAnalysisConfig, toolKind: string, reason: string) {
  const compact = `# ${toolKind} summary\n\nStatus: skipped\nReason: ${reason}\n`;
  const key = stableKey(toolKind, `${reason}\n${Date.now()}`);
  const artifact = await persistArtifactText(config, `${key}-compact`, "md", compact);
  return {
    schema_version: STATIC_ANALYSIS_SCHEMA_VERSION,
    pipeline_version: STATIC_ANALYSIS_PIPELINE_VERSION,
    tool_kind: toolKind,
    status: "skipped" as AnalysisStatus,
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
    command: [],
    findings: [],
    finding_counts: { total: 0, errors: 0, warnings: 0, notices: 0 },
    compact_markdown: compact,
    input_stats: tokenStats(reason, compact),
    artifacts: {
      compact_summary_file: artifact.fileName,
      compact_summary_url: artifact.url,
    },
    skip_reason: reason,
    autopilot: {
      requires_frontier_review: false,
      suggested_action: "Tool unavailable or not configured; continue with other local checks.",
    },
  };
}

function commandPolicyPayload(policy: CommandPolicyDecision) {
  return {
    tool_kind: policy.tool_kind,
    preset: policy.preset,
    source: policy.source,
    command_argc: policy.command?.length || 0,
    skip_reason: policy.skip_reason,
    notes: policy.notes,
  };
}

function withCommandPolicy<T extends Record<string, unknown>>(result: T, policy: CommandPolicyDecision): T {
  return {
    ...result,
    command_policy: commandPolicyPayload(policy),
  };
}

export async function getCommandPolicy(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  return resolveCommandPolicySummary(root, packageJson, options);
}

export async function runTsc(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  const policy = await resolveCommandPolicy(root, packageJson, "tsc", options);
  const command = policy.command;
  if (!command) {
    return withCommandPolicy(
      await skipped(config, "tsc", policy.skip_reason || "No package typecheck script or tsconfig.json found."),
      policy,
    );
  }
  if (
    policy.source === "builtin" &&
    command[0] === "npx" &&
    !options.project &&
    !(await fileExists(path.join(root, "tsconfig.json")))
  ) {
    return withCommandPolicy(
      await skipped(config, "tsc", "No package typecheck script or tsconfig.json found."),
      policy,
    );
  }
  const result = await runCommand(command, root, timeoutMs(config, options), maxOutputChars(options));
  const output = `${result.stderr}\n${result.stdout}`;
  return withCommandPolicy(await finalizeRun(
    config,
    "tsc",
    root,
    command,
    result.stdout,
    result.stderr,
    result.duration_ms,
    result.exit_code,
    result.timed_out,
    parseTypescriptDiagnostics(root, output),
  ), policy);
}

export async function runEslint(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  const policy = await resolveCommandPolicy(root, packageJson, "eslint", options);
  const command = policy.command;
  if (!command) {
    return withCommandPolicy(
      await skipped(config, "eslint", policy.skip_reason || "No package lint script or local eslint binary found."),
      policy,
    );
  }
  if (
    policy.source === "builtin" &&
    command[0] === "npx" &&
    !(await fileExists(path.join(root, "node_modules", ".bin", "eslint")))
  ) {
    return withCommandPolicy(await skipped(config, "eslint", "No package lint script or local eslint binary found."), policy);
  }
  const result = await runCommand(command, root, timeoutMs(config, options), maxOutputChars(options));
  const output = result.stdout || result.stderr;
  return withCommandPolicy(await finalizeRun(
    config,
    "eslint",
    root,
    command,
    result.stdout,
    result.stderr,
    result.duration_ms,
    result.exit_code,
    result.timed_out,
    parseEslintDiagnostics(root, output),
  ), policy);
}

export async function runTestsChanged(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  const policy = await resolveCommandPolicy(root, packageJson, "tests", options);
  const command = policy.command;
  if (!command) {
    return withCommandPolicy(
      await skipped(config, "tests", policy.skip_reason || "No command provided and no package test script found."),
      policy,
    );
  }
  const result = await runCommand(command, root, timeoutMs(config, options), maxOutputChars(options));
  const output = `${result.stderr}\n${result.stdout}`;
  return withCommandPolicy(await finalizeRun(
    config,
    "tests",
    root,
    command,
    result.stdout,
    result.stderr,
    result.duration_ms,
    result.exit_code,
    result.timed_out,
    parseTestFailures(output),
  ), policy);
}

export async function runSemgrepLocal(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  const policy = await resolveCommandPolicy(root, packageJson, "semgrep", options);
  const command = policy.command;
  if (!command) {
    return withCommandPolicy(await skipped(config, "semgrep", policy.skip_reason || "semgrep command unavailable."), policy);
  }
  if (policy.source === "builtin" && !(await commandExists("semgrep", root))) {
    return withCommandPolicy(await skipped(config, "semgrep", "semgrep binary not found in PATH."), policy);
  }
  const result = await runCommand(command, root, timeoutMs(config, options), maxOutputChars(options));
  const output = result.stdout || result.stderr;
  return withCommandPolicy(await finalizeRun(
    config,
    "semgrep",
    root,
    command,
    result.stdout,
    result.stderr,
    result.duration_ms,
    result.exit_code,
    result.timed_out,
    parseSemgrepDiagnostics(root, output),
  ), policy);
}

export async function runGitleaks(config: StaticAnalysisConfig, options: AnalysisOptions = {}) {
  const root = await resolveRoot(config, options.root_path);
  const packageJson = await readPackageJson(root);
  const policy = await resolveCommandPolicy(root, packageJson, "gitleaks", options);
  const command = policy.command;
  if (!command) {
    return withCommandPolicy(await skipped(config, "gitleaks", policy.skip_reason || "gitleaks command unavailable."), policy);
  }
  if (policy.source === "builtin" && !(await commandExists("gitleaks", root))) {
    return withCommandPolicy(await skipped(config, "gitleaks", "gitleaks binary not found in PATH."), policy);
  }
  const result = await runCommand(command, root, timeoutMs(config, options), maxOutputChars(options));
  const output = result.stdout || result.stderr;
  return withCommandPolicy(await finalizeRun(
    config,
    "gitleaks",
    root,
    command,
    result.stdout,
    result.stderr,
    result.duration_ms,
    result.exit_code,
    result.timed_out,
    parseGitleaksDiagnostics(root, output),
  ), policy);
}

export async function summarizeSarif(
  config: StaticAnalysisConfig,
  input: { root_path?: string; sarif_json?: string; sarif_path?: string; max_findings?: number } = {},
) {
  const root = await resolveRoot(config, input.root_path);
  let raw = input.sarif_json || "";
  if (!raw && input.sarif_path) {
    raw = await import("node:fs/promises").then((fs) => fs.readFile(path.resolve(root, input.sarif_path || ""), "utf8"));
  }
  if (!raw) {
    throw new Error("sarif_json or sarif_path is required");
  }
  const summary = summarizeSarifObject(JSON.parse(raw), root, input.max_findings || 100);
  const compact = `# SARIF summary\n\nFindings: ${summary.finding_counts.total}\nErrors: ${summary.finding_counts.errors}\nWarnings: ${summary.finding_counts.warnings}\n`;
  const key = stableKey("sarif", `${raw}\n${Date.now()}`);
  const rawArtifact = await persistArtifactText(config, key, "sarif.json", raw);
  const summaryArtifact = await persistArtifactJson(config, `${key}-summary`, summary);
  return {
    schema_version: STATIC_ANALYSIS_SCHEMA_VERSION,
    pipeline_version: STATIC_ANALYSIS_PIPELINE_VERSION,
    tool_kind: "sarif",
    status: summary.finding_counts.errors > 0 ? "failed" : "passed",
    ...summary,
    compact_markdown: compact,
    input_stats: tokenStats(raw, compact),
    artifacts: {
      raw_sarif_file: rawArtifact.fileName,
      raw_sarif_url: rawArtifact.url,
      summary_file: summaryArtifact.fileName,
      summary_url: summaryArtifact.url,
    },
  };
}
