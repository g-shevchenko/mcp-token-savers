#!/usr/bin/env node
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getContextPrepConfig } from "../dist/config.js";
import { prepLogs } from "../dist/prep-logs.js";
import { prepText } from "../dist/prep-text.js";
import { prepUrl } from "../dist/prep-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(__dirname, "..");
process.env.CONTEXT_PREP_CACHE_DIR ||= path.join(os.tmpdir(), "hwai-context-prep-mcp-benchmark");

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
}

function longBuildLog() {
  return [
    ...Array.from({ length: 500 }, (_, index) =>
      `info compile package=context-prep chunk=${index} status=ok elapsed_ms=${index % 17}`,
    ),
    "$ npm run build",
    "src/server.ts:42:11 - error TS2304: Cannot find name 'contextPrep'.",
    "  at buildContext (src/server.ts:42:11)",
    "Build failed with 1 error",
    ...Array.from({ length: 500 }, (_, index) =>
      `info cleanup artifact=dist/${index}.js status=skipped reason=build_failed`,
    ),
  ].join("\n");
}

function longHandoffText() {
  const block = [
    "Решение: запускаем context-prep-mcp parser-first, без LLM в v1.",
    "Нужно добавить prep_logs, prep_url, prep_text и artifact fallback.",
    "Action item: add local benchmark and measurement report before tuning compaction.",
    "Open question: when should ContentOS call prep synchronously?",
    "Risk: exact wording can be lost if compression is too aggressive.",
    "Decision: if uncertainty is above 0.03, inspect the raw artifact before final reasoning.",
  ].join("\n");
  return Array.from({ length: 70 }, () => block).join("\n\n");
}

function benchmarkHtml() {
  const repeated = Array.from(
    { length: 120 },
    (_, index) =>
      `<p>Context prep benchmark paragraph ${index}: token budget, latency, parser quality, and artifact fallback must stay measurable.</p>`,
  ).join("\n");
  return `<!doctype html>
<html>
  <head>
    <title>Context Prep Benchmark Page</title>
    <meta name="description" content="Synthetic local page for context-prep benchmark">
  </head>
  <body>
    <main>
      <h1>Context Prep Benchmark Page</h1>
      <h2>Measurement Loop</h2>
      <p>Price limit: 0 USD. Token savings target: 35% or higher.</p>
      ${repeated}
      <a href="https://example.com/docs">Docs</a>
    </main>
  </body>
</html>`;
}

async function withLocalServer(fn) {
  const server = createServer((req, res) => {
    if (req.url === "/benchmark") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(benchmarkHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}/benchmark`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack || "").includes(needle)) {
    throw new Error(message);
  }
}

function assertArrayHas(values, needle, message) {
  if (!Array.isArray(values) || !values.some((item) => String(item).includes(needle))) {
    throw new Error(message);
  }
}

async function runCase(name, fn, expectations) {
  const started = Date.now();
  const result = await fn();
  const latencyMs = Date.now() - started;
  const savingsPct = result.input_stats?.savings_pct || 0;
  const failures = [];
  const minSavingsPct = expectations.min_savings_pct || 0;
  if (savingsPct < minSavingsPct) {
    failures.push(`expected savings_pct >= ${minSavingsPct}, got ${savingsPct}`);
  }
  if (result.confidence?.uncertainty > 0.05) {
    failures.push(`uncertainty too high: ${result.confidence.uncertainty}`);
  }
  if (expectations.parser_used && result.parser_stack?.used !== expectations.parser_used) {
    failures.push(`expected parser_used=${expectations.parser_used}, got ${result.parser_stack?.used || "n/a"}`);
  }
  if (expectations.requires_artifacts && (!result.artifacts || Object.keys(result.artifacts).length === 0)) {
    failures.push("expected artifact fallback URLs");
  }
  return {
    name,
    prep_mode: result.prep_mode,
    parser_used: result.parser_stack?.used || "n/a",
    scraper_fallback_reason: result.parser_stack?.fallback_reason || "none",
    artifact_count: result.artifacts ? Object.keys(result.artifacts).length : 0,
    raw_tokens_estimate: result.input_stats?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result.input_stats?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result.input_stats?.saved_tokens_estimate || 0,
    savings_pct: savingsPct,
    uncertainty: result.confidence?.uncertainty ?? null,
    requires_clarification: result.autopilot?.requires_clarification === true,
    latency_ms: latencyMs,
    expectations,
    failures,
  };
}

const config = {
  ...getContextPrepConfig(),
  allowPrivateUrls: true,
  allowAnyUrl: true,
};

const rows = [];
const failures = [];

rows.push(
  await runCase(
    "logs-build-error",
    async () => {
      const result = await prepLogs(longBuildLog(), config, { context: "local benchmark build failure" });
      assertIncludes(result.likely_root_cause, "TS2304", "missing first real error");
      assertArrayHas(result.impacted_files, "src/server.ts", "missing impacted source file");
      return result;
    },
    {
      min_savings_pct: 60,
      requires_artifacts: true,
    },
  ),
);

rows.push(
  await runCase(
    "text-handoff-ru-en",
    async () => {
      const result = await prepText(longHandoffText(), config, { purpose: "local benchmark handoff" });
      if (!result.extracted.decisions.length) {
        throw new Error("missing decisions");
      }
      if (!result.extracted.action_items.length) {
        throw new Error("missing action items");
      }
      if (!result.extracted.open_questions.length) {
        throw new Error("missing open questions");
      }
      if (!result.extracted.risks.length) {
        throw new Error("missing risks");
      }
      return result;
    },
    {
      min_savings_pct: 80,
      requires_artifacts: true,
    },
  ),
);

rows.push(
  await withLocalServer((url) =>
    runCase(
      "url-local-html",
      async () => {
        const result = await prepUrl(url, config, { parser_stack: "local", purpose: "local benchmark URL prep" });
        assertIncludes(result.title, "Context Prep Benchmark Page", "missing title");
        assertArrayHas(result.headings, "Measurement Loop", "missing heading");
        assertArrayHas(result.key_facts, "Token savings target", "missing key fact");
        if (result.parser_stack.used !== "local") {
          throw new Error(`expected local parser, got ${result.parser_stack.used}`);
        }
        return result;
      },
      {
        min_savings_pct: 50,
        parser_used: "local",
        requires_artifacts: true,
      },
    ),
  ),
);

for (const row of rows) {
  for (const failure of row.failures) {
    failures.push(`${row.name}: ${failure}`);
  }
}

const totalRawTokens = rows.reduce((sum, row) => sum + row.raw_tokens_estimate, 0);
const totalCompactTokens = rows.reduce((sum, row) => sum + row.compact_tokens_estimate, 0);
const totalSavedTokens = rows.reduce((sum, row) => sum + row.saved_tokens_estimate, 0);
const summary = {
  benchmark: "context-prep-local-golden",
  service_dir: serviceDir,
  cases: rows.length,
  quality_gates: {
    min_weighted_savings_pct: 85,
    max_uncertainty: 0.05,
    logs_min_savings_pct: 60,
    text_min_savings_pct: 80,
    url_min_savings_pct: 50,
    url_expected_parser: "local",
    artifact_fallback_required: true,
  },
  total_raw_tokens_estimate: totalRawTokens,
  total_compact_tokens_estimate: totalCompactTokens,
  total_saved_tokens_estimate: totalSavedTokens,
  weighted_savings_pct:
    totalRawTokens > 0 ? Number(((totalSavedTokens / totalRawTokens) * 100).toFixed(1)) : 0,
  min_savings_pct: Math.min(...rows.map((row) => row.savings_pct)),
  p95_latency_ms: percentile(rows.map((row) => row.latency_ms), 0.95),
  failures,
};

if (summary.weighted_savings_pct < summary.quality_gates.min_weighted_savings_pct) {
  failures.push(
    `weighted_savings_pct expected >= ${summary.quality_gates.min_weighted_savings_pct}, got ${summary.weighted_savings_pct}`,
  );
}

const payload = { summary, rows };
const outPath = argValue("--out", "");
const rendered = `${JSON.stringify(payload, null, 2)}\n`;
if (outPath) {
  const { promises: fs } = await import("node:fs");
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
}

console.log(rendered);

if (failures.length > 0) {
  process.exit(1);
}
