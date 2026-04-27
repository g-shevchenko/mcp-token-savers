#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docs-hygiene-mcp-benchmark-"));
process.env.DOCS_HYGIENE_CACHE_DIR = path.join(tempDir, "cache");
const fixture = path.join(tempDir, "fixture");
await fs.mkdir(path.join(fixture, "docs"), { recursive: true });

const duplicateBody = [
  "Repeated operational guidance should live in one canonical home and every mirror should point back to it.",
  "Agents need a short owner signal, a current source path, and a reviewed replacement before cleanup work starts.",
  "The same checklist appearing in two pages should become a link, not a second independently maintained procedure.",
  "Archive decisions stay advisory until backlinks and external references are checked by a human-visible proof loop.",
].join("\n");

await fs.writeFile(
  path.join(fixture, "README.md"),
  [
    "# Fixture Readme",
    "",
    "See [good](docs/good.md), [good line](docs/good.md:7), [directory](docs/), [missing](docs/missing.md), [bad anchor](docs/good.md#missing-anchor), and [duplicate A](docs/duplicate-a.md).",
    "Site absolute links like [runtime path](/Users/user/missing.md) are not repo-relative Markdown links.",
    "Reference style links: [missing ref][missing-ref] and [bad anchor ref][bad-anchor-ref].",
    "",
    "[missing-ref]: docs/reference-missing.md",
    "[bad-anchor-ref]: <docs/good.md#reference-missing-anchor> \"Reference title\"",
    "",
    "Implementation moved away from `src/missing.ts` but this stale reference stayed behind.",
    "Placeholder links like [dash](-), [url](URL), [ellipsis](us06tasks.zoom.us/...), and [regex](.*?) should not be treated as repo-relative files.",
    "Temporary evidence used `/tmp/generated.ts` and should not be treated as a repo stale reference.",
    "Command evidence used `node --check scripts/missing-command.js` and should not be treated as a repo stale reference.",
    "URL evidence used `https://example.test/rates.json` and should not be treated as a repo stale reference.",
    "A bare filename `missing-alone.ts` is not enough evidence for a stale repo path.",
    "A glob reference `.claude/agents/*.md` is policy shorthand, not a concrete stale repo path.",
    "Template evidence `.agent/tasks/<TASK_ID>/spec.md` should not be treated as a concrete stale repo reference.",
    "Home-path evidence `~/.claude/skills/example/SKILL.md` should not be treated as a repo stale reference.",
    "Cursor-style file mention `@claude/CREDENTIALS.md` should resolve to the workspace file.",
    "Root hidden policy path `.claude/rules/keep.md` should resolve from repo root.",
    "NPM scope package evidence `@types/tesseract.js` is not a local repo path.",
    "Placeholder ellipsis evidence `notes/….md` should not be treated as a concrete stale repo path.",
    "",
    "Notion is the canonical source of truth for this workflow.",
    "",
  ].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(fixture, "claude"), { recursive: true });
await fs.writeFile(path.join(fixture, "claude", "CREDENTIALS.md"), ["# Local Credentials Placeholder", ""].join("\n"), "utf8");
await fs.mkdir(path.join(fixture, "projects", "local-app", "content"), { recursive: true });
await fs.writeFile(path.join(fixture, "projects", "local-app", "content", "page.md"), ["# Project Content", ""].join("\n"), "utf8");
await fs.mkdir(path.join(fixture, "projects", "local-app", "content", "live-snapshot"), { recursive: true });
await fs.writeFile(
  path.join(fixture, "projects", "local-app", "content", "live-snapshot", "generated.md"),
  ["---", "h1: \"Generated page text can contain noisy paths like notes/missing-from-generated.md\"", "---", "", "# Snapshot", ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "projects", "local-app", "PLAN.md"),
  ["# Project Plan", "", "Project-local content lives at `content/page.md` and should not be resolved from repo root only.", ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "good.md"),
  ["---", "owner: docs", "---", "", "# Good Doc", "", "## Stable Anchor", "", "A small linked doc.", ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "orphan.md"),
  ["# Orphan Doc", "", "This page has no inbound Markdown link in the scanned fixture.", ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "duplicate-a.md"),
  ["# Duplicate A", "", "## Shared Procedure", "", duplicateBody, ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "duplicate-b.md"),
  ["# Duplicate B", "", "## Shared Procedure", "", duplicateBody, ""].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(fixture, "docs", "frontmatter-gap.md"),
  ["# Frontmatter Gap", "", "This page intentionally lacks YAML frontmatter.", ""].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(fixture, ".claude", "rules"), { recursive: true });
await fs.writeFile(
  path.join(fixture, ".claude", "rules", "keep.md"),
  ["# Keep Local Claude Rule", "", "Root .claude docs are maintained repo policy and must remain scannable.", ""].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(fixture, ".claude", "worktrees", "generated-branch"), { recursive: true });
await fs.writeFile(
  path.join(fixture, ".claude", "worktrees", "generated-branch", "README.md"),
  ["# Generated Worktree Copy", "", "This cloned branch doc should not inflate root repo hygiene scans.", ""].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(fixture, "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill"), { recursive: true });
await fs.writeFile(
  path.join(fixture, "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill", "README.md"),
  ["# Imported Vendor Skill", "", "This imported template has a [vendor-local missing link](./missing-vendor-doc.md).", ""].join("\n"),
  "utf8",
);

const { getDocsHygieneConfig } = await import("../dist/config.js");
const {
  checkDocFrontmatter,
  checkSsotConflicts,
  findBrokenAnchors,
  findBrokenLinks,
  findDuplicateSections,
  findOrphanDocs,
  findStaleCodeReferences,
  inventoryDocs,
  proposeDocMergeOrArchive,
} = await import("../dist/docs.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getDocsHygieneConfig();
const args = {
  repo_root: fixture,
  max_files: 50,
  max_findings: 20,
  min_section_lines: 4,
  metadata: { source: "benchmark-local" },
};
const importedArgs = { ...args, include_imported_templates: true };
const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

const inventory = await inventoryDocs(config, args);
const brokenLinks = await findBrokenLinks(config, args);
const brokenAnchors = await findBrokenAnchors(config, args);
const orphans = await findOrphanDocs(config, args);
const duplicates = await findDuplicateSections(config, args);
const staleRefs = await findStaleCodeReferences(config, args);
const importedBrokenLinks = await findBrokenLinks(config, importedArgs);
const frontmatter = await checkDocFrontmatter(config, args);
const ssot = await checkSsotConflicts(config, args);
const plan = await proposeDocMergeOrArchive(config, args);
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combined = JSON.stringify({
  inventory,
  brokenLinks,
  brokenAnchors,
  orphans,
  duplicates,
  staleRefs,
  frontmatter,
  ssot,
  plan,
  measurement,
});

assert("inventory-doc-count", inventory.doc_count >= 6, inventory);
assert(".claude-policy-doc-kept", inventory.docs.some((item) => item.file_path === ".claude/rules/keep.md"), inventory.docs);
assert("generated-worktree-doc-skipped", !combined.includes(".claude/worktrees/"), {});
assert("imported-template-doc-skipped-by-default", !combined.includes("templates/hwai_internal_seed/skills/imported/"), {});
assert(
  "imported-template-doc-can-be-included-explicitly",
  importedBrokenLinks.findings.some((item) => item.source_path === "templates/hwai_internal_seed/skills/imported/vendor-skill/README.md"),
  importedBrokenLinks,
);
assert("broken-link-found", brokenLinks.broken_links_count >= 1, brokenLinks);
assert(
  "line-suffix-and-absolute-markdown-link-ignored",
  !brokenLinks.findings.some((item) => ["docs/good.md:7", "/Users/user/missing.md"].includes(String(item.target_path))),
  brokenLinks,
);
assert(
  "placeholder-markdown-links-ignored",
  !brokenLinks.findings.some((item) => ["-", "URL", "us06tasks.zoom.us/...", ".*?"].includes(String(item.target_path))),
  brokenLinks,
);
assert("existing-directory-link-resolves", !brokenLinks.findings.some((item) => item.target_path === "docs/"), brokenLinks);
assert("broken-anchor-found", brokenAnchors.broken_anchors_count >= 1, brokenAnchors);
assert("reference-style-broken-link-found", brokenLinks.findings.some((item) => item.target_path === "docs/reference-missing.md"), brokenLinks);
assert(
  "reference-style-broken-anchor-found",
  brokenAnchors.findings.some((item) => item.target_path === "docs/good.md" && item.line >= 5),
  brokenAnchors,
);
assert("orphan-doc-found", orphans.orphan_docs_count >= 1, orphans);
assert("duplicate-section-found", duplicates.duplicate_section_groups >= 1, duplicates);
assert("stale-code-ref-found", staleRefs.stale_references_count >= 1, staleRefs);
assert("absolute-evidence-path-ignored", !staleRefs.findings.some((item) => item.reference_path === "/tmp/generated.ts"), staleRefs);
assert(
  "command-url-and-bare-filename-ignored",
  !staleRefs.findings.some((item) =>
    [
      "node --check scripts/missing-command.js",
      "https://example.test/rates.json",
      "missing-alone.ts",
      ".claude/agents/*.md",
      ".agent/tasks/<TASK_ID>/spec.md",
      "~/.claude/skills/example/SKILL.md",
      "@claude/CREDENTIALS.md",
      ".claude/rules/keep.md",
      "@types/tesseract.js",
      "notes/….md",
      "content/page.md",
      "notes/missing-from-generated.md",
    ].includes(String(item.reference_path)),
  ),
  staleRefs,
);
assert("frontmatter-gap-found", frontmatter.frontmatter_missing_count >= 1, frontmatter);
assert("ssot-conflict-found", ssot.ssot_conflicts_count >= 1, ssot);
assert("plan-items", plan.plan_items_count >= 5, plan);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("no-raw-doc-body-leak", !combined.includes("Repeated operational guidance") && !combined.includes(tempDir), {});

const result = {
  benchmark: "docs-hygiene-local-golden",
  cases: 24,
  failures,
  rows: [
    { name: "docs", value: inventory.doc_count },
    { name: "broken-links", value: brokenLinks.broken_links_count },
    { name: "broken-anchors", value: brokenAnchors.broken_anchors_count },
    { name: "orphans", value: orphans.orphan_docs_count },
    { name: "duplicate-groups", value: duplicates.duplicate_section_groups },
    { name: "stale-references", value: staleRefs.stale_references_count },
    { name: "frontmatter-missing", value: frontmatter.frontmatter_missing_count },
    { name: "ssot-conflicts", value: ssot.ssot_conflicts_count },
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
