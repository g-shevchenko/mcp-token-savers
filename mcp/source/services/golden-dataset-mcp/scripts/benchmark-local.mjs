#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "golden-dataset-mcp-benchmark-"));
process.env.GOLDEN_DATASET_CACHE_DIR = path.join(tempDir, "cache");

const { getGoldenDatasetConfig } = await import("../dist/config.js");
const {
  addCaseFromFeedback,
  compareRuns,
  importRetrievalFeedback,
  listDatasets,
  runDataset,
  runRetrievalDataset,
  buildDatasetManifestArtifact,
} = await import("../dist/dataset-store.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");
const { appendRequestLog } = await import("../dist/request-log.js");

const config = getGoldenDatasetConfig();
const failures = [];
const retrievalServiceDir = path.resolve(process.cwd(), "../retrieval-mcp");
await execFileAsync("npm", ["run", "build"], { cwd: retrievalServiceDir });

function assert(name, condition, details = {}) {
  if (!condition) {
    failures.push({ name, details });
  }
}

async function callGoldenDatasetStdio(requests, env = {}) {
  const child = spawn(path.join(process.cwd(), "scripts", "local-stdio.sh"), {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) {
    throw new Error(`golden-dataset stdio exited ${code}: ${stderr.slice(0, 500)}`);
  }
  return stdout
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
}

function responsePayload(responses, id) {
  const row = responses.find((item) => item.id === id);
  const text = row?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : row?.result;
}

const addedOne = await addCaseFromFeedback(config, {
  dataset: "retrieval-quality",
  feedback_id: "feedback-bench-001",
  call_id: "call-bench-001",
  source_service: "retrieval-mcp",
  task_type: "retrieval",
  raw_query: "where does measurement report live",
  query_summary: "Find shared utility measurement report implementation.",
  expected_paths: ["scripts/hwai-utility-mcp-measurement-report.mjs"],
  missing_paths: ["services/retrieval-mcp/src/measurement.ts"],
  tags: ["retrieval", "measurement"],
  status: "reviewed",
});
await appendRequestLog(config, {
  tool: "add_case_from_feedback",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    raw_query_provided: true,
    expected_paths_count: 1,
    metadata_source: "benchmark-local",
  },
  output: {
    cases_added: 1,
    case_count: addedOne.cases,
  },
});
const addedTwo = await addCaseFromFeedback(config, {
  dataset: "retrieval-quality",
  feedback_id: "feedback-bench-002",
  source_service: "retrieval-mcp",
  task_type: "retrieval",
  query_summary: "Find retrieval feedback measurement code.",
  expected_paths: ["services/retrieval-mcp/src/measurement.ts"],
  tags: ["retrieval", "feedback"],
  status: "reviewed",
});
await appendRequestLog(config, {
  tool: "add_case_from_feedback",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    expected_paths_count: 1,
    metadata_source: "benchmark-local",
  },
  output: {
    cases_added: 1,
    case_count: addedTwo.cases,
  },
});
const feedbackLogPath = path.join(tempDir, "retrieval-feedback.jsonl");
await fs.writeFile(
  feedbackLogPath,
  `${JSON.stringify({
    ts: new Date().toISOString(),
    feedback_id: "feedback-bench-003",
    call_id: "call-bench-003",
    outcome: "partial",
    benchmark_candidate: true,
    query: "raw query from feedback should only be hashed",
    expected_paths: ["services/retrieval-mcp/src/retrieval.ts"],
    missing_paths: ["services/retrieval-mcp/src/retrieval.ts"],
  })}\n${JSON.stringify({
    ts: new Date().toISOString(),
    feedback_id: "feedback-helpful",
    outcome: "helpful",
    expected_paths: ["notes/should-not-import.md"],
  })}\n`,
  "utf8",
);
const imported = await importRetrievalFeedback(config, {
  dataset: "retrieval-quality",
  feedback_log_path: feedbackLogPath,
  status: "reviewed",
});
await appendRequestLog(config, {
  tool: "import_retrieval_feedback",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    feedback_log_path_hash: "synthetic",
    metadata_source: "benchmark-local",
  },
  output: {
    cases_added: imported.cases_added,
    imported_count: imported.imported_count,
    skipped_count: imported.skipped_count,
  },
});
const list = await listDatasets(config);
await appendRequestLog(config, {
  tool: "list_datasets",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: { metadata_source: "benchmark-local" },
  output: {
    dataset_count: list.dataset_count,
    case_count: list.case_count,
  },
});
const baselineRun = await runDataset(config, {
  dataset: "retrieval-quality",
  runner: "baseline",
  run_id: "baseline",
  results: [
    {
      case_id: addedOne.case_id,
      returned_paths: ["scripts/hwai-utility-mcp-measurement-report.mjs"],
      source_tokens_estimate: 12_000,
      compact_tokens_estimate: 3_000,
      saved_tokens_estimate: 9_000,
    },
    {
      case_id: addedTwo.case_id,
      returned_paths: ["notes/other.md"],
      source_tokens_estimate: 11_000,
      compact_tokens_estimate: 2_800,
      saved_tokens_estimate: 8_200,
    },
    {
      case_id: "retrieval-mcp:feedback-bench-003",
      returned_paths: ["notes/missed.md"],
      source_tokens_estimate: 9_000,
      compact_tokens_estimate: 2_400,
      saved_tokens_estimate: 6_600,
    },
  ],
});
await appendRequestLog(config, {
  tool: "run_dataset",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    result_count: 2,
    metadata_source: "benchmark-local",
  },
  output: {
    cases_run: baselineRun.cases_run,
    cases_passed: baselineRun.cases_passed,
    cases_failed: baselineRun.cases_failed,
    recall_at_10_pct: baselineRun.recall_at_10_pct,
    raw_tokens_estimate: baselineRun.source_tokens_estimate,
    compact_tokens_estimate: baselineRun.compact_tokens_estimate,
    saved_tokens_estimate: baselineRun.saved_tokens_estimate,
    artifact_file: baselineRun.artifact_file,
  },
});
const candidateRun = await runDataset(config, {
  dataset: "retrieval-quality",
  runner: "candidate",
  run_id: "candidate",
  results: [
    {
      case_id: addedOne.case_id,
      returned_paths: ["scripts/hwai-utility-mcp-measurement-report.mjs"],
      source_tokens_estimate: 11_500,
      compact_tokens_estimate: 2_500,
      saved_tokens_estimate: 9_000,
    },
    {
      case_id: addedTwo.case_id,
      returned_paths: ["services/retrieval-mcp/src/measurement.ts"],
      source_tokens_estimate: 10_500,
      compact_tokens_estimate: 2_400,
      saved_tokens_estimate: 8_100,
    },
    {
      case_id: "retrieval-mcp:feedback-bench-003",
      returned_paths: ["services/retrieval-mcp/src/retrieval.ts"],
      source_tokens_estimate: 8_800,
      compact_tokens_estimate: 2_000,
      saved_tokens_estimate: 6_800,
    },
  ],
});
await appendRequestLog(config, {
  tool: "run_dataset",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    result_count: 2,
    metadata_source: "benchmark-local",
  },
  output: {
    cases_run: candidateRun.cases_run,
    cases_passed: candidateRun.cases_passed,
    cases_failed: candidateRun.cases_failed,
    recall_at_10_pct: candidateRun.recall_at_10_pct,
    raw_tokens_estimate: candidateRun.source_tokens_estimate,
    compact_tokens_estimate: candidateRun.compact_tokens_estimate,
    saved_tokens_estimate: candidateRun.saved_tokens_estimate,
    artifact_file: candidateRun.artifact_file,
  },
});
const comparison = await compareRuns(config, {
  baseline_run_id: "baseline",
  candidate_run_id: "candidate",
});
const retrievalRepo = path.join(tempDir, "retrieval-fixture-repo");
await fs.mkdir(path.join(retrievalRepo, "src"), { recursive: true });
await fs.writeFile(path.join(retrievalRepo, "src", "alpha-target.ts"), "export const alphaTarget = 'alpha target marker';\n", "utf8");
await fs.writeFile(path.join(retrievalRepo, "src", "noise.ts"), "export const noise = 'not relevant';\n", "utf8");
const retrievalCase = await addCaseFromFeedback(config, {
  dataset: "retrieval-runner",
  feedback_id: "feedback-runner-001",
  source_service: "retrieval-mcp",
  task_type: "retrieval",
  query_summary: "alpha target marker",
  expected_paths: ["src/alpha-target.ts"],
  tags: ["retrieval-runner"],
  status: "reviewed",
});
const retrievalRun = await runRetrievalDataset(config, {
  dataset: "retrieval-runner",
  repo_root: retrievalRepo,
  retrieval_tool: "retrieve_context",
  retrieval_mcp_command: path.join(retrievalServiceDir, "scripts", "local-stdio.sh"),
  retrieval_cache_dir: path.join(tempDir, "retrieval-cache"),
  runner: "retrieval-mcp-retrieve-context",
  run_id: "retrieval-runner",
  max_files: 5,
});
await appendRequestLog(config, {
  tool: "run_retrieval_dataset",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-runner",
    repo_root_hash: "synthetic",
    retrieval_tool: "retrieve_context",
    metadata_source: "benchmark-local",
  },
  output: {
    cases_run: retrievalRun.cases_run,
    cases_passed: retrievalRun.cases_passed,
    cases_failed: retrievalRun.cases_failed,
    retrieval_calls: retrievalRun.retrieval_calls,
    retrieval_errors: retrievalRun.retrieval_errors,
    skipped_cases: retrievalRun.skipped_cases,
    recall_at_10_pct: retrievalRun.recall_at_10_pct,
    raw_tokens_estimate: retrievalRun.source_tokens_estimate,
    compact_tokens_estimate: retrievalRun.compact_tokens_estimate,
    saved_tokens_estimate: retrievalRun.saved_tokens_estimate,
    artifact_file: retrievalRun.artifact_file,
  },
});
const manifest = await buildDatasetManifestArtifact(config, { dataset: "retrieval-quality" });
await appendRequestLog(config, {
  tool: "export_dataset_manifest",
  transport: "mcp",
  ok: true,
  duration_ms: 1,
  input: {
    dataset: "retrieval-quality",
    metadata_source: "benchmark-local",
  },
  output: {
    artifact_file: manifest.artifact_file,
    raw_tokens_estimate: manifest.raw_tokens_estimate,
    compact_tokens_estimate: manifest.compact_tokens_estimate,
    saved_tokens_estimate: manifest.saved_tokens_estimate,
  },
});
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const requestLog = await fs.readFile(config.requestLogPath, "utf8").catch(() => "");
const pipelineCount = 25;
const pipelineCacheDir = path.join(tempDir, "pipeline-cache");
const pipelineFeedbackLogPath = path.join(tempDir, "pipeline-feedback.jsonl");
const pipelineRows = Array.from({ length: pipelineCount }, (_, index) => {
  const id = String(index + 1).padStart(3, "0");
  return JSON.stringify({
    ts: new Date().toISOString(),
    feedback_id: `feedback-pipeline-${id}`,
    call_id: `call-pipeline-${id}`,
    outcome: "partial",
    benchmark_candidate: true,
    query: `raw pipelined query ${id} should only be hashed`,
    expected_paths: [`notes/pipeline-${id}.md`],
    missing_paths: [`notes/pipeline-${id}.md`],
  });
});
await fs.writeFile(pipelineFeedbackLogPath, `${pipelineRows.join("\n")}\n`, "utf8");
const pipelineResults = Array.from({ length: pipelineCount }, (_, index) => {
  const id = String(index + 1).padStart(3, "0");
  return {
    case_id: `retrieval-mcp:feedback-pipeline-${id}`,
    returned_paths: [`notes/pipeline-${id}.md`],
    source_tokens_estimate: 100,
    compact_tokens_estimate: 40,
    saved_tokens_estimate: 60,
  };
});
const pipelineResponses = await callGoldenDatasetStdio(
  [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "golden-dataset-pipeline-benchmark", version: "1.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "import_retrieval_feedback",
        arguments: {
          dataset: "pipeline-quality",
          feedback_log_path: pipelineFeedbackLogPath,
          status: "reviewed",
          metadata: { source: "benchmark-pipelined-stdio" },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "run_dataset",
        arguments: {
          dataset: "pipeline-quality",
          runner: "pipelined-stdio",
          run_id: "pipelined-stdio",
          results: pipelineResults,
          metadata: { source: "benchmark-pipelined-stdio" },
        },
      },
    },
  ],
  { GOLDEN_DATASET_CACHE_DIR: pipelineCacheDir },
);
const pipelineImport = responsePayload(pipelineResponses, 2);
const pipelineRun = responsePayload(pipelineResponses, 3);
const pipelineRequestLog = await fs.readFile(path.join(pipelineCacheDir, "requests.jsonl"), "utf8").catch(() => "");

assert("cases-added", addedOne.cases === 1 && addedTwo.cases === 2, { addedOne, addedTwo });
assert("feedback-import", imported.imported_count === 1 && imported.skipped_count === 1, imported);
assert("list-datasets", list.dataset_count === 1 && list.case_count === 3, list);
assert("baseline-run", baselineRun.cases_failed === 2 && baselineRun.recall_at_10_pct === 33.3, baselineRun);
assert("candidate-run", candidateRun.cases_failed === 0 && candidateRun.recall_at_10_pct === 100, candidateRun);
assert("compare-no-regression", comparison.status === "completed" && comparison.regression === false && comparison.deltas.mrr > 0, comparison);
assert(
  "compare-token-gate",
  comparison.quality_gate?.passed === true &&
    comparison.quality_gate?.token_usage_ok === true &&
    comparison.deltas.compact_tokens_estimate < 0,
  comparison,
);
assert("retrieval-runner-case", retrievalCase.cases === 1, retrievalCase);
assert(
  "retrieval-runner",
  retrievalRun.cases_failed === 0 &&
    retrievalRun.retrieval_calls === 1 &&
    retrievalRun.retrieval_errors === 0 &&
    retrievalRun.compact_tokens_estimate > 0,
  retrievalRun,
);
assert("manifest-artifact", manifest.artifact_file && manifest.saved_tokens_estimate >= 0, manifest);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("measurement-cases-run", measurement.quality.cases_run >= 4, measurement.quality);
assert(
  "pipelined-import-run-serialized",
  pipelineImport.imported_count === pipelineCount &&
    pipelineRun.cases_run === pipelineCount &&
    pipelineRun.cases_failed === 0,
  { pipelineImport, pipelineRun },
);
assert(
  "no-raw-query-in-log",
  !requestLog.includes("where does measurement report live") && !requestLog.includes("raw query from feedback should only be hashed"),
  {},
);
assert("no-absolute-path-in-log", !requestLog.includes("/Users/"), {});
assert(
  "pipelined-log-safe",
  !pipelineRequestLog.includes("raw pipelined query") && !pipelineRequestLog.includes(tempDir),
  {},
);

const result = {
  benchmark: "golden-dataset-local-golden",
  cases: 16,
  failures,
  rows: [
    { name: "datasets", value: list.dataset_count },
    { name: "cases", value: list.case_count },
    { name: "imported_feedback", value: imported.imported_count },
    { name: "baseline_failed", value: baselineRun.cases_failed },
    { name: "candidate_failed", value: candidateRun.cases_failed },
    { name: "candidate_recall_at_10_pct", value: candidateRun.recall_at_10_pct },
    { name: "candidate_compact_tokens_estimate", value: candidateRun.compact_tokens_estimate },
    { name: "compare_compact_token_delta", value: comparison.deltas?.compact_tokens_estimate },
    { name: "retrieval_runner_failed", value: retrievalRun.cases_failed },
    { name: "pipelined_cases_run", value: pipelineRun.cases_run },
    { name: "measurement_calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
