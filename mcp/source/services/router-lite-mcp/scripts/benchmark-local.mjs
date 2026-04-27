#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const { classifyInput } = await import("../dist/router.js");

const cases = [
  {
    name: "screenshot-url",
    text: "Посмотри скриншот https://example.com/screenshots/sample.png и скажи где баг UI",
    expectedDecision: "call_mcp",
    expectedMcps: ["vision-mcp"],
  },
  {
    name: "two-screenshot-diff",
    text: "Compare before https://example.com/screenshots/a.png and after https://example.com/screenshots/b.png",
    expectedDecision: "call_mcp",
    expectedMcps: ["vision-mcp"],
  },
  {
    name: "long-log",
    input_kind: "logs",
    text: Array.from({ length: 170 }, (_, index) => `line ${index} Error: failed to connect`).join("\n"),
    expectedDecision: "call_mcp",
    expectedMcps: ["context-prep-mcp"],
  },
  {
    name: "stack-trace",
    text: "TypeError: boom\n    at run (/repo/src/app.ts:10:3)\n    at main (/repo/src/app.ts:14:1)",
    expectedDecision: "call_mcp",
    expectedMcps: ["context-prep-mcp"],
  },
  {
    name: "long-spec",
    text: `Spec\n${"A long requirement sentence.\n".repeat(260)}`,
    expectedDecision: "call_mcp",
    expectedMcps: ["context-prep-mcp"],
  },
  {
    name: "read-url",
    text: "Read and summarize https://example.com/research/report",
    expectedDecision: "call_mcp",
    expectedMcps: ["context-prep-mcp"],
  },
  {
    name: "deep-research",
    text: "Do deep research and SERP crawl for competitor pricing pages",
    expectedDecision: "call_mcp",
    expectedMcps: ["scraper-stack"],
  },
  {
    name: "broad-repo-question",
    text: "Where is retrieval autopilot implemented across the repo?",
    expectedDecision: "call_mcp",
    expectedMcps: ["retrieval-mcp"],
  },
  {
    name: "exact-file-edit",
    text: "Update services/router-lite-mcp/src/router.ts line 20 to rename the variable",
    expectedDecision: "skip_mcp",
    expectedMcps: [],
  },
  {
    name: "run-typecheck",
    text: "Run tsc and lint proof loop for this package",
    expectedDecision: "call_mcp",
    expectedMcps: ["static-analysis-mcp"],
  },
  {
    name: "dependency-audit",
    text: "Check npm audit and license risk for this package-lock",
    expectedDecision: "call_mcp",
    expectedMcps: ["dependency-risk-mcp"],
  },
  {
    name: "docs-links",
    text: "Find broken links and stale refs in docs",
    expectedDecision: "call_mcp",
    expectedMcps: ["docs-hygiene-mcp"],
  },
  {
    name: "repo-cleanup",
    text: "Find unused dependencies and duplicate code cleanup plan",
    expectedDecision: "call_mcp",
    expectedMcps: ["repo-hygiene-mcp"],
  },
  {
    name: "quality-budget",
    text: "Check context pressure and new docs budget before merge",
    expectedDecision: "call_mcp",
    expectedMcps: ["repo-quality-gate-mcp"],
  },
  {
    name: "playwright-trace",
    artifact_kinds: ["trace.zip", "har"],
    text: "Analyze Playwright trace.zip failure window",
    expectedDecision: "call_mcp",
    expectedMcps: ["playwright-trace-mcp"],
  },
  {
    name: "short-conceptual",
    text: "What is MRR in retrieval evaluation?",
    expectedDecision: "skip_mcp",
    expectedMcps: [],
  },
  {
    name: "ambiguous-fix-it",
    text: "fix it",
    expectedDecision: "ask_clarification",
    expectedMcps: [],
  },
  {
    name: "high-risk-architecture",
    text: "Design the production auth architecture migration and final deployment plan",
    expectedDecision: "skip_mcp",
    expectedMcps: [],
    expectedFrontier: true,
  },
];

const rows = cases.map((testCase) => {
  const result = classifyInput({
    artifact_kinds: testCase.artifact_kinds,
    input_kind: testCase.input_kind,
    metadata: { source: "benchmark-local", traffic_class: "benchmark" },
    text: testCase.text,
  });
  const expectedSet = new Set(testCase.expectedMcps);
  const predictedSet = new Set(result.recommended_mcps);
  const missing = [...expectedSet].filter((item) => !predictedSet.has(item));
  const unexpected = [...predictedSet].filter((item) => !expectedSet.has(item));
  return {
    name: testCase.name,
    decision: result.decision,
    expectedDecision: testCase.expectedDecision,
    recommended_mcps: result.recommended_mcps,
    expected_mcps: testCase.expectedMcps,
    missing,
    unexpected,
    frontier_ok: testCase.expectedFrontier ? result.requires_frontier_reasoning === true && result.cheap_only_allowed === false : true,
    pass:
      result.decision === testCase.expectedDecision &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      (testCase.expectedFrontier ? result.requires_frontier_reasoning === true && result.cheap_only_allowed === false : true),
  };
});

const triggerCases = rows.filter((row) => row.expected_mcps.length > 0);
const predictedTrigger = rows.filter((row) => row.recommended_mcps.length > 0);
const triggerTp = predictedTrigger.filter((row) => row.expected_mcps.length > 0 && row.missing.length === 0 && row.unexpected.length === 0).length;
const triggerPrecision = predictedTrigger.length ? triggerTp / predictedTrigger.length : 1;
const triggerRecall = triggerCases.length ? triggerTp / triggerCases.length : 1;
const predictedSkip = rows.filter((row) => row.decision === "skip_mcp");
const correctSkip = predictedSkip.filter((row) => row.expectedDecision === "skip_mcp").length;
const skipPrecision = predictedSkip.length ? correctSkip / predictedSkip.length : 1;
const failures = rows.filter((row) => !row.pass);
if (triggerPrecision < 0.9) {
  failures.push({ name: "trigger-precision-threshold", triggerPrecision });
}
if (triggerRecall < 0.9) {
  failures.push({ name: "trigger-recall-threshold", triggerRecall });
}
if (skipPrecision < 0.9) {
  failures.push({ name: "skip-precision-threshold", skipPrecision });
}
const combined = JSON.stringify(rows);
if (combined.includes("A long requirement sentence") || combined.includes("failed to connect")) {
  failures.push({ name: "raw-input-leak" });
}

const result = {
  benchmark: "router-lite-trigger-policy-local-golden",
  cases: cases.length,
  failures,
  metrics: {
    trigger_precision: Number(triggerPrecision.toFixed(3)),
    trigger_recall: Number(triggerRecall.toFixed(3)),
    skip_precision: Number(skipPrecision.toFixed(3)),
  },
  rows,
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
