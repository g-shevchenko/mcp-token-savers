import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonArtifact } from "./artifact-store.js";
import {
  REPO_HYGIENE_PIPELINE_VERSION,
  REPO_HYGIENE_SCHEMA_VERSION,
  RepoHygieneConfig,
} from "./config.js";
import { estimateTokens, round, stableHash } from "./text-utils.js";

export interface HygieneArgs {
  block_lines?: number;
  include_imported_templates?: boolean;
  max_file_bytes?: number;
  max_files?: number;
  max_findings?: number;
  metadata?: unknown;
  repo_root?: string;
}

interface RepoFile {
  absPath: string;
  ext: string;
  relPath: string;
  size: number;
  text?: string;
}

interface TokenStats {
  compact_tokens_estimate: number;
  raw_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
}

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

const CODE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".php",
  ".py",
  ".rs",
  ".scss",
  ".ts",
  ".tsx",
]);

const PACKAGE_LOCK_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const PACKAGE_LOCK_MAX_FILE_BYTES = 5_000_000;
const IMPORT_RE =
  /\bimport\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/g;

interface ImportReference {
  kind: "dynamic_import" | "export" | "import" | "require";
  specifier: string;
}

function repoRoot(args: HygieneArgs): string {
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

function limit(config: RepoHygieneConfig, args: HygieneArgs, key: "max_files" | "max_file_bytes" | "max_findings"): number {
  if (key === "max_files") {
    return positiveNumber(args.max_files, config.maxFiles);
  }
  if (key === "max_file_bytes") {
    return positiveNumber(args.max_file_bytes, config.maxFileBytes);
  }
  return positiveNumber(args.max_findings, config.maxFindings);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isCodeFile(file: RepoFile): boolean {
  return CODE_EXTENSIONS.has(file.ext);
}

function isDependencyEvidenceName(name: string): boolean {
  return (
    name.startsWith("tsconfig") ||
    name.startsWith("next.config") ||
    name.startsWith("postcss.config") ||
    name.startsWith("tailwind.config") ||
    name.startsWith("vite.config") ||
    name.startsWith("eslint.config")
  );
}

function isRepoHygieneCandidateFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    CODE_EXTENSIONS.has(path.extname(lower)) ||
    lower === "package.json" ||
    PACKAGE_LOCK_FILES.has(lower) ||
    isDependencyEvidenceName(lower)
  );
}

async function collectRepoFiles(config: RepoHygieneConfig, args: HygieneArgs): Promise<RepoFile[]> {
  const root = repoRoot(args);
  const maxFiles = limit(config, args, "max_files");
  const maxFileBytes = limit(config, args, "max_file_bytes");
  const files: RepoFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) {
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
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith(".") && ![".claude", ".cursor", ".windsurf"].includes(entry.name)) {
        if (entry.isDirectory()) {
          continue;
        }
      }
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
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
      if (!isRepoHygieneCandidateFile(entry.name)) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      const maxAllowedBytes = PACKAGE_LOCK_FILES.has(entry.name.toLowerCase())
        ? Math.max(maxFileBytes, PACKAGE_LOCK_MAX_FILE_BYTES)
        : maxFileBytes;
      if (stat.size > maxAllowedBytes) {
        continue;
      }
      const relPath = toPosix(path.relative(root, absPath));
      files.push({
        absPath,
        ext: path.extname(entry.name).toLowerCase(),
        relPath,
        size: stat.size,
      });
    }
  }

  await walk(root);
  return files;
}

async function readText(file: RepoFile): Promise<string> {
  if (file.text !== undefined) {
    return file.text;
  }
  const text = await fs.readFile(file.absPath, "utf8");
  file.text = text;
  return text;
}

async function readCodeFiles(files: RepoFile[]): Promise<RepoFile[]> {
  const codeFiles = files.filter(isCodeFile);
  await Promise.all(
    codeFiles.map(async (file) => {
      try {
        await readText(file);
      } catch {
        file.text = "";
      }
    }),
  );
  return codeFiles;
}

function extractImportReferences(text: string): ImportReference[] {
  const references: ImportReference[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2] || match[3] || match[4];
    if (specifier) {
      const kind = match[4] ? "dynamic_import" : match[3] ? "require" : match[2] ? "export" : "import";
      references.push({ kind, specifier });
    }
  }
  for (const match of text.matchAll(CSS_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      references.push({ kind: "import", specifier });
    }
  }
  return references;
}

function extractImportSpecifiers(text: string): string[] {
  return extractImportReferences(text).map((reference) => reference.specifier);
}

function packageName(specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return "";
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] || "";
}

function typePackageRuntimeName(name: string): string {
  if (!name.startsWith("@types/")) {
    return "";
  }
  const raw = name.slice("@types/".length);
  return raw.includes("__") ? `@${raw.replace("__", "/")}` : raw;
}

function posixDirname(filePath: string): string {
  const dirname = path.posix.dirname(filePath);
  return dirname === "." ? "" : dirname;
}

function isInsidePackageRoot(filePath: string, packageRoot: string): boolean {
  return packageRoot ? filePath.startsWith(`${packageRoot}/`) : true;
}

function isDependencyEvidenceFile(file: RepoFile): boolean {
  return isDependencyEvidenceName(path.basename(file.relPath).toLowerCase());
}

function packageScriptText(parsed: any): string {
  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return "";
  }
  return Object.values(scripts)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function dependencyNameMentioned(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9@_./-])${escaped}([^A-Za-z0-9_./-]|$)`).test(text);
}

function packageNameFromNodeModulesPath(lockPath: string): string {
  const marker = "node_modules/";
  const markerIndex = lockPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    return "";
  }
  const suffix = lockPath.slice(markerIndex + marker.length);
  const parts = suffix.split("/").filter(Boolean);
  return suffix.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] || "";
}

interface PackageLockEvidence {
  binaryNamesByPackage: Map<string, Set<string>>;
  peerDependenciesByPackage: Map<string, Set<string>>;
}

async function packageLockEvidence(files: RepoFile[], packageRoot: string): Promise<PackageLockEvidence> {
  const empty = {
    binaryNamesByPackage: new Map<string, Set<string>>(),
    peerDependenciesByPackage: new Map<string, Set<string>>(),
  };
  const lockRelPath = packageRoot ? `${packageRoot}/package-lock.json` : "package-lock.json";
  const lockFile = files.find((file) => file.relPath === lockRelPath);
  if (!lockFile) {
    return empty;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(await readText(lockFile));
  } catch {
    return empty;
  }
  const packages = parsed?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    return empty;
  }
  const binsByPackage = new Map<string, Set<string>>();
  const peerDependenciesByPackage = new Map<string, Set<string>>();
  for (const [lockPath, metadata] of Object.entries(packages)) {
    const dependencyName = packageNameFromNodeModulesPath(lockPath);
    if (!dependencyName || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      continue;
    }
    const row = metadata as Record<string, unknown>;
    const bin = row.bin;
    const binNames =
      typeof bin === "string"
        ? [dependencyName.startsWith("@") ? dependencyName.split("/").at(-1) || dependencyName : dependencyName]
        : bin && typeof bin === "object" && !Array.isArray(bin)
          ? Object.keys(bin)
          : [];
    if (binNames.length) {
      const current = binsByPackage.get(dependencyName) || new Set<string>();
      for (const binName of binNames) {
        current.add(binName);
      }
      binsByPackage.set(dependencyName, current);
    }
    const peerDependencies = row.peerDependencies;
    if (peerDependencies && typeof peerDependencies === "object" && !Array.isArray(peerDependencies)) {
      peerDependenciesByPackage.set(dependencyName, new Set(Object.keys(peerDependencies)));
    }
  }
  return { binaryNamesByPackage: binsByPackage, peerDependenciesByPackage };
}

function scriptMentionsPackageBin(scriptText: string, binNames: Set<string> | undefined): boolean {
  if (!binNames?.size) {
    return false;
  }
  for (const binName of binNames) {
    if (dependencyNameMentioned(scriptText, binName)) {
      return true;
    }
  }
  return false;
}

function importedPackagesForRoot(codeFiles: RepoFile[], packageRoot: string): Set<string> {
  const imported = new Set<string>();
  for (const file of codeFiles) {
    if (!isInsidePackageRoot(file.relPath, packageRoot)) {
      continue;
    }
    for (const reference of extractImportReferences(file.text || "")) {
      const name = packageName(reference.specifier);
      if (name) {
        imported.add(name);
      }
    }
  }
  return imported;
}

function hasPeerDependencyEvidence(
  dependencyName: string,
  providerPackages: Set<string>,
  peerDependenciesByPackage: Map<string, Set<string>>,
): boolean {
  for (const provider of providerPackages) {
    if (peerDependenciesByPackage.get(provider)?.has(dependencyName)) {
      return true;
    }
  }
  return false;
}

async function packageEvidenceText(files: RepoFile[], packageRoot: string): Promise<string> {
  const evidence: string[] = [];
  for (const file of files) {
    if (!isInsidePackageRoot(file.relPath, packageRoot) || PACKAGE_LOCK_FILES.has(path.basename(file.relPath))) {
      continue;
    }
    if (!isDependencyEvidenceFile(file) && !isCodeFile(file)) {
      continue;
    }
    try {
      evidence.push(await readText(file));
    } catch {
      // ignore unreadable evidence files
    }
  }
  return evidence.join("\n");
}

function resolveRelativeImport(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = toPosix(path.normalize(path.join(path.dirname(fromFile), specifier)));
  const candidates = [
    base,
    ...Array.from(CODE_EXTENSIONS).map((ext) => `${base}${ext}`),
    ...Array.from(CODE_EXTENSIONS).map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function exportedNames(text: string): string[] {
  const names = new Set<string>();
  const direct =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(direct)) {
    if (match[1] && match[1].length >= 3) {
      names.add(match[1]);
    }
  }
  const named = /\bexport\s*\{([^}]+)\}/g;
  for (const match of text.matchAll(named)) {
    const members = (match[1] || "").split(",");
    for (const member of members) {
      const local = member.trim().split(/\s+as\s+/i)[0]?.trim();
      if (local && /^[A-Za-z_$][\w$]*$/.test(local) && local.length >= 3) {
        names.add(local);
      }
    }
  }
  return Array.from(names).sort();
}

function wordCount(texts: string[], name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  return texts.reduce((sum, text) => sum + Array.from(text.matchAll(re)).length, 0);
}

function attachStats<T extends Record<string, unknown>>(payload: T, rawChars: number): T & TokenStats {
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

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: REPO_HYGIENE_SCHEMA_VERSION,
    pipeline_version: REPO_HYGIENE_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local evidence only. No auto-delete. Tool output uses relative paths and metadata; request logs store counts/hashes, not file bodies.",
  };
}

async function withArtifact<T extends object>(
  config: RepoHygieneConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

export async function scanUnusedDependencies(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const files = await collectRepoFiles(config, args);
  const packageFiles = files.filter((file) => path.basename(file.relPath) === "package.json");
  const codeFiles = await readCodeFiles(files);
  let dynamicImportsSeen = 0;
  let rawChars = 0;

  for (const file of codeFiles) {
    const text = file.text || "";
    rawChars += text.length;
    for (const reference of extractImportReferences(text)) {
      if (reference.kind === "dynamic_import") {
        dynamicImportsSeen += 1;
      }
    }
  }

  const candidates: Array<Record<string, unknown>> = [];
  let dependenciesTotal = 0;
  for (const file of packageFiles) {
    let parsed: any;
    try {
      parsed = JSON.parse(await readText(file));
    } catch {
      continue;
    }
    const packageRoot = posixDirname(file.relPath);
    const packageFilesForRoot = files.filter((row) => isInsidePackageRoot(row.relPath, packageRoot));
    const scriptText = packageScriptText(parsed);
    const lockEvidence = await packageLockEvidence(files, packageRoot);
    const evidenceText = `${scriptText}\n${await packageEvidenceText(files, packageRoot)}`;
    const rootImportedPackages = importedPackagesForRoot(codeFiles, packageRoot);
    const hasTypescriptSurface = packageFilesForRoot.some((row) => [".ts", ".tsx"].includes(row.ext) || path.basename(row.relPath).startsWith("tsconfig"));
    const hasPostcssConfig = packageFilesForRoot.some((row) => path.basename(row.relPath).toLowerCase().startsWith("postcss.config"));
    const declaredDeps = new Set<string>();
    for (const dependencyType of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = parsed?.[dependencyType];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const depName of Object.keys(deps)) {
          declaredDeps.add(depName);
        }
      }
    }
    const peerProviderPackages = new Set(rootImportedPackages);
    for (const depName of declaredDeps) {
      if (dependencyNameMentioned(evidenceText, depName) || scriptMentionsPackageBin(scriptText, lockEvidence.binaryNamesByPackage.get(depName))) {
        peerProviderPackages.add(depName);
      }
    }
    for (const dependencyType of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = parsed?.[dependencyType];
      if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
        continue;
      }
      for (const name of Object.keys(deps).sort()) {
        dependenciesTotal += 1;
        const typeRuntimeName = typePackageRuntimeName(name);
        const usedByTypeSurface =
          Boolean(typeRuntimeName) &&
          hasTypescriptSurface &&
          (typeRuntimeName === "node" || rootImportedPackages.has(typeRuntimeName) || declaredDeps.has(typeRuntimeName));
        const usedByToolingSurface =
          (name === "typescript" && hasTypescriptSurface) ||
          (name === "postcss" && hasPostcssConfig) ||
          scriptMentionsPackageBin(scriptText, lockEvidence.binaryNamesByPackage.get(name)) ||
          hasPeerDependencyEvidence(name, peerProviderPackages, lockEvidence.peerDependenciesByPackage) ||
          dependencyNameMentioned(evidenceText, name);
        if (!rootImportedPackages.has(name) && !usedByTypeSurface && !usedByToolingSurface) {
          candidates.push({
            package_file: file.relPath,
            dependency_name: name,
            dependency_type: dependencyType,
            confidence: dependencyType === "dependencies" ? 0.65 : 0.5,
            reason:
              "No local import, package-script, config, type-surface, package-lock binary, or peer-dependency evidence found in scanned files. Review runtime loaders before removal.",
          });
        }
      }
    }
  }

  const limited = candidates.slice(0, limit(config, args, "max_findings"));
  const result = attachStats(
    {
      ...baseResult("unused_dependencies", root),
      scanned_files: files.length,
      package_files: packageFiles.length,
      dependencies_total: dependenciesTotal,
      dynamic_imports_seen: dynamicImportsSeen,
      candidates_count: candidates.length,
      candidates: limited,
      truncated: limited.length < candidates.length,
    },
    rawChars,
  );
  return withArtifact(config, "unused-dependencies", result);
}

export async function scanUnusedCode(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const files = await collectRepoFiles(config, args);
  const codeFiles = await readCodeFiles(files);
  const texts = codeFiles.map((file) => file.text || "");
  const candidates: Array<Record<string, unknown>> = [];
  const maxFindings = limit(config, args, "max_findings");
  let rawChars = 0;

  for (const file of codeFiles) {
    const text = file.text || "";
    rawChars += text.length;
    for (const name of exportedNames(text)) {
      const references = wordCount(texts, name);
      if (references <= 1) {
        candidates.push({
          file_path: file.relPath,
          symbol_name: name,
          symbol_hash: stableHash(`${file.relPath}:${name}`),
          reference_count_estimate: references,
          confidence: 0.45,
          reason:
            "Exported symbol appears only at its definition in scanned source. Review dynamic imports, public APIs, and generated references before cleanup.",
        });
      }
      if (candidates.length >= maxFindings) {
        break;
      }
    }
    if (candidates.length >= maxFindings) {
      break;
    }
  }

  const result = attachStats(
    {
      ...baseResult("unused_code", root),
      scanned_files: files.length,
      code_files: codeFiles.length,
      candidates_count: candidates.length,
      candidates,
      heuristic: "regex-export reference count; advisory only",
    },
    rawChars,
  );
  return withArtifact(config, "unused-code", result);
}

function normalizeDuplicateLine(line: string): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed === "};" || trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return "";
  }
  return trimmed;
}

export async function scanDuplicateCode(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const blockLines = positiveNumber(args.block_lines, config.duplicateBlockLines);
  const files = await collectRepoFiles(config, args);
  const codeFiles = await readCodeFiles(files);
  const blocks = new Map<string, Array<{ file_path: string; line_start: number }>>();
  let rawChars = 0;

  for (const file of codeFiles) {
    const text = file.text || "";
    rawChars += text.length;
    const meaningful = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: normalizeDuplicateLine(line), line_start: index + 1 }))
      .filter((line) => line.line);
    for (let index = 0; index <= meaningful.length - blockLines; index += 1) {
      const slice = meaningful.slice(index, index + blockLines);
      const normalized = slice.map((line) => line.line).join("\n");
      if (new Set(slice.map((line) => line.line)).size < Math.min(3, blockLines) || normalized.length < 80) {
        continue;
      }
      const hash = stableHash(normalized);
      const rows = blocks.get(hash) || [];
      rows.push({ file_path: file.relPath, line_start: slice[0]?.line_start || 1 });
      blocks.set(hash, rows);
    }
  }

  const duplicateGroups = Array.from(blocks.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.file_path)).size > 1)
    .map(([hash, rows]) => ({
      block_hash: hash,
      occurrences: rows.length,
      files: rows.slice(0, 8),
      confidence: 0.7,
      reason: "Same normalized code block appears in multiple files. Review before extracting a shared helper.",
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.block_hash.localeCompare(b.block_hash));

  const limited = duplicateGroups.slice(0, limit(config, args, "max_findings"));
  const result = attachStats(
    {
      ...baseResult("duplicate_code", root),
      scanned_files: files.length,
      code_files: codeFiles.length,
      block_lines: blockLines,
      duplicate_groups: duplicateGroups.length,
      duplicates: limited,
      truncated: limited.length < duplicateGroups.length,
    },
    rawChars,
  );
  return withArtifact(config, "duplicate-code", result);
}

async function buildImportGraph(files: RepoFile[]): Promise<Map<string, string[]>> {
  const codeFiles = await readCodeFiles(files);
  const fileSet = new Set(codeFiles.map((file) => file.relPath));
  const graph = new Map<string, string[]>();
  for (const file of codeFiles) {
    const imports = extractImportSpecifiers(file.text || "")
      .map((specifier) => resolveRelativeImport(file.relPath, specifier, fileSet))
      .filter((item): item is string => Boolean(item));
    graph.set(file.relPath, Array.from(new Set(imports)).sort());
  }
  return graph;
}

function findCycles(graph: Map<string, string[]>, maxFindings: number): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  function canonical(cycle: string[]): string {
    const body = cycle.slice(0, -1);
    const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)].join(">"));
    return rotations.sort()[0] || body.join(">");
  }

  function visit(node: string): void {
    if (cycles.length >= maxFindings) {
      return;
    }
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      if (start >= 0) {
        const cycle = [...stack.slice(start), node];
        const key = canonical(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(node);
  }

  for (const node of graph.keys()) {
    visit(node);
    if (cycles.length >= maxFindings) {
      break;
    }
  }
  return cycles;
}

export async function scanDependencyCycles(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const files = await collectRepoFiles(config, args);
  const graph = await buildImportGraph(files);
  const rawChars = files.filter(isCodeFile).reduce((sum, file) => sum + (file.text || "").length, 0);
  const cycles = findCycles(graph, limit(config, args, "max_findings")).map((cycle) => ({
    cycle,
    length: Math.max(0, cycle.length - 1),
    confidence: 0.8,
    reason: "Relative import cycle found in scanned JS/TS graph. Review generated entrypoints and barrel files before refactor.",
  }));
  const edgeCount = Array.from(graph.values()).reduce((sum, imports) => sum + imports.length, 0);
  const result = attachStats(
    {
      ...baseResult("dependency_cycles", root),
      scanned_files: files.length,
      graph_files: graph.size,
      import_edges: edgeCount,
      cycles_count: cycles.length,
      cycles,
    },
    rawChars,
  );
  return withArtifact(config, "dependency-cycles", result);
}

export async function scanComplexityHotspots(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const files = await collectRepoFiles(config, args);
  const codeFiles = await readCodeFiles(files);
  let rawChars = 0;
  const hotspots = codeFiles
    .map((file) => {
      const text = file.text || "";
      rawChars += text.length;
      const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
      const functions = Array.from(text.matchAll(/\b(function|class|=>)\b/g)).length;
      const branches = Array.from(text.matchAll(/\b(if|for|while|case|catch|switch)\b|\?\s|&&|\|\|/g)).length;
      const imports = extractImportSpecifiers(text).length;
      const score = branches * 2 + functions * 3 + imports + Math.ceil(lines / 40);
      return {
        file_path: file.relPath,
        lines,
        functions,
        branches,
        imports,
        score,
        confidence: 0.6,
        reason: "Heuristic complexity hotspot. Prefer focused tests or splitting only after exact-file review.",
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.lines - a.lines || a.file_path.localeCompare(b.file_path))
    .slice(0, limit(config, args, "max_findings"));

  const result = attachStats(
    {
      ...baseResult("complexity_hotspots", root),
      scanned_files: files.length,
      code_files: codeFiles.length,
      hotspots_count: hotspots.length,
      hotspots,
    },
    rawChars,
  );
  return withArtifact(config, "complexity-hotspots", result);
}

export async function proposeCleanupPlan(config: RepoHygieneConfig, args: HygieneArgs = {}) {
  const root = repoRoot(args);
  const planArgs = { ...args, max_findings: Math.min(limit(config, args, "max_findings"), 20) };
  const [unusedDeps, unusedCode, duplicates, cycles, hotspots] = await Promise.all([
    scanUnusedDependencies(config, planArgs),
    scanUnusedCode(config, planArgs),
    scanDuplicateCode(config, planArgs),
    scanDependencyCycles(config, planArgs),
    scanComplexityHotspots(config, planArgs),
  ]);

  const planItems: Array<Record<string, unknown>> = [];
  for (const candidate of (unusedDeps.candidates as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_dependency_removal",
      target: candidate.dependency_name,
      evidence: candidate,
      required_proof: ["inspect package scripts/runtime loaders", "run focused tests"],
      auto_delete_allowed: false,
    });
  }
  for (const candidate of (unusedCode.candidates as Array<Record<string, unknown>>).slice(0, 5)) {
    planItems.push({
      action: "review_unused_export",
      target: candidate.symbol_hash,
      evidence: candidate,
      required_proof: ["read exact file", "check public API and dynamic references", "run focused tests"],
      auto_delete_allowed: false,
    });
  }
  for (const duplicate of (duplicates.duplicates as Array<Record<string, unknown>>).slice(0, 4)) {
    planItems.push({
      action: "review_duplicate_block",
      target: duplicate.block_hash,
      evidence: duplicate,
      required_proof: ["read exact files", "check behavioral divergence", "run focused tests"],
      auto_delete_allowed: false,
    });
  }
  for (const cycle of (cycles.cycles as Array<Record<string, unknown>>).slice(0, 4)) {
    planItems.push({
      action: "break_import_cycle",
      target: stableHash(JSON.stringify(cycle.cycle)),
      evidence: cycle,
      required_proof: ["read exact files", "preserve module initialization order", "run build/tests"],
      auto_delete_allowed: false,
    });
  }
  for (const hotspot of (hotspots.hotspots as Array<Record<string, unknown>>).slice(0, 3)) {
    planItems.push({
      action: "contain_complexity_hotspot",
      target: stableHash(String(hotspot.file_path)),
      evidence: hotspot,
      required_proof: ["read exact file", "avoid cosmetic churn", "add tests before risky refactor"],
      auto_delete_allowed: false,
    });
  }

  const rawTokens = [unusedDeps, unusedCode, duplicates, cycles, hotspots].reduce(
    (sum, item) => sum + Number((item as { raw_tokens_estimate?: number }).raw_tokens_estimate || 0),
    0,
  );
  const result = attachStats(
    {
      ...baseResult("cleanup_plan", root),
      scanned_files: Math.max(
        Number(unusedDeps.scanned_files || 0),
        Number(unusedCode.scanned_files || 0),
        Number(duplicates.scanned_files || 0),
        Number(cycles.scanned_files || 0),
        Number(hotspots.scanned_files || 0),
      ),
      plan_items_count: planItems.length,
      plan_items: planItems.slice(0, limit(config, args, "max_findings")),
      source_artifacts: {
        unused_dependencies: unusedDeps.artifact_file,
        unused_code: unusedCode.artifact_file,
        duplicate_code: duplicates.artifact_file,
        dependency_cycles: cycles.artifact_file,
        complexity_hotspots: hotspots.artifact_file,
      },
      policy: {
        advisory_only: true,
        auto_delete_allowed: false,
        quarantine_required_before_delete: true,
      },
    },
    rawTokens * 4,
  );
  return withArtifact(config, "cleanup-plan", result);
}
