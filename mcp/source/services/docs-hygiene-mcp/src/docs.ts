import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonArtifact } from "./artifact-store.js";
import {
  DOCS_HYGIENE_PIPELINE_VERSION,
  DOCS_HYGIENE_SCHEMA_VERSION,
  DocsHygieneConfig,
} from "./config.js";
import { estimateTokens, githubSlug, round, stableHash } from "./text-utils.js";

export interface DocsArgs {
  include_imported_templates?: boolean;
  max_file_bytes?: number;
  max_files?: number;
  max_findings?: number;
  metadata?: unknown;
  min_section_lines?: number;
  repo_root?: string;
}

interface DocFile {
  absPath: string;
  relPath: string;
  size: number;
  text?: string;
}

interface Heading {
  anchor: string;
  line: number;
  level: number;
  title: string;
  title_hash: string;
}

interface LinkRef {
  anchor: string;
  line: number;
  raw_target: string;
  source_path: string;
  target_path: string;
  target_url_hash: string;
}

interface PathLikeRef {
  line: number;
  reference: string;
}

const DOC_EXTENSIONS = new Set([".md", ".mdx"]);
const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".php",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function repoRoot(args: DocsArgs): string {
  return path.resolve(args.repo_root || process.cwd());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isGeneratedWorktreeDir(root: string, absPath: string): boolean {
  const relPath = toPosix(path.relative(root, absPath));
  return relPath === ".claude/worktrees" || relPath.startsWith(".claude/worktrees/");
}

function isImportedTemplateDir(root: string, absPath: string): boolean {
  const relPath = toPosix(path.relative(root, absPath));
  return (
    relPath === "templates/hwai_internal_seed/skills/imported" ||
    relPath.startsWith("templates/hwai_internal_seed/skills/imported/")
  );
}

function isGeneratedContentSnapshotDoc(relPath: string): boolean {
  return relPath.includes("/content/live-snapshot/");
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maxFiles(config: DocsHygieneConfig, args: DocsArgs): number {
  return positiveNumber(args.max_files, config.maxFiles);
}

function maxFileBytes(config: DocsHygieneConfig, args: DocsArgs): number {
  return positiveNumber(args.max_file_bytes, config.maxFileBytes);
}

function maxFindings(config: DocsHygieneConfig, args: DocsArgs): number {
  return positiveNumber(args.max_findings, config.maxFindings);
}

async function collectDocs(config: DocsHygieneConfig, args: DocsArgs): Promise<DocFile[]> {
  const root = repoRoot(args);
  const docs: DocFile[] = [];
  const fileLimit = maxFiles(config, args);
  const byteLimit = maxFileBytes(config, args);

  async function walk(dir: string): Promise<void> {
    if (docs.length >= fileLimit) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (docs.length >= fileLimit) {
        return;
      }
      if (entry.isDirectory()) {
        const absPath = path.join(dir, entry.name);
        if (
          !SKIP_DIRS.has(entry.name) &&
          !isGeneratedWorktreeDir(root, absPath) &&
          (args.include_imported_templates === true || !isImportedTemplateDir(root, absPath))
        ) {
          await walk(absPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const absPath = path.join(dir, entry.name);
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > byteLimit) {
        continue;
      }
      docs.push({
        absPath,
        relPath: toPosix(path.relative(root, absPath)),
        size: stat.size,
      });
    }
  }

  await walk(root);
  return docs;
}

async function readDoc(doc: DocFile): Promise<string> {
  if (doc.text !== undefined) {
    return doc.text;
  }
  doc.text = await fs.readFile(doc.absPath, "utf8");
  return doc.text;
}

async function readAllDocs(docs: DocFile[]): Promise<void> {
  await Promise.all(
    docs.map(async (doc) => {
      try {
        await readDoc(doc);
      } catch {
        doc.text = "";
      }
    }),
  );
}

function lineCount(text: string): number {
  return text.length ? text.split(/\r?\n/).length : 0;
}

function extractHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index] || "");
    if (!match) {
      continue;
    }
    const title = (match[2] || "").trim().slice(0, 160);
    const anchor = githubSlug(title, seen);
    headings.push({
      anchor,
      line: index + 1,
      level: match[1]?.length || 1,
      title,
      title_hash: stableHash(title),
    });
  }
  return headings;
}

function parseMarkdownLinks(doc: DocFile): LinkRef[] {
  const text = doc.text || "";
  const lines = text.split(/\r?\n/);
  const refs: LinkRef[] = [];
  const referenceDefinitions = new Map<string, { line: number; target: string }>();
  const usedReferenceLabels = new Set<string>();
  const linkRe = /!?\[[^\]]*]\(([^)]+)\)/g;
  const referenceUseRe = /!?\[([^\]]+)]\[([^\]]*)]/g;
  const referenceDefinitionRe = /^\s{0,3}\[([^\]]+)]:\s+(.+?)\s*$/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    for (const match of line.matchAll(linkRe)) {
      const target = normalizeLinkTarget(match[1] || "");
      if (!target || isExternalTarget(target)) {
        continue;
      }
      const [targetPathRaw, anchorRaw = ""] = target.split("#");
      if (targetPathRaw && (path.isAbsolute(targetPathRaw) || isNonLocalMarkdownPlaceholder(targetPathRaw))) {
        continue;
      }
      refs.push({
        anchor: anchorRaw ? decodeFragment(anchorRaw) : "",
        line: index + 1,
        raw_target: target,
        source_path: doc.relPath,
        target_path: stripLineSuffix(targetPathRaw),
        target_url_hash: stableHash(target),
      });
    }
    for (const match of line.matchAll(referenceUseRe)) {
      const label = normalizeReferenceLabel(match[2] || match[1] || "");
      if (label) {
        usedReferenceLabels.add(label);
      }
    }
    const definitionMatch = referenceDefinitionRe.exec(line);
    if (definitionMatch) {
      const label = normalizeReferenceLabel(definitionMatch[1] || "");
      const target = normalizeLinkTarget(definitionMatch[2] || "");
      if (label && target && !isExternalTarget(target)) {
        referenceDefinitions.set(label, { line: index + 1, target });
      }
    }
  }
  for (const [label, definition] of referenceDefinitions) {
    if (!usedReferenceLabels.has(label)) {
      continue;
    }
    const [targetPathRaw, anchorRaw = ""] = definition.target.split("#");
    if (targetPathRaw && (path.isAbsolute(targetPathRaw) || isNonLocalMarkdownPlaceholder(targetPathRaw))) {
      continue;
    }
    refs.push({
      anchor: anchorRaw ? decodeFragment(anchorRaw) : "",
      line: definition.line,
      raw_target: definition.target,
      source_path: doc.relPath,
      target_path: stripLineSuffix(targetPathRaw),
      target_url_hash: stableHash(definition.target),
    });
  }
  return refs;
}

function normalizeLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  const withoutTitle = trimmed.split(/\s+(?=["'])/)[0] || trimmed;
  return withoutTitle.trim().replace(/^<|>$/g, "");
}

function normalizeReferenceLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function decodeFragment(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/^#/, "");
  } catch {
    return raw.replace(/^#/, "");
  }
}

function isExternalTarget(target: string): boolean {
  return /^(https?:|mailto:|tel:|ftp:|data:|javascript:)/i.test(target);
}

function isNonLocalMarkdownPlaceholder(targetPath: string): boolean {
  const clean = targetPath.trim();
  if (!clean || clean === "-" || clean === "." || /^url$/i.test(clean)) {
    return true;
  }
  if (clean.includes("...") || clean.includes("[") || clean.includes("]") || clean.includes("(?:") || clean.includes(".*") || clean.includes("|")) {
    return true;
  }
  return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/|$)/.test(clean) && !clean.startsWith("./") && !clean.startsWith("../");
}

function stripLineSuffix(targetPath: string): string {
  return targetPath.replace(/(\.(?:cjs|css|go|js|jsx|json|mjs|php|py|rs|scss|sh|ts|tsx|ya?ml|mdx?)):\d+(?:-\d+)?$/i, "$1");
}

function candidateDocPaths(root: string, sourceRel: string, targetPath: string): string[] {
  const cleanTarget = stripLineSuffix(targetPath.split(/[?#]/)[0] || "");
  const sourceDir = path.dirname(path.join(root, sourceRel));
  const base = cleanTarget
    ? path.resolve(sourceDir, cleanTarget)
    : path.resolve(root, sourceRel);
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(`${base}.md`, `${base}.mdx`, path.join(base, "README.md"), path.join(base, "index.md"));
  }
  return candidates;
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() || stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function hasFrontmatter(text: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text);
}

function normalizeSection(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: DOCS_HYGIENE_SCHEMA_VERSION,
    pipeline_version: DOCS_HYGIENE_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local documentation evidence only. No destructive changes. Request logs store counts/hashes, not document bodies.",
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
  config: DocsHygieneConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

export async function inventoryDocs(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const root = repoRoot(args);
  const docs = await collectDocs(config, args);
  await readAllDocs(docs);
  const rawChars = docs.reduce((sum, doc) => sum + (doc.text || "").length, 0);
  const rows = docs.map((doc) => {
    const text = doc.text || "";
    const headings = extractHeadings(text);
    return {
      file_path: doc.relPath,
      file_hash: stableHash(doc.relPath),
      line_count: lineCount(text),
      heading_count: headings.length,
      has_frontmatter: hasFrontmatter(text),
      large_doc: lineCount(text) >= config.largeDocLines,
    };
  });
  const result = attachStats(
    {
      ...baseResult("inventory", root),
      doc_count: docs.length,
      doc_lines: rows.reduce((sum, row) => sum + row.line_count, 0),
      large_docs_count: rows.filter((row) => row.large_doc).length,
      frontmatter_missing_count: rows.filter((row) => !row.has_frontmatter).length,
      docs: rows.slice(0, maxFindings(config, args)),
      truncated: rows.length > maxFindings(config, args),
    },
    rawChars,
  );
  return withArtifact(config, "inventory", result);
}

async function buildDocIndex(config: DocsHygieneConfig, args: DocsArgs) {
  const root = repoRoot(args);
  const docs = await collectDocs(config, args);
  await readAllDocs(docs);
  const byRel = new Map(docs.map((doc) => [doc.relPath, doc]));
  const headingByRel = new Map(docs.map((doc) => [doc.relPath, extractHeadings(doc.text || "")]));
  const anchorByRel = new Map(
    Array.from(headingByRel.entries()).map(([rel, headings]) => [rel, new Set(headings.map((heading) => heading.anchor))]),
  );
  const rawChars = docs.reduce((sum, doc) => sum + (doc.text || "").length, 0);
  return { root, docs, byRel, headingByRel, anchorByRel, rawChars };
}

export async function findBrokenLinks(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const findings: Array<Record<string, unknown>> = [];
  for (const doc of index.docs) {
    for (const ref of parseMarkdownLinks(doc)) {
      if (!ref.target_path) {
        continue;
      }
      const existing = await firstExistingPath(candidateDocPaths(index.root, ref.source_path, ref.target_path));
      if (!existing) {
        findings.push({
          source_path: ref.source_path,
          line: ref.line,
          target_path: ref.target_path,
          target_hash: ref.target_url_hash,
          reason: "Relative Markdown link target does not resolve to a local file.",
          confidence: 0.9,
        });
      }
    }
  }
  const limited = findings.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("broken_links", index.root),
      doc_count: index.docs.length,
      broken_links_count: findings.length,
      findings: limited,
      truncated: limited.length < findings.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "broken-links", result);
}

export async function findBrokenAnchors(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const findings: Array<Record<string, unknown>> = [];
  for (const doc of index.docs) {
    for (const ref of parseMarkdownLinks(doc)) {
      if (!ref.anchor) {
        continue;
      }
      const existing = await firstExistingPath(candidateDocPaths(index.root, ref.source_path, ref.target_path));
      if (!existing) {
        continue;
      }
      const targetRel = toPosix(path.relative(index.root, existing));
      const anchor = githubSlug(ref.anchor);
      if (!index.anchorByRel.get(targetRel)?.has(anchor)) {
        findings.push({
          source_path: ref.source_path,
          line: ref.line,
          target_path: targetRel,
          anchor_hash: stableHash(ref.anchor),
          reason: "Markdown anchor does not match any heading in the target document.",
          confidence: 0.85,
        });
      }
    }
  }
  const limited = findings.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("broken_anchors", index.root),
      doc_count: index.docs.length,
      broken_anchors_count: findings.length,
      findings: limited,
      truncated: limited.length < findings.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "broken-anchors", result);
}

export async function findOrphanDocs(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const inbound = new Map(index.docs.map((doc) => [doc.relPath, 0]));
  for (const doc of index.docs) {
    for (const ref of parseMarkdownLinks(doc)) {
      if (!ref.target_path) {
        continue;
      }
      const existing = await firstExistingPath(candidateDocPaths(index.root, ref.source_path, ref.target_path));
      if (existing) {
        const targetRel = toPosix(path.relative(index.root, existing));
        inbound.set(targetRel, (inbound.get(targetRel) || 0) + 1);
      }
    }
  }
  const protectedNames = new Set(["README.md", "AGENTS.md", "CLAUDE.md"]);
  const orphans = index.docs
    .filter((doc) => (inbound.get(doc.relPath) || 0) === 0 && !protectedNames.has(path.basename(doc.relPath)))
    .map((doc) => ({
      file_path: doc.relPath,
      file_hash: stableHash(doc.relPath),
      line_count: lineCount(doc.text || ""),
      heading_count: index.headingByRel.get(doc.relPath)?.length || 0,
      confidence: 0.55,
      reason: "No inbound Markdown links found from scanned docs. Review entrypoints, generated snapshots, and external references before archive.",
    }))
    .sort((a, b) => b.line_count - a.line_count || a.file_path.localeCompare(b.file_path));
  const limited = orphans.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("orphan_docs", index.root),
      doc_count: index.docs.length,
      orphan_docs_count: orphans.length,
      orphans: limited,
      truncated: limited.length < orphans.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "orphan-docs", result);
}

interface Section {
  content_hash: string;
  file_path: string;
  heading: string;
  heading_hash: string;
  line_count: number;
  line_start: number;
}

function docSections(doc: DocFile, minLines: number): Section[] {
  const text = doc.text || "";
  const lines = text.split(/\r?\n/);
  const headingRows = lines
    .map((line, index) => ({ line, index }))
    .filter((row) => /^(#{1,6})\s+/.test(row.line));
  const sections: Section[] = [];
  for (let index = 0; index < headingRows.length; index += 1) {
    const start = headingRows[index]?.index ?? 0;
    const end = headingRows[index + 1]?.index ?? lines.length;
    const body = lines.slice(start + 1, end);
    const normalized = normalizeSection(body.join("\n"));
    const lineTotal = body.filter((line) => line.trim()).length;
    if (lineTotal < minLines || normalized.length < 120) {
      continue;
    }
    const heading = (headingRows[index]?.line || "").replace(/^#{1,6}\s+/, "").trim().slice(0, 160);
    sections.push({
      content_hash: stableHash(normalized),
      file_path: doc.relPath,
      heading,
      heading_hash: stableHash(heading),
      line_count: lineTotal,
      line_start: start + 1,
    });
  }
  return sections;
}

export async function findDuplicateSections(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const minLines = positiveNumber(args.min_section_lines, config.duplicateMinSectionLines);
  const groups = new Map<string, Section[]>();
  for (const doc of index.docs) {
    for (const section of docSections(doc, minLines)) {
      const rows = groups.get(section.content_hash) || [];
      rows.push(section);
      groups.set(section.content_hash, rows);
    }
  }
  const duplicates = Array.from(groups.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.file_path)).size > 1)
    .map(([contentHash, rows]) => ({
      content_hash: contentHash,
      occurrences: rows.length,
      sections: rows.slice(0, 8),
      confidence: 0.8,
      reason: "Same normalized section body appears in multiple docs. Review before merge/archive.",
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.content_hash.localeCompare(b.content_hash));
  const limited = duplicates.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("duplicate_sections", index.root),
      doc_count: index.docs.length,
      duplicate_section_groups: duplicates.length,
      duplicates: limited,
      truncated: limited.length < duplicates.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "duplicate-sections", result);
}

const WORKSPACE_ALIAS_ROOTS = new Set([
  ".claude",
  ".cursor",
  ".windsurf",
  "claude",
  "configs",
  "docs",
  "memory",
  "notes",
  "projects",
  "scripts",
  "services",
  "templates",
]);
const ROOT_DOT_DIRS = new Set([".agent", ".claude", ".cursor", ".windsurf"]);

function isWorkspaceAlias(clean: string): boolean {
  if (!clean.startsWith("@")) {
    return false;
  }
  const rootName = clean.slice(1).split("/")[0] || "";
  return WORKSPACE_ALIAS_ROOTS.has(rootName);
}

function normalizeWorkspaceAlias(clean: string): string {
  return isWorkspaceAlias(clean) ? clean.slice(1) : clean;
}

function addPathLikeRef(refs: Map<string, PathLikeRef>, reference: string, line: number) {
  const clean = reference.trim();
  if (!clean || refs.has(clean)) {
    return;
  }
  refs.set(clean, { line, reference: clean });
}

function pathLikeRefs(text: string): PathLikeRef[] {
  const refs = new Map<string, PathLikeRef>();
  const inlineCodeRe = /`([^`\n]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|json|ya?ml|mdx?)(?::\d+)?)`/g;
  const plainRe = /(?:^|[\s(["'])((?:services|scripts|notes|claude|projects|src|app|lib|content|data|analyzers|templates)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|json|ya?ml|mdx?)(?::\d+)?)/g;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    for (const match of line.matchAll(inlineCodeRe)) {
      addPathLikeRef(refs, match[1] || "", index + 1);
    }
    for (const match of line.matchAll(plainRe)) {
      addPathLikeRef(refs, match[1] || "", index + 1);
    }
  }
  return Array.from(refs.values());
}

function isLocalPathReferenceCandidate(clean: string): boolean {
  if (path.isAbsolute(clean) || /^https?:\/\//i.test(clean) || clean.includes("://")) {
    return false;
  }
  if (clean.startsWith("@") && !isWorkspaceAlias(clean)) {
    return false;
  }
  if (clean.startsWith("~") || /<[^>]+>/.test(clean)) {
    return false;
  }
  if (clean.includes("...") || clean.includes("…") || /[*?\[\]{}]/.test(clean)) {
    return false;
  }
  if (/\s/.test(clean)) {
    return false;
  }
  return clean.includes("/") || clean.startsWith("./") || clean.startsWith("../");
}

function sourceLocalRoots(root: string, sourceRel: string): string[] {
  const parts = sourceRel.split("/");
  const roots: string[] = [];
  if (["projects", "services", "experiments"].includes(parts[0] || "") && parts[1]) {
    roots.push(path.join(root, parts[0], parts[1]));
  }
  if (parts[0] === "templates" && parts[1] === "hwai_internal_seed") {
    roots.push(path.join(root, "templates", "hwai_internal_seed"));
  }
  return roots;
}

function candidateReferencePaths(root: string, sourceRel: string, rawRef: string): string[] {
  const clean = normalizeWorkspaceAlias(stripLineSuffix(rawRef).split(/[?#]/)[0] || "");
  if (!clean) {
    return [];
  }
  const sourceDir = path.dirname(path.join(root, sourceRel));
  const rootName = clean.split("/")[0] || "";
  const candidates = (clean.startsWith("./") || clean.startsWith("../")) && !ROOT_DOT_DIRS.has(rootName)
    ? [path.resolve(sourceDir, clean)]
    : [
        path.resolve(root, clean),
        path.resolve(sourceDir, clean),
        ...sourceLocalRoots(root, sourceRel).map((localRoot) => path.resolve(localRoot, clean)),
      ];
  return Array.from(new Set(candidates));
}

export async function findStaleCodeReferences(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const findings: Array<Record<string, unknown>> = [];
  for (const doc of index.docs) {
    if (isGeneratedContentSnapshotDoc(doc.relPath)) {
      continue;
    }
    const refs = pathLikeRefs(doc.text || "");
    for (const ref of refs) {
      const clean = stripLineSuffix(ref.reference);
      if (!isLocalPathReferenceCandidate(clean)) {
        continue;
      }
      if (!CODE_EXTENSIONS.has(path.extname(clean).toLowerCase()) && !DOC_EXTENSIONS.has(path.extname(clean).toLowerCase())) {
        continue;
      }
      const existing = await firstExistingPath(candidateReferencePaths(index.root, doc.relPath, clean));
      if (!existing) {
        findings.push({
          source_path: doc.relPath,
          line: ref.line,
          reference_hash: stableHash(ref.reference),
          reference_path: normalizeWorkspaceAlias(clean),
          confidence: 0.75,
          reason: "Doc references a local code/doc path that does not exist in this worktree.",
        });
      }
    }
  }
  const limited = findings.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("stale_code_references", index.root),
      doc_count: index.docs.length,
      stale_references_count: findings.length,
      findings: limited,
      truncated: limited.length < findings.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "stale-code-references", result);
}

export async function checkDocFrontmatter(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const findings = index.docs
    .filter((doc) => !hasFrontmatter(doc.text || ""))
    .map((doc) => ({
      file_path: doc.relPath,
      file_hash: stableHash(doc.relPath),
      line_count: lineCount(doc.text || ""),
      confidence: 0.6,
      reason: "Document has no YAML frontmatter. This is advisory; some root runbooks intentionally omit it.",
    }));
  const limited = findings.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("doc_frontmatter", index.root),
      doc_count: index.docs.length,
      frontmatter_missing_count: findings.length,
      findings: limited,
      truncated: limited.length < findings.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "doc-frontmatter", result);
}

export async function checkSsotConflicts(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const index = await buildDocIndex(config, args);
  const findings: Array<Record<string, unknown>> = [];
  const conflictRe = /\b(?:notion|confluence|google docs|gdrive)\b.{0,80}\b(?:ssot|source of truth|canonical)\b|\b(?:ssot|source of truth|canonical)\b.{0,80}\b(?:notion|confluence|google docs|gdrive)\b/i;
  for (const doc of index.docs) {
    const lines = (doc.text || "").split(/\r?\n/);
    for (let indexLine = 0; indexLine < lines.length; indexLine += 1) {
      const line = lines[indexLine] || "";
      if (conflictRe.test(line) && !/mirror|not ssot|repo.*ssot|markdown.*ssot/i.test(line)) {
        findings.push({
          file_path: doc.relPath,
          line: indexLine + 1,
          conflict_hash: stableHash(line),
          confidence: 0.65,
          reason: "Line appears to assign SSOT/canonical status to an external docs surface. Repo markdown should remain SSOT unless explicitly reviewed.",
        });
      }
    }
  }
  const limited = findings.slice(0, maxFindings(config, args));
  const result = attachStats(
    {
      ...baseResult("ssot_conflicts", index.root),
      doc_count: index.docs.length,
      ssot_conflicts_count: findings.length,
      findings: limited,
      truncated: limited.length < findings.length,
    },
    index.rawChars,
  );
  return withArtifact(config, "ssot-conflicts", result);
}

export async function proposeDocMergeOrArchive(config: DocsHygieneConfig, args: DocsArgs = {}) {
  const root = repoRoot(args);
  const planArgs = { ...args, max_findings: Math.min(maxFindings(config, args), 20) };
  const [brokenLinks, brokenAnchors, orphans, duplicates, staleRefs, ssot] = await Promise.all([
    findBrokenLinks(config, planArgs),
    findBrokenAnchors(config, planArgs),
    findOrphanDocs(config, planArgs),
    findDuplicateSections(config, planArgs),
    findStaleCodeReferences(config, planArgs),
    checkSsotConflicts(config, planArgs),
  ]);
  const planItems: Array<Record<string, unknown>> = [];
  for (const finding of (brokenLinks.findings as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "fix_or_remove_broken_link",
      evidence: finding,
      required_proof: ["verify intended target", "update source doc", "run docs-hygiene smoke/benchmark if logic changes"],
      destructive_change_allowed: false,
    });
  }
  for (const finding of (brokenAnchors.findings as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "fix_broken_anchor",
      evidence: finding,
      required_proof: ["verify target heading", "preserve external backlinks when possible"],
      destructive_change_allowed: false,
    });
  }
  for (const orphan of (orphans.orphans as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_orphan_doc",
      evidence: orphan,
      required_proof: ["check external/Notion references", "choose owner or archive target", "do not delete without reviewed replacement"],
      destructive_change_allowed: false,
    });
  }
  for (const duplicate of (duplicates.duplicates as Array<Record<string, unknown>>).slice(0, 4)) {
    planItems.push({
      action: "review_duplicate_section",
      evidence: duplicate,
      required_proof: ["read exact sections", "pick SSOT target", "preserve backlinks"],
      destructive_change_allowed: false,
    });
  }
  for (const finding of (staleRefs.findings as Array<Record<string, unknown>>).slice(0, 4)) {
    planItems.push({
      action: "fix_stale_code_reference",
      evidence: finding,
      required_proof: ["verify renamed/deleted target", "update doc path or mark obsolete"],
      destructive_change_allowed: false,
    });
  }
  for (const finding of (ssot.findings as Array<Record<string, unknown>>).slice(0, 3)) {
    planItems.push({
      action: "review_ssot_claim",
      evidence: finding,
      required_proof: ["confirm repo markdown remains canonical", "update wording or mirror registry"],
      destructive_change_allowed: false,
    });
  }
  const rawTokens = [brokenLinks, brokenAnchors, orphans, duplicates, staleRefs, ssot].reduce(
    (sum, item) => sum + Number((item as { raw_tokens_estimate?: number }).raw_tokens_estimate || 0),
    0,
  );
  const result = attachStats(
    {
      ...baseResult("doc_merge_or_archive_plan", root),
      plan_items_count: planItems.length,
      plan_items: planItems.slice(0, maxFindings(config, args)),
      source_artifacts: {
        broken_links: brokenLinks.artifact_file,
        broken_anchors: brokenAnchors.artifact_file,
        orphan_docs: orphans.artifact_file,
        duplicate_sections: duplicates.artifact_file,
        stale_code_references: staleRefs.artifact_file,
        ssot_conflicts: ssot.artifact_file,
      },
      policy: {
        advisory_only: true,
        destructive_change_allowed: false,
        repo_markdown_is_ssot: true,
      },
    },
    rawTokens * 4,
  );
  return withArtifact(config, "doc-merge-archive-plan", result);
}
