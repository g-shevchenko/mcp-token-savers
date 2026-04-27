#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function git(root, args) {
  await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 10 * 1024 * 1024 });
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-quality-gate-mcp-benchmark-"));
process.env.REPO_QUALITY_GATE_CACHE_DIR = path.join(tempDir, "cache");
const fixture = path.join(tempDir, "fixture");
await fs.mkdir(path.join(fixture, "src"), { recursive: true });
await fs.mkdir(path.join(fixture, "docs"), { recursive: true });
await fs.writeFile(path.join(fixture, "README.md"), "# Fixture\n\nSmall baseline doc.\n", "utf8");
await fs.writeFile(path.join(fixture, "src", "app.ts"), "export const baseline = 1;\n", "utf8");
await git(fixture, ["init"]);
await git(fixture, ["add", "."]);
await git(fixture, ["-c", "user.name=HWAI", "-c", "user.email=hwai@example.test", "commit", "-m", "baseline"]);

const { getRepoQualityGateConfig } = await import("../dist/config.js");
const {
  checkContextBudget,
  checkNewCodeBudget,
  checkNewDocsBudget,
  compareQualitySnapshot,
  createQualitySnapshot,
  proposeQualityGatePlan,
} = await import("../dist/gate.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getRepoQualityGateConfig();
const common = {
  repo_root: fixture,
  base_ref: "HEAD",
  max_added_code_lines: 2,
  max_added_doc_lines: 4,
  max_changed_code_files: 1,
  max_changed_doc_files: 1,
  max_context_pressure_score: 5,
  max_large_docs: 0,
  large_doc_lines: 6,
  max_findings: 20,
  metadata: { source: "benchmark-local" },
};
const baseline = await createQualitySnapshot(config, common);

await fs.writeFile(
  path.join(fixture, "src", "new-feature.ts"),
  [
    "export function newFeature(input: string) {",
    "  const normalized = input.trim().toLowerCase();",
    "  const parts = normalized.split('-');",
    "  return parts.filter(Boolean).join('_');",
    "}",
    "",
  ].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "new-guide.md"),
  [
    "# New Guide",
    "",
    "This changed guide intentionally lacks frontmatter.",
    "It has enough lines to trip the large-doc budget in the fixture.",
    "The point is to keep generated docs and maintained docs separated.",
    "Agents should review exact files before changing documentation.",
    "Budgets are advisory until false positives are measured.",
    "",
  ].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(fixture, "aaa-assets"), { recursive: true });
for (let index = 0; index < 5; index += 1) {
  await fs.writeFile(path.join(fixture, "aaa-assets", `${String(index).padStart(3, "0")}.txt`), "low-signal asset\n", "utf8");
}
await fs.mkdir(path.join(fixture, "dist"), { recursive: true });
await fs.writeFile(
  path.join(fixture, "dist", "generated.ts"),
  Array.from({ length: 12 }, (_, index) => `export const generated${index} = ${index};`).join("\n") + "\n",
  "utf8",
);
await fs.mkdir(path.join(fixture, ".cache"), { recursive: true });
await fs.writeFile(
  path.join(fixture, ".cache", "tool-output.ts"),
  Array.from({ length: 8 }, (_, index) => `export const cached${index} = ${index};`).join("\n") + "\n",
  "utf8",
);
await fs.mkdir(path.join(fixture, ".claude", "worktrees", "generated-branch", "src"), { recursive: true });
await fs.writeFile(
  path.join(fixture, ".claude", "worktrees", "generated-branch", "src", "noisy.ts"),
  Array.from({ length: 10 }, (_, index) => `export const noisyWorktreeValue${index} = ${index};`).join("\n") + "\n",
  "utf8",
);
await fs.mkdir(path.join(fixture, "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill", "src"), {
  recursive: true,
});
await fs.writeFile(
  path.join(fixture, "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill", "src", "vendor.ts"),
  Array.from({ length: 7 }, (_, index) => `export const importedVendorValue${index} = ${index};`).join("\n") + "\n",
  "utf8",
);

const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

const code = await checkNewCodeBudget(config, common);
const codeWithGenerated = await checkNewCodeBudget(config, { ...common, include_generated: true });
const codeWithImported = await checkNewCodeBudget(config, { ...common, include_imported_templates: true });
const docs = await checkNewDocsBudget(config, common);
const context = await checkContextBudget(config, common);
const current = await createQualitySnapshot(config, common);
const currentWithImported = await createQualitySnapshot(config, { ...common, include_imported_templates: true });
const truncatedSnapshot = await createQualitySnapshot(config, { ...common, max_files: 2 });
const truncatedContext = await checkContextBudget(config, {
  ...common,
  max_context_pressure_score: 999_999,
  max_files: 2,
  max_large_docs: 999,
});
const compare = await compareQualitySnapshot(config, { ...common, baseline: baseline.snapshot });
const plan = await proposeQualityGatePlan(config, common);
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const defaultCombined = JSON.stringify({ code, codeWithGenerated, docs, context, current, compare, plan, measurement });
const combined = JSON.stringify({
  code,
  codeWithGenerated,
  codeWithImported,
  docs,
  context,
  current,
  currentWithImported,
  truncatedContext,
  truncatedSnapshot,
  compare,
  plan,
  measurement,
});

assert("code-over-budget", code.budget_status === "warn" && code.added_code_lines > common.max_added_code_lines, code);
assert(
  "root-generated-excluded-by-default",
  !code.files.some((file) => String(file.file_path || "").startsWith("dist/") || String(file.file_path || "").startsWith(".cache/")) &&
    codeWithGenerated.added_code_lines > code.added_code_lines,
  { code, codeWithGenerated },
);
assert(
  "root-generated-included-when-requested",
  codeWithGenerated.files.some((file) => String(file.file_path || "").startsWith("dist/") && file.generated_like === true),
  codeWithGenerated,
);
assert(
  "root-cache-excluded-by-default",
  codeWithGenerated.files.some((file) => String(file.file_path || "").startsWith(".cache/") && file.generated_like === true),
  codeWithGenerated,
);
assert(
  "generated-worktree-changes-skipped",
  !codeWithGenerated.files.some((file) => String(file.file_path || "").startsWith(".claude/worktrees/")),
  codeWithGenerated,
);
assert("imported-template-changes-skipped-by-default", !defaultCombined.includes("templates/hwai_internal_seed/skills/imported/"), {});
assert(
  "imported-template-changes-can-be-included-explicitly",
  codeWithImported.files.some((file) =>
    String(file.file_path || "").startsWith("templates/hwai_internal_seed/skills/imported/vendor-skill/src/vendor.ts"),
  ),
  codeWithImported,
);
assert("docs-over-budget", docs.budget_status === "warn" && docs.added_doc_lines > common.max_added_doc_lines, docs);
assert("frontmatter-gap", docs.frontmatter_missing_count >= 1, docs);
assert("context-over-budget", context.budget_status === "warn", context);
assert("snapshot-created", current.snapshot.scanned_files >= baseline.snapshot.scanned_files, current);
assert(
  "imported-template-snapshot-can-be-included-explicitly",
  currentWithImported.snapshot.scanned_files > current.snapshot.scanned_files,
  { current, currentWithImported },
);
assert(
  "snapshot-truncation-visible",
  truncatedSnapshot.snapshot.scan_truncated === true &&
    truncatedSnapshot.snapshot.scanned_files === 2 &&
    truncatedSnapshot.snapshot.candidate_files_seen > truncatedSnapshot.snapshot.scanned_files &&
    truncatedSnapshot.snapshot.max_files === 2,
  truncatedSnapshot,
);
assert(
  "truncated-snapshot-prioritizes-maintained-files",
  truncatedSnapshot.snapshot.other_files === 0 &&
    truncatedSnapshot.snapshot.generated_like_files === 0 &&
    truncatedSnapshot.snapshot.code_files + truncatedSnapshot.snapshot.doc_files === truncatedSnapshot.snapshot.scanned_files,
  truncatedSnapshot,
);
assert(
  "truncated-context-budget-warns",
  truncatedContext.budget_status === "warn" &&
    truncatedContext.findings.some((finding) => finding.metric === "scan_truncated"),
  truncatedContext,
);
assert("snapshot-growth", compare.growth_findings_count >= 1, compare);
assert("plan-items", plan.plan_items_count >= 3, plan);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("no-raw-code-leak", !combined.includes("input.trim().toLowerCase") && !combined.includes(tempDir), {});

const result = {
  benchmark: "repo-quality-gate-local-golden",
  cases: 19,
  failures,
  rows: [
    { name: "added-code-lines", value: code.added_code_lines },
    { name: "added-code-lines-with-generated", value: codeWithGenerated.added_code_lines },
    { name: "added-code-lines-with-imported", value: codeWithImported.added_code_lines },
    { name: "added-doc-lines", value: docs.added_doc_lines },
    { name: "frontmatter-missing", value: docs.frontmatter_missing_count },
    { name: "context-pressure", value: context.context_pressure_score },
    { name: "candidate-files-seen", value: truncatedSnapshot.snapshot.candidate_files_seen },
    { name: "scan-truncated", value: truncatedSnapshot.snapshot.scan_truncated ? 1 : 0 },
    { name: "growth-findings", value: compare.growth_findings_count },
    { name: "plan-items", value: plan.plan_items_count },
    { name: "measurement-calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
