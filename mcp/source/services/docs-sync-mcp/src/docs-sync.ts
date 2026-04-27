import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonArtifact } from "./artifact-store.js";
import { DOCS_SYNC_PIPELINE_VERSION, DOCS_SYNC_SCHEMA_VERSION, DocsSyncConfig } from "./config.js";
import { estimateTokens, round, stableHash } from "./text-utils.js";

export interface DocsSyncArgs {
  doc_registry_path?: string;
  doc_roots?: string[];
  max_doc_bytes?: number;
  max_docs?: number;
  max_findings?: number;
  metadata?: unknown;
  mirror_manifest?: unknown;
  mirror_manifest_path?: string;
  repo_root?: string;
  source_paths?: string[];
}

interface DocFact {
  action_markers_count: number;
  doc_hash: string;
  headings_count: number;
  line_count: number;
  source_path: string;
  title: string;
}

interface MirrorRow {
  last_synced_at?: string;
  notion_page_id_hash?: string;
  notion_url_hash?: string;
  source_hash?: string;
  source_path: string;
  title?: string;
}

const SKIP_DIRS = new Set([".git", ".next", ".turbo", ".venv", "coverage", "dist", "node_modules", "vendor"]);
const ACTION_MARKER_RE = /\b(TODO|FIXME)\b|-\s+\[\s]|^\s*(?:[-*]\s*)?Action\s*:/i;

function repoRoot(args: DocsSyncArgs): string {
  return path.resolve(args.repo_root || process.cwd());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maxDocs(config: DocsSyncConfig, args: DocsSyncArgs): number {
  return positiveNumber(args.max_docs, config.maxDocs);
}

function maxDocBytes(config: DocsSyncConfig, args: DocsSyncArgs): number {
  return positiveNumber(args.max_doc_bytes, config.maxDocBytes);
}

function maxFindings(config: DocsSyncConfig, args: DocsSyncArgs): number {
  return positiveNumber(args.max_findings, config.maxFindings);
}

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: DOCS_SYNC_SCHEMA_VERSION,
    pipeline_version: DOCS_SYNC_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local docs sync evidence only. Request logs store counts/hashes, not raw doc bodies, Notion content, URLs, or local paths.",
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
  config: DocsSyncConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

function safeRel(root: string, value: string): string {
  const abs = path.resolve(root, value);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${value}`);
  }
  return toPosix(rel);
}

async function readText(root: string, relPath: string, maxBytes: number): Promise<{ text: string; relPath: string }> {
  const safe = safeRel(root, relPath);
  const abs = path.join(root, safe);
  const stat = await fs.stat(abs);
  if (stat.size > maxBytes) {
    throw new Error(`doc exceeds max_doc_bytes: ${safe}`);
  }
  return { text: await fs.readFile(abs, "utf8"), relPath: safe };
}

async function collectDocs(config: DocsSyncConfig, args: DocsSyncArgs): Promise<Array<{ absPath: string; relPath: string; size: number }>> {
  const root = repoRoot(args);
  const limit = maxDocs(config, args);
  const byteLimit = maxDocBytes(config, args);
  const explicit = Array.isArray(args.source_paths) && args.source_paths.length > 0
    ? new Set(args.source_paths.map((item) => safeRel(root, item)))
    : null;
  const roots = explicit
    ? ["."]
    : (args.doc_roots && args.doc_roots.length > 0 ? args.doc_roots : ["notes", "claude", ".claude", ".cursor", ".windsurf", "services"])
        .map((item) => safeRel(root, item));
  const rows: Array<{ absPath: string; relPath: string; size: number }> = [];
  async function walk(relDir: string): Promise<void> {
    if (rows.length >= limit) {
      return;
    }
    const absDir = path.join(root, relDir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= limit) {
        return;
      }
      const relPath = toPosix(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(relPath);
        }
        continue;
      }
      if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) {
        continue;
      }
      if (explicit && !explicit.has(relPath.replace(/^\.\//, ""))) {
        continue;
      }
      const absPath = path.join(root, relPath);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat || stat.size > byteLimit) {
        continue;
      }
      rows.push({ absPath, relPath: relPath.replace(/^\.\//, ""), size: stat.size });
    }
  }
  for (const relRoot of roots) {
    await walk(relRoot);
  }
  return rows;
}

function docFact(text: string, relPath: string): DocFact {
  const lines = text.split(/\r?\n/);
  const titleLine = lines.find((line) => /^#\s+/.test(line));
  return {
    action_markers_count: lines.filter((line) => ACTION_MARKER_RE.test(line)).length,
    doc_hash: stableHash(text),
    headings_count: lines.filter((line) => /^#{1,6}\s+/.test(line)).length,
    line_count: lines.length,
    source_path: relPath,
    title: titleLine ? titleLine.replace(/^#\s+/, "").trim().slice(0, 120) : path.basename(relPath),
  };
}

async function loadDocFacts(config: DocsSyncConfig, args: DocsSyncArgs): Promise<{ docs: DocFact[]; rawChars: number }> {
  const root = repoRoot(args);
  const files = await collectDocs(config, args);
  const docs: DocFact[] = [];
  let rawChars = 0;
  for (const file of files) {
    const text = await fs.readFile(file.absPath, "utf8").catch(() => "");
    rawChars += text.length;
    docs.push(docFact(text, file.relPath));
  }
  docs.sort((a, b) => a.source_path.localeCompare(b.source_path));
  return { docs, rawChars };
}

async function loadManifest(config: DocsSyncConfig, args: DocsSyncArgs): Promise<{ rows: MirrorRow[]; rawChars: number }> {
  const root = repoRoot(args);
  let manifest = args.mirror_manifest;
  let raw = "";
  if (!manifest && args.mirror_manifest_path) {
    const text = await readText(root, args.mirror_manifest_path, config.maxDocBytes);
    raw = text.text;
    manifest = JSON.parse(text.text);
  }
  const source = (manifest as any)?.pages || manifest || [];
  const rows: MirrorRow[] = [];
  for (const row of Array.isArray(source) ? source : []) {
    if (!row || typeof row !== "object" || typeof row.source_path !== "string") {
      continue;
    }
    rows.push({
      last_synced_at: typeof row.last_synced_at === "string" ? row.last_synced_at : undefined,
      notion_page_id_hash: typeof row.notion_page_id === "string" ? stableHash(row.notion_page_id) : undefined,
      notion_url_hash: typeof row.notion_url === "string" ? stableHash(row.notion_url) : undefined,
      source_hash: typeof row.source_hash === "string" ? row.source_hash : undefined,
      source_path: safeRel(root, row.source_path),
      title: typeof row.title === "string" ? row.title.slice(0, 120) : undefined,
    });
  }
  rows.sort((a, b) => a.source_path.localeCompare(b.source_path));
  return { rows, rawChars: raw.length || JSON.stringify(manifest || {}).length };
}

function staleRows(docs: DocFact[], mirrors: MirrorRow[]) {
  const docMap = new Map(docs.map((doc) => [doc.source_path, doc]));
  const mirrorMap = new Map(mirrors.map((row) => [row.source_path, row]));
  const missingMirror = docs.filter((doc) => !mirrorMap.has(doc.source_path));
  const missingSource = mirrors.filter((row) => !docMap.has(row.source_path));
  const titleMismatch = mirrors
    .filter((row) => {
      const doc = docMap.get(row.source_path);
      return doc && row.title && row.title.trim() !== doc.title.trim();
    })
    .map((row) => {
      const doc = docMap.get(row.source_path);
      return {
        source_path: row.source_path,
        repo_title: doc?.title,
        mirror_title_hash: row.title ? stableHash(row.title) : undefined,
        notion_page_id_hash: row.notion_page_id_hash,
        last_synced_at: row.last_synced_at,
      };
    });
  const stale = mirrors
    .filter((row) => {
      const doc = docMap.get(row.source_path);
      return doc && row.source_hash && row.source_hash !== doc.doc_hash;
    })
    .map((row) => ({
      source_path: row.source_path,
      current_hash: docMap.get(row.source_path)?.doc_hash,
      mirror_hash: row.source_hash,
      notion_page_id_hash: row.notion_page_id_hash,
      last_synced_at: row.last_synced_at,
    }));
  return { missingMirror, missingSource, stale, titleMismatch };
}

export async function compareRepoNotionMirror(config: DocsSyncConfig, args: DocsSyncArgs = {}) {
  const root = repoRoot(args);
  const { docs, rawChars: docsRaw } = await loadDocFacts(config, args);
  const { rows: mirrors, rawChars: manifestRaw } = await loadManifest(config, args);
  const findings = staleRows(docs, mirrors);
  const unsyncedMirrorPaths = new Set([
    ...findings.stale.map((row) => row.source_path),
    ...findings.missingSource.map((row) => row.source_path),
    ...findings.titleMismatch.map((row) => row.source_path),
  ]);
  const result = attachStats(
    {
      ...baseResult("repo_notion_mirror_compare", root),
      doc_count: docs.length,
      mirror_count: mirrors.length,
      stale_mirrors_count: findings.stale.length,
      missing_mirror_count: findings.missingMirror.length,
      missing_source_count: findings.missingSource.length,
      title_mismatch_count: findings.titleMismatch.length,
      synced_mirror_count: mirrors.filter((row) => !unsyncedMirrorPaths.has(row.source_path)).length,
      stale_mirrors: findings.stale.slice(0, maxFindings(config, args)),
      title_mismatches: findings.titleMismatch.slice(0, maxFindings(config, args)),
      missing_mirrors: findings.missingMirror.slice(0, maxFindings(config, args)).map((doc) => ({
        source_path: doc.source_path,
        doc_hash: doc.doc_hash,
        title: doc.title,
      })),
      missing_sources: findings.missingSource.slice(0, maxFindings(config, args)),
      truncated:
        findings.stale.length + findings.missingMirror.length + findings.missingSource.length + findings.titleMismatch.length > maxFindings(config, args) * 4,
    },
    docsRaw + manifestRaw,
  );
  return withArtifact(config, "repo-notion-mirror-compare", result);
}

export async function findStaleNotionMirrors(config: DocsSyncConfig, args: DocsSyncArgs = {}) {
  const root = repoRoot(args);
  const compare = await compareRepoNotionMirror(config, args);
  const staleCount = Number(compare.stale_mirrors_count || 0);
  const result = attachStats(
    {
      ...baseResult("stale_notion_mirrors", root),
      stale_mirrors_count: staleCount,
      stale_mirrors: compare.stale_mirrors,
      missing_mirror_count: compare.missing_mirror_count,
      missing_source_count: compare.missing_source_count,
      title_mismatch_count: compare.title_mismatch_count,
      title_mismatches: compare.title_mismatches,
      source_artifact: compare.artifact_file,
    },
    Number(compare.raw_tokens_estimate || 0) * 4,
  );
  return withArtifact(config, "stale-notion-mirrors", result);
}

export async function extractRepoActions(config: DocsSyncConfig, args: DocsSyncArgs = {}) {
  const root = repoRoot(args);
  const files = await collectDocs(config, args);
  const actions: Array<Record<string, unknown>> = [];
  let rawChars = 0;
  for (const file of files) {
    const text = await fs.readFile(file.absPath, "utf8").catch(() => "");
    rawChars += text.length;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || "";
      if (!ACTION_MARKER_RE.test(line)) {
        continue;
      }
      actions.push({
        source_path: file.relPath,
        line: index + 1,
        action_hash: stableHash(line.trim()),
        action_kind: /-\s+\[\s]/.test(line) ? "checkbox" : (/FIXME/i.test(line) ? "fixme" : (/TODO/i.test(line) ? "todo" : "action")),
      });
    }
  }
  const result = attachStats(
    {
      ...baseResult("repo_actions", root),
      scanned_docs_count: files.length,
      action_items_count: actions.length,
      action_docs_count: new Set(actions.map((item) => item.source_path)).size,
      actions: actions.slice(0, maxFindings(config, args)),
      truncated: actions.length > maxFindings(config, args),
    },
    rawChars,
  );
  return withArtifact(config, "repo-actions", result);
}

export async function proposeNotionUpdate(config: DocsSyncConfig, args: DocsSyncArgs = {}) {
  const root = repoRoot(args);
  const compare = await compareRepoNotionMirror(config, args);
  const actions = await extractRepoActions(config, args);
  const updateItems: Array<Record<string, unknown>> = [];
  for (const item of (compare.stale_mirrors || []) as unknown as Array<Record<string, unknown>>) {
    updateItems.push({ update_type: "refresh_stale_mirror", source_path: item.source_path, proof: ["read repo doc", "update Notion mirror", "record source_hash"] });
  }
  for (const item of (compare.missing_mirrors || []) as unknown as Array<Record<string, unknown>>) {
    updateItems.push({ update_type: "create_missing_mirror", source_path: item.source_path, proof: ["read repo doc", "create Notion mirror", "record source_hash"] });
  }
  for (const item of (compare.missing_sources || []) as unknown as Array<Record<string, unknown>>) {
    updateItems.push({ update_type: "review_or_archive_orphan_mirror", source_path: item.source_path, proof: ["confirm repo source removal", "archive or relink Notion mirror"] });
  }
  const alreadyPlannedSources = new Set(updateItems.map((item) => item.source_path));
  for (const item of (compare.title_mismatches || []) as unknown as Array<Record<string, unknown>>) {
    if (typeof item.source_path === "string" && alreadyPlannedSources.has(item.source_path)) {
      continue;
    }
    updateItems.push({ update_type: "review_title_mismatch", source_path: item.source_path, proof: ["read repo doc title", "update Notion mirror title", "record current source_hash"] });
  }
  const result = attachStats(
    {
      ...baseResult("notion_update_plan", root),
      update_candidates_count: updateItems.length,
      stale_mirrors_count: compare.stale_mirrors_count,
      missing_mirror_count: compare.missing_mirror_count,
      missing_source_count: compare.missing_source_count,
      title_mismatch_count: compare.title_mismatch_count,
      action_items_count: actions.action_items_count,
      update_candidates: updateItems.slice(0, maxFindings(config, args)),
      source_artifacts: {
        compare: compare.artifact_file,
        actions: actions.artifact_file,
      },
      policy: {
        advisory_only: true,
        repo_markdown_is_ssot: true,
        no_notion_write_in_v0_1: true,
      },
      truncated: updateItems.length > maxFindings(config, args),
    },
    Number(compare.raw_tokens_estimate || 0) * 4 + Number(actions.raw_tokens_estimate || 0) * 4,
  );
  return withArtifact(config, "notion-update-plan", result);
}

function registryPathsFromMarkdown(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/`([^`]+\.(?:md|mdx))`/g)) {
    if (match[1]) {
      paths.add(match[1]);
    }
  }
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9_.\/-]+\.(?:md|mdx))(?:\s|$)/gm)) {
    if (match[1]) {
      paths.add(match[1]);
    }
  }
  return Array.from(paths).sort();
}

export async function checkDocRegistry(config: DocsSyncConfig, args: DocsSyncArgs = {}) {
  const root = repoRoot(args);
  const { docs, rawChars: docsRaw } = await loadDocFacts(config, args);
  let registryPaths: string[] = [];
  let registryRaw = 0;
  if (args.doc_registry_path) {
    const registry = await readText(root, args.doc_registry_path, config.maxDocBytes);
    registryRaw = registry.text.length;
    try {
      const parsed = JSON.parse(registry.text);
      const source = Array.isArray(parsed) ? parsed : parsed.docs;
      registryPaths = (Array.isArray(source) ? source : [])
        .map((item) => (typeof item === "string" ? item : item?.source_path))
        .filter((item): item is string => typeof item === "string")
        .map((item) => safeRel(root, item));
    } catch {
      registryPaths = registryPathsFromMarkdown(registry.text).map((item) => safeRel(root, item));
    }
  }
  const docPaths = new Set(docs.map((doc) => doc.source_path));
  const registrySet = new Set(registryPaths);
  const missingRegistry = docs.filter((doc) => registrySet.size > 0 && !registrySet.has(doc.source_path));
  const staleRegistry = registryPaths.filter((item) => !docPaths.has(item));
  const result = attachStats(
    {
      ...baseResult("doc_registry_check", root),
      doc_count: docs.length,
      registry_entries_count: registryPaths.length,
      missing_registry_entries_count: missingRegistry.length,
      stale_registry_entries_count: staleRegistry.length,
      missing_registry_entries: missingRegistry.slice(0, maxFindings(config, args)).map((doc) => ({
        source_path: doc.source_path,
        doc_hash: doc.doc_hash,
        title: doc.title,
      })),
      stale_registry_entries: staleRegistry.slice(0, maxFindings(config, args)),
      truncated: missingRegistry.length + staleRegistry.length > maxFindings(config, args) * 2,
    },
    docsRaw + registryRaw,
  );
  return withArtifact(config, "doc-registry-check", result);
}
