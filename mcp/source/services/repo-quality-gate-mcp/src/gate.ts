import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readArtifact, writeJsonArtifact } from "./artifact-store.js";
import {
  REPO_QUALITY_GATE_PIPELINE_VERSION,
  REPO_QUALITY_GATE_SCHEMA_VERSION,
  RepoQualityGateConfig,
} from "./config.js";
import { estimateTokens, round, stableHash } from "./text-utils.js";

const execFileAsync = promisify(execFile);

export interface GateArgs {
  base_ref?: string;
  baseline?: unknown;
  baseline_artifact_file?: string;
  include_generated?: boolean;
  include_imported_templates?: boolean;
  large_doc_lines?: number;
  max_added_code_lines?: number;
  max_added_doc_lines?: number;
  max_changed_code_files?: number;
  max_changed_doc_files?: number;
  max_context_pressure_score?: number;
  max_files?: number;
  max_findings?: number;
  max_large_docs?: number;
  metadata?: unknown;
  repo_root?: string;
}

interface ChangedFile {
  added_lines: number;
  category: "code" | "docs" | "other";
  deleted_lines: number;
  file_hash: string;
  file_path: string;
  generated_like: boolean;
  line_count: number;
  status: "changed" | "untracked";
}

interface Snapshot {
  candidate_files_seen: number;
  code_files: number;
  code_lines: number;
  context_pressure_score: number;
  doc_files: number;
  doc_lines: number;
  generated_like_files: number;
  large_docs_count: number;
  max_files: number;
  other_files: number;
  scan_truncated: boolean;
  scanned_files: number;
  selection_policy: string;
  top_large_docs: Array<Record<string, unknown>>;
}

const DOC_EXTENSIONS = new Set([".md", ".mdx"]);
const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".php",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  ".wrangler",
  ".cache",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function repoRoot(args: GateArgs): string {
  return path.resolve(args.repo_root || process.cwd());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isGeneratedWorktreeRelPath(filePath: string): boolean {
  const normalized = toPosix(filePath);
  return normalized === ".claude/worktrees" || normalized.startsWith(".claude/worktrees/");
}

function isImportedTemplateRelPath(filePath: string): boolean {
  const normalized = toPosix(filePath);
  return (
    normalized === "templates/hwai_internal_seed/skills/imported" ||
    normalized.startsWith("templates/hwai_internal_seed/skills/imported/")
  );
}

function isGeneratedWorktreeDir(root: string, absPath: string): boolean {
  return isGeneratedWorktreeRelPath(path.relative(root, absPath));
}

function isImportedTemplateDir(root: string, absPath: string): boolean {
  return isImportedTemplateRelPath(path.relative(root, absPath));
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function maxFindings(config: RepoQualityGateConfig, args: GateArgs): number {
  return positiveNumber(args.max_findings, config.maxFindings);
}

function maxFiles(config: RepoQualityGateConfig, args: GateArgs): number {
  return positiveNumber(args.max_files, config.maxFiles);
}

function largeDocLines(config: RepoQualityGateConfig, args: GateArgs): number {
  return positiveNumber(args.large_doc_lines, config.largeDocLines);
}

function categoryFor(filePath: string): "code" | "docs" | "other" {
  const ext = path.extname(filePath).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) {
    return "docs";
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return "code";
  }
  return "other";
}

function generatedLike(filePath: string): boolean {
  const normalized = toPosix(filePath).toLowerCase();
  const segments = normalized.split("/");
  return (
    segments.includes("dist") ||
    segments.includes("coverage") ||
    segments.includes("node_modules") ||
    segments.includes(".artifacts") ||
    segments.includes(".cache") ||
    normalized.includes("content/live-snapshot/") ||
    normalized.endsWith(".lock") ||
    normalized.endsWith("package-lock.json") ||
    normalized.endsWith(".snap")
  );
}

function hasFrontmatter(text: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text);
}

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: REPO_QUALITY_GATE_SCHEMA_VERSION,
    pipeline_version: REPO_QUALITY_GATE_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local quality-gate evidence only. No blocking by default. Request logs store counts/hashes, not code or doc bodies.",
  };
}

function attachStats<T extends object>(payload: T, rawChars: number): T & {
  compact_tokens_estimate: number;
  raw_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
} {
  const compactTokens = estimateTokens(JSON.stringify(payload));
  const rawTokens = estimateTokens(rawChars);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    ...payload,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

async function withArtifact<T extends object>(
  config: RepoQualityGateConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function resolveBaseRef(root: string, requested?: string): Promise<string> {
  if (requested?.trim()) {
    return requested.trim();
  }
  for (const candidate of ["origin/main", "HEAD"]) {
    try {
      await runGit(root, ["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // try next
    }
  }
  return "HEAD";
}

async function lineCount(absPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    return raw.length ? raw.split(/\r?\n/).length : 0;
  } catch {
    return 0;
  }
}

async function readText(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

function parseNum(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function collectChangedFiles(config: RepoQualityGateConfig, args: GateArgs): Promise<{ baseRef: string; files: ChangedFile[]; root: string }> {
  const root = repoRoot(args);
  const baseRef = await resolveBaseRef(root, args.base_ref);
  const changed = new Map<string, ChangedFile>();
  const numstat = await runGit(root, ["diff", "--numstat", baseRef, "--"]);
  for (const line of numstat.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const [addedRaw = "0", deletedRaw = "0", ...pathParts] = line.split("\t");
    const relPath = pathParts.join("\t");
    if (
      !relPath ||
      isGeneratedWorktreeRelPath(relPath) ||
      (args.include_imported_templates !== true && isImportedTemplateRelPath(relPath))
    ) {
      continue;
    }
    const absPath = path.join(root, relPath);
    const lines = await lineCount(absPath);
    changed.set(relPath, {
      added_lines: parseNum(addedRaw),
      category: categoryFor(relPath),
      deleted_lines: parseNum(deletedRaw),
      file_hash: stableHash(relPath),
      file_path: toPosix(relPath),
      generated_like: generatedLike(relPath),
      line_count: lines,
      status: "changed",
    });
  }

  const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard"]);
  for (const relPath of untracked.split("\n").map((item) => item.trim()).filter(Boolean)) {
    if (
      changed.has(relPath) ||
      isGeneratedWorktreeRelPath(relPath) ||
      (args.include_imported_templates !== true && isImportedTemplateRelPath(relPath))
    ) {
      continue;
    }
    const absPath = path.join(root, relPath);
    const lines = await lineCount(absPath);
    changed.set(relPath, {
      added_lines: lines,
      category: categoryFor(relPath),
      deleted_lines: 0,
      file_hash: stableHash(relPath),
      file_path: toPosix(relPath),
      generated_like: generatedLike(relPath),
      line_count: lines,
      status: "untracked",
    });
    if (changed.size >= maxFiles(config, args)) {
      break;
    }
  }

  return { baseRef, files: Array.from(changed.values()), root };
}

function overBudgetFindings(checks: Array<{ actual: number; limit: number; metric: string }>) {
  return checks
    .filter((check) => check.actual > check.limit)
    .map((check) => ({
      metric: check.metric,
      actual: check.actual,
      limit: check.limit,
      over_by: check.actual - check.limit,
      confidence: 0.9,
    }));
}

function rawCharsForFiles(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + Math.max(file.line_count, file.added_lines) * 80, 0);
}

export async function checkNewCodeBudget(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const { baseRef, files, root } = await collectChangedFiles(config, args);
  const codeFiles = files.filter((file) => file.category === "code" && (args.include_generated || !file.generated_like));
  const addedCodeLines = codeFiles.reduce((sum, file) => sum + file.added_lines, 0);
  const changedCodeFiles = codeFiles.length;
  const limitLines = nonNegativeNumber(args.max_added_code_lines, config.maxAddedCodeLines);
  const limitFiles = nonNegativeNumber(args.max_changed_code_files, config.maxChangedCodeFiles);
  const findings: Array<Record<string, unknown>> = overBudgetFindings([
    { metric: "added_code_lines", actual: addedCodeLines, limit: limitLines },
    { metric: "changed_code_files", actual: changedCodeFiles, limit: limitFiles },
  ]);
  const topFiles = codeFiles
    .sort((a, b) => b.added_lines - a.added_lines || a.file_path.localeCompare(b.file_path))
    .slice(0, maxFindings(config, args))
    .map((file) => ({
      file_path: file.file_path,
      file_hash: file.file_hash,
      added_lines: file.added_lines,
      deleted_lines: file.deleted_lines,
      line_count: file.line_count,
      status: file.status,
      generated_like: file.generated_like,
    }));
  const result = attachStats(
    {
      ...baseResult("new_code_budget", root),
      base_ref: baseRef,
      budget_status: findings.length > 0 ? "warn" : "pass",
      blocking_allowed: false,
      changed_files: files.length,
      changed_code_files: changedCodeFiles,
      added_code_lines: addedCodeLines,
      budget_limits: {
        max_added_code_lines: limitLines,
        max_changed_code_files: limitFiles,
      },
      over_budget_count: findings.length,
      findings,
      files: topFiles,
      truncated: codeFiles.length > maxFindings(config, args),
    },
    rawCharsForFiles(codeFiles),
  );
  return withArtifact(config, "new-code-budget", result);
}

export async function checkNewDocsBudget(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const { baseRef, files, root } = await collectChangedFiles(config, args);
  const docFiles = files.filter((file) => file.category === "docs" && (args.include_generated || !file.generated_like));
  const addedDocLines = docFiles.reduce((sum, file) => sum + file.added_lines, 0);
  const changedDocFiles = docFiles.length;
  const largeLineLimit = largeDocLines(config, args);
  const docsWithFrontmatterGaps: Array<Record<string, unknown>> = [];
  const largeDocs: Array<Record<string, unknown>> = [];
  for (const file of docFiles) {
    if (file.line_count >= largeLineLimit) {
      largeDocs.push({
        file_path: file.file_path,
        file_hash: file.file_hash,
        line_count: file.line_count,
      });
    }
    const text = await readText(path.join(root, file.file_path));
    if (text && !hasFrontmatter(text)) {
      docsWithFrontmatterGaps.push({
        file_path: file.file_path,
        file_hash: file.file_hash,
        line_count: file.line_count,
        confidence: 0.55,
        reason: "Changed doc has no YAML frontmatter. Advisory only; root runbooks may intentionally omit it.",
      });
    }
  }
  const limitLines = nonNegativeNumber(args.max_added_doc_lines, config.maxAddedDocLines);
  const limitFiles = nonNegativeNumber(args.max_changed_doc_files, config.maxChangedDocFiles);
  const limitLargeDocs = nonNegativeNumber(args.max_large_docs, config.maxLargeDocs);
  const findings: Array<Record<string, unknown>> = overBudgetFindings([
    { metric: "added_doc_lines", actual: addedDocLines, limit: limitLines },
    { metric: "changed_doc_files", actual: changedDocFiles, limit: limitFiles },
    { metric: "large_docs_count", actual: largeDocs.length, limit: limitLargeDocs },
  ]);
  const topFiles = docFiles
    .sort((a, b) => b.added_lines - a.added_lines || a.file_path.localeCompare(b.file_path))
    .slice(0, maxFindings(config, args))
    .map((file) => ({
      file_path: file.file_path,
      file_hash: file.file_hash,
      added_lines: file.added_lines,
      deleted_lines: file.deleted_lines,
      line_count: file.line_count,
      status: file.status,
      generated_like: file.generated_like,
    }));
  const result = attachStats(
    {
      ...baseResult("new_docs_budget", root),
      base_ref: baseRef,
      budget_status: findings.length > 0 ? "warn" : "pass",
      blocking_allowed: false,
      changed_files: files.length,
      changed_doc_files: changedDocFiles,
      added_doc_lines: addedDocLines,
      large_docs_count: largeDocs.length,
      frontmatter_missing_count: docsWithFrontmatterGaps.length,
      budget_limits: {
        max_added_doc_lines: limitLines,
        max_changed_doc_files: limitFiles,
        max_large_docs: limitLargeDocs,
        large_doc_lines: largeLineLimit,
      },
      over_budget_count: findings.length,
      findings,
      large_docs: largeDocs.slice(0, maxFindings(config, args)),
      frontmatter_gaps: docsWithFrontmatterGaps.slice(0, maxFindings(config, args)),
      files: topFiles,
      truncated: docFiles.length > maxFindings(config, args),
    },
    rawCharsForFiles(docFiles),
  );
  return withArtifact(config, "new-docs-budget", result);
}

async function collectRepoFiles(
  config: RepoQualityGateConfig,
  args: GateArgs,
): Promise<{
  candidateFilesSeen: number;
  files: Array<{ absPath: string; relPath: string }>;
  maxFiles: number;
  truncated: boolean;
}> {
  const root = repoRoot(args);
  const rows: Array<{ absPath: string; relPath: string }> = [];
  const limit = maxFiles(config, args);
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const absPath = path.join(dir, entry.name);
        if (
          !SKIP_DIRS.has(entry.name) &&
          !isGeneratedWorktreeDir(root, absPath) &&
          (args.include_imported_templates === true || !isImportedTemplateDir(root, absPath))
        ) {
          await walk(absPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absPath = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(root, absPath));
      rows.push({ absPath, relPath });
    }
  }
  await walk(root);
  const ranked = rows
    .map((row) => {
      const category = categoryFor(row.relPath);
      const generated = generatedLike(row.relPath);
      const rank = generated ? (category === "other" ? 3 : 2) : category === "other" ? 1 : 0;
      return { ...row, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.relPath.localeCompare(b.relPath));
  return {
    candidateFilesSeen: rows.length,
    files: ranked.slice(0, limit).map(({ absPath, relPath }) => ({ absPath, relPath })),
    maxFiles: limit,
    truncated: rows.length > limit,
  };
}

async function buildSnapshot(config: RepoQualityGateConfig, args: GateArgs = {}): Promise<{ root: string; snapshot: Snapshot; rawChars: number }> {
  const root = repoRoot(args);
  const collected = await collectRepoFiles(config, args);
  const files = collected.files;
  let codeFiles = 0;
  let codeLines = 0;
  let docFiles = 0;
  let docLines = 0;
  let generatedFiles = 0;
  let otherFiles = 0;
  let rawChars = 0;
  const largeDocs: Array<Record<string, unknown>> = [];
  const largeLimit = largeDocLines(config, args);
  for (const file of files) {
    const lines = await lineCount(file.absPath);
    rawChars += lines * 80;
    if (generatedLike(file.relPath)) {
      generatedFiles += 1;
    }
    const category = categoryFor(file.relPath);
    if (category === "docs") {
      docFiles += 1;
      docLines += lines;
      if (lines >= largeLimit) {
        largeDocs.push({
          file_path: file.relPath,
          file_hash: stableHash(file.relPath),
          line_count: lines,
        });
      }
    } else if (category === "code") {
      codeFiles += 1;
      codeLines += lines;
    } else {
      otherFiles += 1;
    }
  }
  const contextPressureScore = docLines + codeLines * 2 + generatedFiles * 10;
  return {
    root,
    rawChars,
    snapshot: {
      candidate_files_seen: collected.candidateFilesSeen,
      code_files: codeFiles,
      code_lines: codeLines,
      context_pressure_score: contextPressureScore,
      doc_files: docFiles,
      doc_lines: docLines,
      generated_like_files: generatedFiles,
      large_docs_count: largeDocs.length,
      max_files: collected.maxFiles,
      other_files: otherFiles,
      scan_truncated: collected.truncated,
      scanned_files: files.length,
      selection_policy: "prioritize_non_generated_code_and_docs_before_other_files_when_max_files_truncates",
      top_large_docs: largeDocs
        .sort((a, b) => Number(b.line_count || 0) - Number(a.line_count || 0))
        .slice(0, maxFindings(config, args)),
    },
  };
}

export async function createQualitySnapshot(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const { root, snapshot, rawChars } = await buildSnapshot(config, args);
  const result = attachStats(
    {
      ...baseResult("quality_snapshot", root),
      snapshot,
      snapshot_hash: stableHash(JSON.stringify(snapshot)),
    },
    rawChars,
  );
  return withArtifact(config, "quality-snapshot", result);
}

export async function checkContextBudget(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const { root, snapshot, rawChars } = await buildSnapshot(config, args);
  const pressureLimit = nonNegativeNumber(args.max_context_pressure_score, config.maxContextPressureScore);
  const largeDocLimit = nonNegativeNumber(args.max_large_docs, config.maxLargeDocs);
  const findings: Array<Record<string, unknown>> = overBudgetFindings([
    { metric: "context_pressure_score", actual: snapshot.context_pressure_score, limit: pressureLimit },
    { metric: "large_docs_count", actual: snapshot.large_docs_count, limit: largeDocLimit },
  ]);
  if (snapshot.scan_truncated) {
    findings.push({
      metric: "scan_truncated",
      actual: snapshot.scanned_files,
      limit: snapshot.max_files,
      over_by: 0,
      confidence: 0.9,
      reason: "Snapshot reached max_files before the repo scan completed. Increase max_files or narrow repo_root before treating a pass as complete.",
    });
  }
  const result = attachStats(
    {
      ...baseResult("context_budget", root),
      budget_status: findings.length > 0 ? "warn" : "pass",
      blocking_allowed: false,
      ...snapshot,
      budget_limits: {
        max_context_pressure_score: pressureLimit,
        max_large_docs: largeDocLimit,
        large_doc_lines: largeDocLines(config, args),
      },
      over_budget_count: findings.length,
      findings,
    },
    rawChars,
  );
  return withArtifact(config, "context-budget", result);
}

function asSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record.snapshot && typeof record.snapshot === "object" ? (record.snapshot as Record<string, unknown>) : record;
  const required = ["scanned_files", "doc_lines", "code_lines", "context_pressure_score"];
  if (!required.every((key) => typeof candidate[key] === "number")) {
    return null;
  }
  return candidate as unknown as Snapshot;
}

export async function compareQualitySnapshot(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const root = repoRoot(args);
  let baseline = asSnapshot(args.baseline);
  if (!baseline && args.baseline_artifact_file) {
    const artifact = await readArtifact(config, args.baseline_artifact_file, config.maxArtifactChars);
    baseline = asSnapshot(JSON.parse(artifact.text));
  }
  if (!baseline) {
    throw new Error("baseline or baseline_artifact_file is required");
  }
  const { snapshot, rawChars } = await buildSnapshot(config, args);
  const delta = {
    scanned_files: snapshot.scanned_files - baseline.scanned_files,
    doc_files: snapshot.doc_files - baseline.doc_files,
    doc_lines: snapshot.doc_lines - baseline.doc_lines,
    code_files: snapshot.code_files - baseline.code_files,
    code_lines: snapshot.code_lines - baseline.code_lines,
    generated_like_files: snapshot.generated_like_files - baseline.generated_like_files,
    large_docs_count: snapshot.large_docs_count - baseline.large_docs_count,
    context_pressure_score: snapshot.context_pressure_score - baseline.context_pressure_score,
  };
  const findings = Object.entries(delta)
    .filter(([, value]) => value > 0)
    .map(([metric, value]) => ({
      metric,
      delta: value,
      confidence: 0.8,
    }));
  const result = attachStats(
    {
      ...baseResult("quality_snapshot_compare", root),
      budget_status: findings.length > 0 ? "warn" : "pass",
      blocking_allowed: false,
      baseline_hash: stableHash(JSON.stringify(baseline)),
      current_hash: stableHash(JSON.stringify(snapshot)),
      delta,
      growth_findings_count: findings.length,
      findings: findings.slice(0, maxFindings(config, args)),
    },
    rawChars,
  );
  return withArtifact(config, "quality-snapshot-compare", result);
}

export async function proposeQualityGatePlan(config: RepoQualityGateConfig, args: GateArgs = {}) {
  const root = repoRoot(args);
  const planArgs = { ...args, max_findings: Math.min(maxFindings(config, args), 20) };
  const [code, docs, context] = await Promise.all([
    checkNewCodeBudget(config, planArgs),
    checkNewDocsBudget(config, planArgs),
    checkContextBudget(config, planArgs),
  ]);
  const planItems: Array<Record<string, unknown>> = [];
  for (const finding of (code.findings as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_new_code_budget",
      evidence: finding,
      required_proof: ["read exact changed files", "run focused tests/static checks", "split or justify large generated/code additions"],
      blocking_allowed: false,
    });
  }
  for (const finding of (docs.findings as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_new_docs_budget",
      evidence: finding,
      required_proof: ["verify SSOT target", "link from owner/index", "classify generated snapshots outside core agent context"],
      blocking_allowed: false,
    });
  }
  for (const gap of (docs.frontmatter_gaps as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_doc_ownership_metadata",
      evidence: gap,
      required_proof: ["add owner/source metadata when this is a maintained doc", "skip only when root runbook policy allows it"],
      blocking_allowed: false,
    });
  }
  for (const finding of (context.findings as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_context_pressure_budget",
      evidence: finding,
      required_proof: ["identify generated/content artifacts", "ensure retrieval/docs hygiene can route around noise"],
      blocking_allowed: false,
    });
  }
  const rawTokens = [code, docs, context].reduce(
    (sum, item) => sum + Number((item as { raw_tokens_estimate?: number }).raw_tokens_estimate || 0),
    0,
  );
  const result = attachStats(
    {
      ...baseResult("quality_gate_plan", root),
      gate_status: planItems.length > 0 ? "warn" : "pass",
      advisory_only: true,
      blocking_allowed: false,
      plan_items_count: planItems.length,
      plan_items: planItems.slice(0, maxFindings(config, args)),
      source_artifacts: {
        new_code_budget: code.artifact_file,
        new_docs_budget: docs.artifact_file,
        context_budget: context.artifact_file,
      },
      summary: {
        changed_files: Number(code.changed_files || 0),
        added_code_lines: Number(code.added_code_lines || 0),
        added_doc_lines: Number(docs.added_doc_lines || 0),
        context_pressure_score: Number(context.context_pressure_score || 0),
        over_budget_count:
          Number(code.over_budget_count || 0) + Number(docs.over_budget_count || 0) + Number(context.over_budget_count || 0),
      },
    },
    rawTokens * 4,
  );
  return withArtifact(config, "quality-gate-plan", result);
}
