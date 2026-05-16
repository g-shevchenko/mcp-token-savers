#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRetrievalConfig } from "../dist/config.js";
import { retrieveContext } from "../dist/retrieval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serviceDir, "../..");
const projectRoot = path.resolve(serviceDir, "../../../..");
const benchmarkDir = path.join(serviceDir, "benchmarks");
const benchmarkFiles = ["golden-queries.json", "from-traces.json"];
const NOISE_PATTERNS = [
  ".claude/worktrees/",
  "node_modules/",
  "/dist/",
  "/build/",
  "/coverage/",
  "CREDENTIALS.md",
  ".env",
];

function rankOf(paths, expectedPaths) {
  const ranks = expectedPaths
    .map((expectedPath) => paths.indexOf(expectedPath))
    .filter((rank) => rank >= 0)
    .map((rank) => rank + 1);
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

function reciprocalRank(rank) {
  return rank ? 1 / rank : 0;
}

async function pathExists(root, relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function hasNoise(paths) {
  return paths.filter((candidate) => NOISE_PATTERNS.some((pattern) => candidate.includes(pattern)));
}

function snippetPrecision(result, expectedTerms) {
  if (!expectedTerms?.length) {
    return true;
  }
  const haystack = result.snippets.map((snippet) => snippet.text).join("\n").toLowerCase();
  return expectedTerms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function symbolPrecision(result, expectedSymbols) {
  if (!expectedSymbols?.length) {
    return true;
  }
  const symbols = [
    ...(result.definitions || []),
    ...(result.symbols || []),
  ].map((symbol) => String(symbol.name || "").toLowerCase());
  return expectedSymbols.some((symbol) => symbols.includes(String(symbol).toLowerCase()));
}

function hintPrecision(result, expectedHintKinds) {
  if (!expectedHintKinds?.length) {
    return true;
  }
  const reasons = result.ranked_files
    .flatMap((file) => file.reasons || [])
    .join("\n")
    .toLowerCase();
  return expectedHintKinds.some((kind) => reasons.includes(`context hint: ${String(kind).toLowerCase()}`));
}

async function readBenchmarkCases(fileName) {
  const fullPath = path.join(benchmarkDir, fileName);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    const cases = Array.isArray(parsed) ? parsed : parsed.cases || [];
    return cases.map((testCase) => ({ ...testCase, source_file: fileName }));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const cases = (await Promise.all(benchmarkFiles.map(readBenchmarkCases))).flat();
if (cases.length === 0) {
  throw new Error(`No benchmark cases found in ${benchmarkDir}`);
}
const config = getRetrievalConfig();
const rows = [];
const failures = [];

for (const testCase of cases) {
  const started = Date.now();
  const caseRoot =
    testCase.root_path === "project"
      ? projectRoot
      : typeof testCase.root_path === "string"
        ? path.resolve(serviceDir, testCase.root_path)
        : repoRoot;
  const expectedPaths = Array.isArray(testCase.expected_paths) ? testCase.expected_paths : [];
  const existingExpectedPaths = [];
  for (const expectedPath of expectedPaths) {
    if (await pathExists(caseRoot, expectedPath)) {
      existingExpectedPaths.push(expectedPath);
    }
  }
  if (expectedPaths.length > 0 && existingExpectedPaths.length === 0) {
    rows.push({
      name: testCase.name,
      source_file: testCase.source_file,
      skipped: true,
      skip_reason: "expected paths are absent in this checkout",
      missing_expected_paths: expectedPaths,
      latency_ms: Date.now() - started,
    });
    continue;
  }

  const result = await retrieveContext(testCase.query, config, {
    root_path: caseRoot,
    task_intent: testCase.task_intent || "unknown",
    include_globs: testCase.include_globs,
    exclude_globs: testCase.exclude_globs,
    context_hints: testCase.context_hints,
    max_files: testCase.max_files || 10,
    max_snippets: testCase.max_snippets || 12,
    max_chars: testCase.max_chars || 12_000,
  });
  const latencyMs = Date.now() - started;
  const rankedPaths = result.ranked_files.map((file) => file.path);
  const snippetPaths = result.snippets.map((snippet) => snippet.path);
  const combinedPaths = [...rankedPaths, ...snippetPaths];
  const rank = rankOf(rankedPaths, existingExpectedPaths.length > 0 ? existingExpectedPaths : expectedPaths);
  const noise = hasNoise(combinedPaths);
  const termHit = snippetPrecision(result, testCase.expected_terms);
  const symbolHit = symbolPrecision(result, testCase.expected_symbols);
  const hintHit = hintPrecision(result, testCase.expected_hint_kinds);
  const row = {
    name: testCase.name,
    source_file: testCase.source_file,
    rank,
    recall_at_5: rank !== null && rank <= 5,
    recall_at_10: rank !== null && rank <= 10,
    reciprocal_rank: reciprocalRank(rank),
    snippet_precision: termHit,
    symbol_precision: symbolHit,
    hint_precision: hintHit,
    context_hints_applied_count: result.input_stats.context_hints_applied_count || 0,
    noise_hits: noise,
    truncated: Boolean(result.quality?.truncated),
    savings_pct: result.input_stats.savings_pct,
    latency_ms: latencyMs,
  };
  rows.push(row);

  if (!row.recall_at_10) {
    failures.push(`${testCase.name}: expected path not found in top 10`);
  }
  if (!row.snippet_precision) {
    failures.push(`${testCase.name}: expected terms not found in snippets`);
  }
  if (!row.symbol_precision) {
    failures.push(`${testCase.name}: expected symbols not found in symbol map`);
  }
  if (!row.hint_precision) {
    failures.push(`${testCase.name}: expected context hint kind not reflected in ranking reasons`);
  }
  if (row.noise_hits.length > 0) {
    failures.push(`${testCase.name}: noise paths returned: ${row.noise_hits.join(", ")}`);
  }
  if (row.truncated) {
    failures.push(`${testCase.name}: retrieval output was truncated`);
  }
}

const scoredRows = rows.filter((row) => !row.skipped);
const divisor = scoredRows.length || 1;
const recallAt5 = scoredRows.filter((row) => row.recall_at_5).length / divisor;
const recallAt10 = scoredRows.filter((row) => row.recall_at_10).length / divisor;
const mrr = scoredRows.reduce((sum, row) => sum + row.reciprocal_rank, 0) / divisor;
const symbolPrecisionRate = scoredRows.filter((row) => row.symbol_precision).length / divisor;
const hintPrecisionRate = scoredRows.filter((row) => row.hint_precision).length / divisor;
const avgSavings = scoredRows.reduce((sum, row) => sum + (row.savings_pct || 0), 0) / divisor;
const p95Latency = scoredRows
  .map((row) => row.latency_ms)
  .sort((a, b) => a - b)[Math.min(scoredRows.length - 1, Math.floor(scoredRows.length * 0.95))] || 0;

const summary = {
  benchmark: "retrieval-mcp-golden",
  cases: rows.length,
  scored_cases: scoredRows.length,
  skipped_cases: rows.length - scoredRows.length,
  sources: Object.fromEntries(
    benchmarkFiles.map((fileName) => [
      fileName,
      rows.filter((row) => row.source_file === fileName).length,
    ]),
  ),
  recall_at_5: Math.round(recallAt5 * 1000) / 1000,
  recall_at_10: Math.round(recallAt10 * 1000) / 1000,
  mrr: Math.round(mrr * 1000) / 1000,
  symbol_precision: Math.round(symbolPrecisionRate * 1000) / 1000,
  hint_precision: Math.round(hintPrecisionRate * 1000) / 1000,
  avg_savings_pct: Math.round(avgSavings * 10) / 10,
  p95_latency_ms: p95Latency,
  failures,
};

console.log(JSON.stringify({ summary, rows }, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
