import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeArtifact } from "./artifact-store.js";
import { GoldenDatasetConfig, GOLDEN_DATASET_SCHEMA_VERSION } from "./config.js";
import { clampText, round, stableHash, tokenStats } from "./text-utils.js";

export type CaseStatus = "candidate" | "reviewed";

export interface GoldenCase {
  call_id?: string;
  case_id: string;
  created_at: string;
  dataset: string;
  expected_paths: string[];
  feedback_id?: string;
  missing_paths: string[];
  query_hash?: string;
  query_summary?: string;
  source_service: string;
  status: CaseStatus;
  tags: string[];
  task_type: string;
  updated_at?: string;
}

export interface DatasetFile {
  cases: GoldenCase[];
  created_at: string;
  dataset: string;
  schema_version: string;
  updated_at: string;
}

export interface DatasetRunCaseResult {
  compact_tokens_estimate: number;
  case_id: string;
  expected_count: number;
  first_match_rank: number | null;
  missing_count: number;
  pass: boolean;
  recall_at_5: number;
  recall_at_10: number;
  returned_count: number;
  saved_tokens_estimate: number;
  source_tokens_estimate: number;
}

export interface DatasetRun {
  artifact_file?: string;
  artifact_url?: string;
  cases_failed: number;
  cases_passed: number;
  cases_run: number;
  compact_tokens_estimate: number;
  created_at: string;
  dataset: string;
  mrr: number;
  recall_at_5_pct: number;
  recall_at_10_pct: number;
  result_cases: DatasetRunCaseResult[];
  retrieval_calls?: number;
  retrieval_errors?: number;
  run_id: string;
  runner: string;
  saved_tokens_estimate: number;
  schema_version: string;
  savings_pct: number;
  skipped_cases?: number;
  source_tokens_estimate: number;
  status: "needs_results" | "completed";
}

interface PathResultInput {
  compact_tokens_estimate?: unknown;
  case_id?: unknown;
  raw_tokens_estimate?: unknown;
  returned_paths?: unknown;
  saved_tokens_estimate?: unknown;
  source_tokens_estimate?: unknown;
}

interface QueryOverrideInput {
  case_id?: unknown;
  query?: unknown;
}

interface RetrievalFeedbackLine {
  benchmark_candidate?: boolean;
  call_id?: string;
  corrected_query?: string;
  expected_paths?: string[];
  feedback_id?: string;
  missing_paths?: string[];
  notes?: string;
  outcome?: string;
  query?: string;
  ts?: string;
}

interface NormalizedPathResult {
  compact_tokens_estimate: number;
  returned_paths: string[];
  saved_tokens_estimate: number;
  source_tokens_estimate: number;
}

function safeDatasetName(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "retrieval-misses";
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "retrieval-misses";
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function safePathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim().replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.length > 240) {
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out.slice(0, 50);
}

function safeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-"))
    .filter(Boolean)
    .slice(0, 20);
}

function safeTokenEstimate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

function datasetPath(config: GoldenDatasetConfig, dataset: string): string {
  return path.join(config.datasetsDir, `${safeDatasetName(dataset)}.json`);
}

function runPath(config: GoldenDatasetConfig, runId: string): string {
  return path.join(config.runsDir, `${path.basename(runId)}.json`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readDataset(config: GoldenDatasetConfig, dataset: string): Promise<DatasetFile> {
  const name = safeDatasetName(dataset);
  const existing = await readJson<DatasetFile>(datasetPath(config, name));
  if (existing) {
    return {
      ...existing,
      cases: Array.isArray(existing.cases) ? existing.cases : [],
    };
  }
  const now = new Date().toISOString();
  return {
    schema_version: GOLDEN_DATASET_SCHEMA_VERSION,
    dataset: name,
    created_at: now,
    updated_at: now,
    cases: [],
  };
}

async function writeDataset(config: GoldenDatasetConfig, dataset: DatasetFile): Promise<void> {
  await fs.mkdir(config.datasetsDir, { recursive: true });
  await fs.writeFile(datasetPath(config, dataset.dataset), `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
}

export async function listDatasets(config: GoldenDatasetConfig) {
  await fs.mkdir(config.datasetsDir, { recursive: true });
  const files = (await fs.readdir(config.datasetsDir)).filter((file) => file.endsWith(".json")).sort();
  const datasets = [];
  for (const file of files) {
    const parsed = await readJson<DatasetFile>(path.join(config.datasetsDir, file));
    if (!parsed) {
      continue;
    }
    const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
    datasets.push({
      dataset: parsed.dataset || file.replace(/\.json$/, ""),
      cases: cases.length,
      reviewed_cases: cases.filter((item) => item.status === "reviewed").length,
      candidate_cases: cases.filter((item) => item.status !== "reviewed").length,
      expected_paths_count: cases.reduce((sum, item) => sum + (Array.isArray(item.expected_paths) ? item.expected_paths.length : 0), 0),
      updated_at: parsed.updated_at,
    });
  }
  return {
    schema_version: GOLDEN_DATASET_SCHEMA_VERSION,
    datasets,
    dataset_count: datasets.length,
    case_count: datasets.reduce((sum, item) => sum + item.cases, 0),
  };
}

export async function addCaseFromFeedback(config: GoldenDatasetConfig, args: Record<string, unknown>) {
  const datasetName = safeDatasetName(args.dataset);
  const dataset = await readDataset(config, datasetName);
  const now = new Date().toISOString();
  const feedbackId = typeof args.feedback_id === "string" ? args.feedback_id.trim().slice(0, 120) : "";
  const callId = typeof args.call_id === "string" ? args.call_id.trim().slice(0, 120) : "";
  const sourceService = typeof args.source_service === "string" && args.source_service.trim() ? args.source_service.trim().slice(0, 80) : "retrieval-mcp";
  const taskType = typeof args.task_type === "string" && args.task_type.trim() ? args.task_type.trim().slice(0, 80) : "retrieval";
  const rawQuery = typeof args.raw_query === "string" ? args.raw_query : "";
  const correctedQuery = typeof args.corrected_query === "string" ? args.corrected_query : "";
  const queryHash = rawQuery || correctedQuery ? stableHash(`${rawQuery}\n${correctedQuery}`) : undefined;
  const querySummary = typeof args.query_summary === "string" && args.query_summary.trim()
    ? clampText(args.query_summary.replace(/\s+/g, " ").trim(), 240)
    : undefined;
  const expectedPaths = safePathList(args.expected_paths);
  const missingPaths = safePathList(args.missing_paths);
  const tags = safeTags(args.tags);
  const explicitId = typeof args.case_id === "string" && args.case_id.trim() ? args.case_id.trim() : "";
  const caseId = safeId(explicitId || `${sourceService}:${feedbackId || callId || stableHash(JSON.stringify({ expectedPaths, missingPaths, now }))}`);
  const status: CaseStatus = args.status === "reviewed" ? "reviewed" : "candidate";
  const nextCase: GoldenCase = {
    case_id: caseId,
    dataset: dataset.dataset,
    source_service: sourceService,
    task_type: taskType,
    status,
    feedback_id: feedbackId || undefined,
    call_id: callId || undefined,
    query_hash: queryHash,
    query_summary: querySummary,
    expected_paths: expectedPaths,
    missing_paths: missingPaths,
    tags,
    created_at: now,
    updated_at: now,
  };
  const index = dataset.cases.findIndex((item) => item.case_id === caseId);
  if (index >= 0) {
    nextCase.created_at = dataset.cases[index].created_at;
    dataset.cases[index] = nextCase;
  } else {
    dataset.cases.push(nextCase);
  }
  dataset.updated_at = now;
  await writeDataset(config, dataset);
  return {
    schema_version: GOLDEN_DATASET_SCHEMA_VERSION,
    dataset: dataset.dataset,
    case_id: caseId,
    status,
    cases: dataset.cases.length,
    expected_paths_count: expectedPaths.length,
    missing_paths_count: missingPaths.length,
    benchmark_candidate: true,
  };
}

export async function importRetrievalFeedback(config: GoldenDatasetConfig, args: Record<string, unknown>) {
  const defaultFeedbackLog = path.join(os.homedir(), ".hwai", "retrieval-mcp", "feedback.jsonl");
  const feedbackLogPath = typeof args.feedback_log_path === "string" && args.feedback_log_path.trim()
    ? args.feedback_log_path.trim()
    : defaultFeedbackLog;
  const dataset = safeDatasetName(args.dataset || "retrieval-feedback");
  const date = typeof args.date === "string" && args.date.trim() ? args.date.trim().slice(0, 10) : "";
  const includeHelpful = args.include_helpful === true;
  const includeNonCandidates = args.include_non_candidates === true;
  const status = args.status === "reviewed" ? "reviewed" : "candidate";
  const rows = await readJsonl<RetrievalFeedbackLine>(feedbackLogPath);
  let imported = 0;
  let skipped = 0;
  const importedIds: string[] = [];

  for (const row of rows) {
    if (date && !String(row.ts || "").startsWith(date)) {
      skipped += 1;
      continue;
    }
    const outcome = row.outcome || "";
    const isHelpful = outcome === "helpful";
    const isCandidate = row.benchmark_candidate === true || (outcome && !isHelpful);
    if (!includeHelpful && isHelpful) {
      skipped += 1;
      continue;
    }
    if (!includeNonCandidates && !isCandidate) {
      skipped += 1;
      continue;
    }
    const result = await addCaseFromFeedback(config, {
      dataset,
      feedback_id: row.feedback_id,
      call_id: row.call_id,
      source_service: "retrieval-mcp",
      task_type: "retrieval",
      raw_query: row.query,
      corrected_query: row.corrected_query,
      query_summary: row.notes ? clampText(String(row.notes).replace(/\s+/g, " "), 240) : undefined,
      expected_paths: row.expected_paths,
      missing_paths: row.missing_paths,
      tags: ["retrieval-feedback", outcome || "unknown-outcome"],
      status,
    });
    imported += 1;
    importedIds.push(result.case_id);
  }

  return {
    schema_version: "golden-dataset-feedback-import.v1",
    dataset,
    imported_count: imported,
    skipped_count: skipped,
    cases_added: imported,
    imported_case_id_hashes: importedIds.map(stableHash),
  };
}

function normalizeResults(results: unknown): Map<string, NormalizedPathResult> {
  const out = new Map<string, NormalizedPathResult>();
  if (!Array.isArray(results)) {
    return out;
  }
  for (const item of results as PathResultInput[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const caseId = typeof item.case_id === "string" ? item.case_id : "";
    if (!caseId) {
      continue;
    }
    const sourceTokens = safeTokenEstimate(item.source_tokens_estimate ?? item.raw_tokens_estimate);
    const compactTokens = safeTokenEstimate(item.compact_tokens_estimate);
    const savedTokens = safeTokenEstimate(item.saved_tokens_estimate) || (
      sourceTokens > 0 && compactTokens > 0 ? Math.max(0, sourceTokens - compactTokens) : 0
    );
    out.set(caseId, {
      returned_paths: safePathList(item.returned_paths),
      source_tokens_estimate: sourceTokens,
      compact_tokens_estimate: compactTokens,
      saved_tokens_estimate: savedTokens,
    });
  }
  return out;
}

function normalizeQueryOverrides(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(value)) {
    return out;
  }
  for (const item of value as QueryOverrideInput[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const caseId = typeof item.case_id === "string" ? item.case_id : "";
    const query = typeof item.query === "string" ? item.query.trim() : "";
    if (caseId && query) {
      out.set(caseId, query.slice(0, 2_000));
    }
  }
  return out;
}

function evaluateCase(goldenCase: GoldenCase, result: NormalizedPathResult | undefined): DatasetRunCaseResult {
  const expected = goldenCase.expected_paths || [];
  const expectedSet = new Set(expected);
  const returnedPaths = result?.returned_paths || [];
  const returned = returnedPaths.slice(0, 50);
  const firstRankIndex = returned.findIndex((item) => expectedSet.has(item));
  const matchesAt5 = returned.slice(0, 5).filter((item) => expectedSet.has(item)).length;
  const matchesAt10 = returned.slice(0, 10).filter((item) => expectedSet.has(item)).length;
  const expectedCount = expected.length;
  const recallAt5 = expectedCount > 0 ? matchesAt5 / expectedCount : 0;
  const recallAt10 = expectedCount > 0 ? matchesAt10 / expectedCount : 0;
  return {
    case_id: goldenCase.case_id,
    expected_count: expectedCount,
    returned_count: returned.length,
    recall_at_5: round(recallAt5, 4),
    recall_at_10: round(recallAt10, 4),
    first_match_rank: firstRankIndex >= 0 ? firstRankIndex + 1 : null,
    missing_count: Math.max(0, expectedCount - matchesAt10),
    pass: expectedCount > 0 && matchesAt10 > 0,
    source_tokens_estimate: result?.source_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || 0,
  };
}

export async function runDataset(config: GoldenDatasetConfig, args: Record<string, unknown>): Promise<DatasetRun> {
  const datasetName = safeDatasetName(args.dataset);
  const dataset = await readDataset(config, datasetName);
  const resultMap = normalizeResults(args.results);
  const runner = typeof args.runner === "string" && args.runner.trim() ? args.runner.trim().slice(0, 80) : "manual";
  const runId = safeId(
    typeof args.run_id === "string" && args.run_id.trim()
      ? args.run_id.trim()
      : `${dataset.dataset}-${new Date().toISOString().replace(/[:.]/g, "")}-${stableHash(JSON.stringify(args.results || []))}`,
  );

  const runnableCases = dataset.cases.filter((item) => item.status === "reviewed" || args.include_candidates === true);
  const hasResults = resultMap.size > 0;
  const resultCases = hasResults ? runnableCases.map((item) => evaluateCase(item, resultMap.get(item.case_id))) : [];
  const casesRun = resultCases.length;
  const casesPassed = resultCases.filter((item) => item.pass).length;
  const reciprocalRanks = resultCases.map((item) => (item.first_match_rank ? 1 / item.first_match_rank : 0));
  const recallAt5 = casesRun > 0 ? resultCases.reduce((sum, item) => sum + item.recall_at_5, 0) / casesRun : 0;
  const recallAt10 = casesRun > 0 ? resultCases.reduce((sum, item) => sum + item.recall_at_10, 0) / casesRun : 0;
  const mrr = reciprocalRanks.length > 0 ? reciprocalRanks.reduce((sum, item) => sum + item, 0) / reciprocalRanks.length : 0;
  const sourceTokens = resultCases.reduce((sum, item) => sum + item.source_tokens_estimate, 0);
  const compactTokens = resultCases.reduce((sum, item) => sum + item.compact_tokens_estimate, 0);
  const savedTokens = resultCases.reduce((sum, item) => sum + item.saved_tokens_estimate, 0);
  const run: DatasetRun = {
    schema_version: "golden-dataset-run.v1",
    run_id: runId,
    dataset: dataset.dataset,
    runner,
    status: hasResults ? "completed" : "needs_results",
    created_at: new Date().toISOString(),
    cases_run: casesRun,
    cases_passed: casesPassed,
    cases_failed: Math.max(0, casesRun - casesPassed),
    recall_at_5_pct: round(recallAt5 * 100, 1),
    recall_at_10_pct: round(recallAt10 * 100, 1),
    mrr: round(mrr, 4),
    source_tokens_estimate: sourceTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: sourceTokens > 0 ? round((savedTokens / sourceTokens) * 100, 1) : 0,
    result_cases: resultCases,
  };

  await fs.mkdir(config.runsDir, { recursive: true });
  await fs.writeFile(runPath(config, runId), `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const compact = {
    ...run,
    result_cases: run.result_cases.slice(0, 20),
  };
  const artifact = await writeArtifact(config, `${runId}.json`, `${JSON.stringify(compact, null, 2)}\n`);
  run.artifact_file = artifact.file;
  run.artifact_url = artifact.url;
  await fs.writeFile(runPath(config, runId), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return run;
}

async function defaultRetrievalCommand(): Promise<{ command: string; args: string[] }> {
  const explicit = process.env.GOLDEN_DATASET_RETRIEVAL_STDIO?.trim();
  if (explicit) {
    return { command: explicit, args: [] };
  }

  const candidates = [
    path.resolve(process.cwd(), "../retrieval-mcp/scripts/local-stdio.sh"),
    path.resolve(process.cwd(), "services/retrieval-mcp/scripts/local-stdio.sh"),
    path.resolve(process.cwd(), "../../services/retrieval-mcp/scripts/local-stdio.sh"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return { command: candidate, args: [] };
    }
  }
  throw new Error("retrieval-mcp local-stdio.sh not found; set GOLDEN_DATASET_RETRIEVAL_STDIO");
}

async function callRetrievalMcp(args: {
  command?: string;
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
  tool: "find_files" | "retrieve_context";
  payload: Record<string, unknown>;
}): Promise<Record<string, any>> {
  const resolved = args.command
    ? { command: args.command, args: args.commandArgs || [] }
    : await defaultRetrievalCommand();
  const request = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: args.tool,
      arguments: args.payload,
    },
  };
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "golden-dataset-mcp", version: "0.1.1" },
    },
  };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
  const input = `${JSON.stringify(initialize)}\n${JSON.stringify(initialized)}\n${JSON.stringify(request)}\n`;

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      env: { ...process.env, ...(args.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
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
      if (code !== 0) {
        reject(new Error(`retrieval-mcp exited ${code}: ${clampText(stderr, 500)}`));
        return;
      }
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const response = rows.find((row) => row.id === 2);
      if (!response) {
        reject(new Error("retrieval-mcp returned no tool response"));
        return;
      }
      if (response.error || response.result?.isError) {
        reject(new Error(response.error?.message || response.result?.content?.[0]?.text || "retrieval-mcp tool error"));
        return;
      }
      const text = response.result?.content?.[0]?.text;
      if (typeof text !== "string") {
        reject(new Error("retrieval-mcp returned no text content"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("retrieval-mcp returned non-JSON text content"));
      }
    });
    child.stdin.end(input);
  });
}

export async function runRetrievalDataset(config: GoldenDatasetConfig, args: Record<string, unknown>): Promise<DatasetRun> {
  const datasetName = safeDatasetName(args.dataset);
  const dataset = await readDataset(config, datasetName);
  const queryOverrides = normalizeQueryOverrides(args.query_overrides);
  const tool = args.retrieval_tool === "retrieve_context" ? "retrieve_context" : "find_files";
  const runner = typeof args.runner === "string" && args.runner.trim() ? args.runner.trim().slice(0, 80) : `retrieval-mcp:${tool}`;
  const command = typeof args.retrieval_mcp_command === "string" && args.retrieval_mcp_command.trim()
    ? args.retrieval_mcp_command.trim()
    : undefined;
  const commandArgs = Array.isArray(args.retrieval_mcp_args)
    ? args.retrieval_mcp_args.filter((item): item is string => typeof item === "string")
    : undefined;
  const retrievalCacheDir = typeof args.retrieval_cache_dir === "string" && args.retrieval_cache_dir.trim()
    ? args.retrieval_cache_dir.trim()
    : undefined;
  const repoRoot = typeof args.repo_root === "string" && args.repo_root.trim() ? args.repo_root.trim() : undefined;
  const maxFiles = typeof args.max_files === "number" && Number.isFinite(args.max_files) ? Math.max(1, Math.min(100, Math.floor(args.max_files))) : 20;
  const runId = typeof args.run_id === "string" && args.run_id.trim()
    ? args.run_id.trim()
    : `${dataset.dataset}-${tool}-${new Date().toISOString().replace(/[:.]/g, "")}`;
  const runnableCases = dataset.cases.filter((item) => item.status === "reviewed" || args.include_candidates === true);
  const results: Array<{
    case_id: string;
    compact_tokens_estimate: number;
    returned_paths: string[];
    saved_tokens_estimate: number;
    source_tokens_estimate: number;
  }> = [];
  let retrievalCalls = 0;
  let retrievalErrors = 0;
  let skippedCases = 0;

  for (const item of runnableCases) {
    const query = queryOverrides.get(item.case_id) || item.query_summary || "";
    if (!query.trim()) {
      skippedCases += 1;
      continue;
    }
    try {
      retrievalCalls += 1;
      const result = await callRetrievalMcp({
        command,
        commandArgs,
        tool,
        env: retrievalCacheDir
          ? {
              RETRIEVAL_CACHE_DIR: retrievalCacheDir,
              RETRIEVAL_REQUEST_LOG_PATH: path.join(retrievalCacheDir, "requests.jsonl"),
              RETRIEVAL_FEEDBACK_LOG_PATH: path.join(retrievalCacheDir, "feedback.jsonl"),
            }
          : undefined,
        payload: {
          query,
          root_path: repoRoot,
          max_files: maxFiles,
          max_snippets: tool === "retrieve_context" ? 8 : undefined,
          max_chars: tool === "retrieve_context" ? 8_000 : undefined,
          metadata: { source: "golden-dataset-runner" },
        },
      });
      const returnedPaths = Array.isArray(result.ranked_files)
        ? result.ranked_files
            .map((file: any) => (typeof file?.path === "string" ? file.path : ""))
            .filter(Boolean)
            .slice(0, maxFiles)
        : [];
      const inputStats = result.input_stats && typeof result.input_stats === "object" ? result.input_stats : {};
      const sourceTokens = safeTokenEstimate(inputStats.raw_tokens_estimate ?? inputStats.source_tokens_estimate);
      const compactTokens = safeTokenEstimate(inputStats.compact_tokens_estimate);
      const savedTokens = safeTokenEstimate(inputStats.saved_tokens_estimate) || (
        sourceTokens > 0 && compactTokens > 0 ? Math.max(0, sourceTokens - compactTokens) : 0
      );
      results.push({
        case_id: item.case_id,
        returned_paths: returnedPaths,
        source_tokens_estimate: sourceTokens,
        compact_tokens_estimate: compactTokens,
        saved_tokens_estimate: savedTokens,
      });
    } catch {
      retrievalErrors += 1;
      results.push({
        case_id: item.case_id,
        returned_paths: [],
        source_tokens_estimate: 0,
        compact_tokens_estimate: 0,
        saved_tokens_estimate: 0,
      });
    }
  }

  const run = await runDataset(config, {
    dataset: dataset.dataset,
    runner,
    run_id: runId,
    include_candidates: args.include_candidates === true,
    results,
  });
  run.retrieval_calls = retrievalCalls;
  run.retrieval_errors = retrievalErrors;
  run.skipped_cases = skippedCases;
  await fs.mkdir(config.runsDir, { recursive: true });
  await fs.writeFile(runPath(config, run.run_id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return run;
}

async function readRun(config: GoldenDatasetConfig, value: unknown): Promise<DatasetRun | null> {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const id = path.basename(value.trim()).replace(/\.json$/, "");
  return readJson<DatasetRun>(runPath(config, id));
}

export async function compareRuns(config: GoldenDatasetConfig, args: Record<string, unknown>) {
  const baseline = await readRun(config, args.baseline_run_id);
  const candidate = await readRun(config, args.candidate_run_id);
  if (!baseline || !candidate) {
    return {
      schema_version: "golden-dataset-run-comparison.v1",
      status: "missing_run",
      baseline_found: Boolean(baseline),
      candidate_found: Boolean(candidate),
    };
  }
  const recallAt5Ok = candidate.recall_at_5_pct >= baseline.recall_at_5_pct;
  const recallAt10Ok = candidate.recall_at_10_pct >= baseline.recall_at_10_pct;
  const mrrOk = candidate.mrr >= baseline.mrr;
  const comparableTokens = baseline.compact_tokens_estimate > 0 && candidate.compact_tokens_estimate > 0;
  const tokenUsageOk = !comparableTokens || candidate.compact_tokens_estimate <= baseline.compact_tokens_estimate;
  const casesOk = candidate.cases_failed <= baseline.cases_failed;
  const qualityGatePassed = casesOk && recallAt5Ok && recallAt10Ok && mrrOk && tokenUsageOk;
  return {
    schema_version: "golden-dataset-run-comparison.v1",
    status: "completed",
    dataset: candidate.dataset,
    baseline_run_id: baseline.run_id,
    candidate_run_id: candidate.run_id,
    deltas: {
      cases_failed: candidate.cases_failed - baseline.cases_failed,
      recall_at_5_pct: round(candidate.recall_at_5_pct - baseline.recall_at_5_pct, 1),
      recall_at_10_pct: round(candidate.recall_at_10_pct - baseline.recall_at_10_pct, 1),
      mrr: round(candidate.mrr - baseline.mrr, 4),
      source_tokens_estimate: candidate.source_tokens_estimate - baseline.source_tokens_estimate,
      compact_tokens_estimate: candidate.compact_tokens_estimate - baseline.compact_tokens_estimate,
      saved_tokens_estimate: candidate.saved_tokens_estimate - baseline.saved_tokens_estimate,
      savings_pct: round(candidate.savings_pct - baseline.savings_pct, 1),
    },
    quality_gate: {
      cases_ok: casesOk,
      recall_at_5_ok: recallAt5Ok,
      recall_at_10_ok: recallAt10Ok,
      mrr_ok: mrrOk,
      token_usage_ok: tokenUsageOk,
      token_usage_compared: comparableTokens,
      passed: qualityGatePassed,
    },
    regression: !qualityGatePassed,
  };
}

export async function buildDatasetManifestArtifact(config: GoldenDatasetConfig, args: Record<string, unknown>) {
  const datasetName = safeDatasetName(args.dataset);
  const dataset = await readDataset(config, datasetName);
  const manifest = {
    schema_version: "golden-dataset-manifest.v1",
    dataset: dataset.dataset,
    cases: dataset.cases.map((item) => ({
      case_id: item.case_id,
      task_type: item.task_type,
      source_service: item.source_service,
      status: item.status,
      expected_paths_count: item.expected_paths.length,
      missing_paths_count: item.missing_paths.length,
      tags: item.tags,
    })),
  };
  const artifact = await writeArtifact(config, `${dataset.dataset}-manifest-${Date.now()}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  const stats = tokenStats(JSON.stringify(dataset), JSON.stringify(manifest));
  return {
    schema_version: "golden-dataset-manifest.v1",
    dataset: dataset.dataset,
    cases: dataset.cases.length,
    artifact_file: artifact.file,
    artifact_url: artifact.url,
    ...stats,
  };
}
