#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docs-sync-mcp-benchmark-"));
process.env.DOCS_SYNC_CACHE_DIR = path.join(tempDir, "cache");
const fixture = path.join(tempDir, "fixture");
await fs.mkdir(path.join(fixture, "notes"), { recursive: true });

const freshDoc = "# Fresh Doc\n\nNo action here.\n";
const staleDoc = "# Stale Doc\n\n- [ ] Sync this mirror\n";
const missingMirrorDoc = "# Missing Mirror Doc\n\nTODO: create mirror\n";
await fs.writeFile(path.join(fixture, "notes", "fresh.md"), freshDoc, "utf8");
await fs.writeFile(path.join(fixture, "notes", "stale.md"), staleDoc, "utf8");
await fs.writeFile(path.join(fixture, "notes", "missing.md"), missingMirrorDoc, "utf8");
await fs.writeFile(path.join(fixture, "DOC_REGISTRY.md"), "- `notes/fresh.md`\n- `notes/orphan.md`\n", "utf8");
await fs.writeFile(
  path.join(fixture, "mirror.json"),
  JSON.stringify(
    {
      pages: [
        { source_path: "notes/fresh.md", title: "Old Fresh Mirror Title", source_hash: hash(freshDoc), notion_page_id: "fresh-page", notion_url: "https://notion.local/fresh", last_synced_at: "2026-04-01T00:00:00.000Z" },
        { source_path: "notes/stale.md", source_hash: hash("old body"), notion_page_id: "stale-page", notion_url: "https://notion.local/stale", last_synced_at: "2026-04-01T00:00:00.000Z" },
        { source_path: "notes/deleted.md", source_hash: hash("deleted body"), notion_page_id: "deleted-page", notion_url: "https://notion.local/deleted", last_synced_at: "2026-04-01T00:00:00.000Z" },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

const { getDocsSyncConfig } = await import("../dist/config.js");
const {
  checkDocRegistry,
  compareRepoNotionMirror,
  extractRepoActions,
  findStaleNotionMirrors,
  proposeNotionUpdate,
} = await import("../dist/docs-sync.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getDocsSyncConfig();
const args = { repo_root: fixture, doc_roots: ["notes"], mirror_manifest_path: "mirror.json", max_findings: 20, metadata: { source: "benchmark-local" } };
const compare = await compareRepoNotionMirror(config, args);
const stale = await findStaleNotionMirrors(config, args);
const actions = await extractRepoActions(config, args);
const plan = await proposeNotionUpdate(config, args);
const registry = await checkDocRegistry(config, { ...args, doc_registry_path: "DOC_REGISTRY.md" });
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combined = JSON.stringify({ compare, stale, actions, plan, registry, measurement });

const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

assert("compare-stale", compare.stale_mirrors_count === 1, compare);
assert("compare-missing-mirror", compare.missing_mirror_count === 1, compare);
assert("compare-missing-source", compare.missing_source_count === 1, compare);
assert("compare-title-mismatch", compare.title_mismatch_count === 1 && compare.synced_mirror_count === 0, compare);
assert("stale-tool", stale.stale_mirrors_count === 1, stale);
assert("actions", actions.action_items_count === 2 && actions.action_docs_count === 2, actions);
assert("update-plan", plan.update_candidates_count === 4 && plan.title_mismatch_count === 1 && plan.action_items_count === 2, plan);
assert("registry", registry.missing_registry_entries_count === 2 && registry.stale_registry_entries_count === 1, registry);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("no-raw-path-or-url-leak", !combined.includes(tempDir) && !combined.includes("https://notion.local"), {});

const result = {
  benchmark: "docs-sync-local-golden",
  cases: 10,
  failures,
  rows: [
    { name: "stale-mirrors", value: compare.stale_mirrors_count },
    { name: "missing-mirrors", value: compare.missing_mirror_count },
    { name: "missing-sources", value: compare.missing_source_count },
    { name: "title-mismatches", value: compare.title_mismatch_count },
    { name: "actions", value: actions.action_items_count },
    { name: "update-candidates", value: plan.update_candidates_count },
    { name: "registry-missing", value: registry.missing_registry_entries_count },
    { name: "registry-stale", value: registry.stale_registry_entries_count },
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
