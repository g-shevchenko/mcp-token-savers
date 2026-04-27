#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildLanguageGraphIndex,
  findReferences,
  findSymbol,
  getBlastRadius,
  getFileOutline,
  getGraphStatus,
  getImportNeighbors,
} from "../dist/graph.js";
import { getLanguageGraphConfig } from "../dist/config.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function assert(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

async function writeFixture(root, fileName, content) {
  const filePath = path.join(root, fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "language-graph-bench-"));
process.env.LANGUAGE_GRAPH_CACHE_DIR = path.join(tmpRoot, ".cache");
const repoRoot = path.join(tmpRoot, "repo");
await fs.mkdir(repoRoot, { recursive: true });
const filler = "// language graph benchmark filler line that simulates real implementation context without adding symbols\n".repeat(80);
await writeFixture(
  repoRoot,
  "src/report.ts",
  `${filler}
export interface ReportConfig {
  limit: number;
}

export async function runReport(config: ReportConfig) {
  return formatReport(config.limit);
}

export const formatReport = (count: number) => \`rows:\${count}\`;
`,
);
await writeFixture(
  repoRoot,
  "src/api.ts",
  `import { runReport } from "./report";

export async function handleReportRoute() {
  return runReport({ limit: 3 });
}
`,
);
await writeFixture(
  repoRoot,
  "src/lazy.ts",
  `export async function lazyReportRoute() {
  const report = await import("./report");
  return report.runReport({ limit: 2 });
}
`,
);
await writeFixture(
  repoRoot,
  "src/report.test.ts",
  `import { runReport } from "./report";

test("runReport", async () => {
  await runReport({ limit: 1 });
});
`,
);
await writeFixture(
  repoRoot,
  "docs/runbook.md",
  `# Reporting Runbook

## Alert routing
`,
);

const config = getLanguageGraphConfig();
const failures = [];
const args = { repo_root: repoRoot, metadata: { source: "benchmark-local" } };
const indexed = await buildLanguageGraphIndex(config, args);
const status = await getGraphStatus(config, args);
const symbol = await findSymbol(config, { ...args, symbol_name: "runReport" });
const noNoise = await findSymbol(config, { ...args, symbol_name: "DefinitelyMissingThing" });
const outline = await getFileOutline(config, { ...args, file_path: "src/report.ts" });
const refs = await findReferences(config, { ...args, symbol_name: "runReport" });
const neighbors = await getImportNeighbors(config, { ...args, file_path: "src/report.ts" });
const blast = await getBlastRadius(config, { ...args, symbol_name: "runReport" });

assert(indexed.files_indexed === 5, "index should include five fixture files", failures);
assert(indexed.symbols_indexed >= 6, "index should extract code/doc symbols", failures);
assert(indexed.imports_indexed >= 3, "index should extract import edges", failures);
assert(indexed.dynamic_imports_indexed >= 1, "index should extract dynamic import edges", failures);
assert(indexed.references_indexed >= 3, "index should extract references", failures);
assert(status.status === "fresh", "status should be fresh after indexing", failures);
assert(symbol.symbols.some((item) => item.name === "runReport" && item.path === "src/report.ts"), "find_symbol should locate runReport", failures);
assert(noNoise.result_count === 0, "find_symbol should not return unrelated tool/route noise", failures);
assert(outline.symbols.some((item) => item.name === "ReportConfig"), "outline should include ReportConfig", failures);
assert(outline.importers.some((item) => item.path === "src/api.ts"), "outline should include api importer", failures);
assert(refs.references.some((item) => item.path === "src/api.ts"), "references should include api usage", failures);
assert(refs.references.some((item) => item.path === "src/report.test.ts"), "references should include test usage", failures);
assert(neighbors.importer_count >= 2, "import neighbors should find api and test importers", failures);
assert(
  neighbors.importers.some((item) => item.path === "src/lazy.ts" && item.kind === "dynamic_import"),
  "import neighbors should include dynamic importers",
  failures,
);
assert(blast.files.some((item) => item.path === "src/api.ts"), "blast radius should include api", failures);
assert(blast.files.some((item) => item.path === "src/lazy.ts"), "blast radius should include lazy import usage", failures);
assert(blast.files.some((item) => item.path === "src/report.test.ts"), "blast radius should include test", failures);
assert(indexed.saved_tokens_estimate > 0, "index should report token savings", failures);

const summary = {
  benchmark: "language-graph-local-golden",
  cases: 10,
  failures,
  rows: [
    { name: "files_indexed", value: indexed.files_indexed },
    { name: "symbols_indexed", value: indexed.symbols_indexed },
    { name: "imports_indexed", value: indexed.imports_indexed },
    { name: "dynamic_imports_indexed", value: indexed.dynamic_imports_indexed },
    { name: "references_indexed", value: indexed.references_indexed },
    { name: "find_symbol_results", value: symbol.result_count },
    { name: "find_symbol_noise_results", value: noNoise.result_count },
    { name: "references_returned", value: refs.references_returned },
    { name: "importers_returned", value: neighbors.importer_count },
    { name: "blast_radius_files", value: blast.blast_radius_files },
  ],
};

const outPath = argValue("--out", "");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  process.exit(1);
}
