import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeArtifact } from "./artifact-store.js";
import { LANGUAGE_GRAPH_PIPELINE_VERSION, LANGUAGE_GRAPH_SCHEMA_VERSION, LanguageGraphConfig } from "./config.js";
import { basenameWithoutExt, estimateTokens, normalizePathForGraph, stableHash } from "./text-utils.js";

const execFileAsync = promisify(execFile);

const SCANNABLE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const CODE_SYMBOL_KINDS = new Set(["class", "function", "route", "tool", "type", "key"]);
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".md", ".yaml", ".yml"];

export interface GraphFile {
  content_hash: string;
  ext: string;
  import_count: number;
  mtime_ms: number;
  path: string;
  size_bytes: number;
  symbol_count: number;
}

export interface GraphSymbol {
  kind: string;
  line: number;
  name: string;
  path: string;
}

export interface GraphImport {
  kind: "dynamic_import" | "import" | "export" | "require" | "route";
  line: number;
  path: string;
  resolved_path?: string;
  target: string;
}

export interface GraphReference {
  line: number;
  path: string;
  symbol: string;
}

export interface LanguageGraphIndex {
  files: Record<string, GraphFile>;
  imports: GraphImport[];
  indexed_at: string;
  pipeline_version: string;
  references: GraphReference[];
  root_hash: string;
  root_name: string;
  schema_version: string;
  stats: {
    files_indexed: number;
    imports_indexed: number;
    dynamic_imports_indexed: number;
    references_indexed: number;
    skipped_files: number;
    symbols_indexed: number;
    total_bytes_indexed: number;
  };
  symbols: GraphSymbol[];
}

interface ParsedFile {
  imports: GraphImport[];
  symbols: GraphSymbol[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function boolArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

function repoRootFromArgs(args: Record<string, unknown>): string {
  return path.resolve(stringArg(args, "repo_root") || process.cwd());
}

function rootHash(root: string): string {
  return stableHash(path.resolve(root));
}

function indexPath(config: LanguageGraphConfig, root: string): string {
  return path.join(config.indexDir, `${rootHash(root)}.json`);
}

function isFilteredPath(relativePath: string): boolean {
  const clean = normalizePathForGraph(relativePath);
  const parts = clean.split("/");
  if (
    parts.some((part) =>
      [
        ".git",
        ".hwai",
        ".next",
        ".turbo",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "tmp",
      ].includes(part),
    )
  ) {
    return true;
  }
  return /\.(avif|gif|ico|jpeg|jpg|lock|mp3|mp4|pdf|png|sqlite|webm|woff2?|zip)$/i.test(clean);
}

function shouldScan(relativePath: string): boolean {
  return !isFilteredPath(relativePath) && SCANNABLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

async function fallbackWalk(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    if (out.length >= limit) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= limit) {
        return;
      }
      const absolute = path.join(dir, entry.name);
      const relative = normalizePathForGraph(path.relative(root, absolute));
      if (isFilteredPath(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && shouldScan(relative)) {
        out.push(relative);
      }
    }
  }
  await visit(root);
  return out;
}

async function listCandidateFiles(root: string, limit: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--files",
        "--hidden",
        "-g",
        "!.git",
        "-g",
        "!node_modules",
        "-g",
        "!dist",
        "-g",
        "!build",
        "-g",
        "!coverage",
        "-g",
        "!.next",
        "-g",
        "!.turbo",
        "-g",
        "!.hwai",
      ],
      { cwd: root, maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => normalizePathForGraph(line.trim()))
      .filter(Boolean)
      .filter(shouldScan)
      .slice(0, limit);
  } catch {
    return fallbackWalk(root, limit);
  }
}

function addSymbol(symbols: GraphSymbol[], relativePath: string, kind: string, name: string | undefined, line: number): void {
  const cleanName = name?.trim();
  if (!cleanName || cleanName.length > 140 || symbols.length >= 160) {
    return;
  }
  symbols.push({
    kind,
    line,
    name: cleanName,
    path: relativePath,
  });
}

function addImport(
  imports: GraphImport[],
  relativePath: string,
  kind: GraphImport["kind"],
  target: string | undefined,
  line: number,
): void {
  const cleanTarget = target?.trim();
  if (!cleanTarget || cleanTarget.length > 220 || imports.length >= 160) {
    return;
  }
  imports.push({
    kind,
    line,
    path: relativePath,
    target: cleanTarget,
  });
}

function parseCodeFile(relativePath: string, lines: string[]): ParsedFile {
  const symbols: GraphSymbol[] = [];
  const imports: GraphImport[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    const routeMatch = trimmed.match(/\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/);
    if (routeMatch) {
      addSymbol(symbols, relativePath, "route", `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, lineNumber);
      addImport(imports, relativePath, "route", `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, lineNumber);
    }

    const toolMatch = trimmed.match(/\bname:\s*["']([A-Za-z0-9_.:-]+)["']/);
    if (toolMatch) {
      addSymbol(symbols, relativePath, "tool", toolMatch[1], lineNumber);
    }

    const functionMatch = trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    );
    if (functionMatch) {
      addSymbol(symbols, relativePath, "function", functionMatch[1], lineNumber);
    }

    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (classMatch) {
      addSymbol(symbols, relativePath, "class", classMatch[1], lineNumber);
    }

    const typeMatch = trimmed.match(/^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (typeMatch) {
      addSymbol(symbols, relativePath, "type", typeMatch[1], lineNumber);
    }

    const constFunctionMatch = trimmed.match(
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/,
    );
    if (constFunctionMatch) {
      addSymbol(symbols, relativePath, "function", constFunctionMatch[1], lineNumber);
    }

    const importMatch = trimmed.match(/\bimport\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/);
    if (importMatch) {
      addImport(imports, relativePath, "import", importMatch[1], lineNumber);
    }

    const exportMatch = trimmed.match(/\bexport\s+[^"']+\s+from\s+["']([^"']+)["']/);
    if (exportMatch) {
      addImport(imports, relativePath, "export", exportMatch[1], lineNumber);
    }

    const requireMatch = trimmed.match(/\brequire\(\s*["']([^"']+)["']\s*\)/);
    if (requireMatch) {
      addImport(imports, relativePath, "require", requireMatch[1], lineNumber);
    }

    const dynamicImportMatch = trimmed.match(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (dynamicImportMatch) {
      addImport(imports, relativePath, "dynamic_import", dynamicImportMatch[1], lineNumber);
    }

    const pythonFunctionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (pythonFunctionMatch) {
      addSymbol(symbols, relativePath, "function", pythonFunctionMatch[1], lineNumber);
    }

    const pythonClassMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (pythonClassMatch) {
      addSymbol(symbols, relativePath, "class", pythonClassMatch[1], lineNumber);
    }

    const pythonImportMatch = trimmed.match(/^(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/);
    if (pythonImportMatch) {
      addImport(imports, relativePath, "import", pythonImportMatch[1] || pythonImportMatch[2], lineNumber);
    }

    const shellFunctionMatch = trimmed.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/);
    if (shellFunctionMatch) {
      addSymbol(symbols, relativePath, "function", shellFunctionMatch[1], lineNumber);
    }
  }

  return { symbols, imports };
}

function parseMarkdownFile(relativePath: string, lines: string[]): ParsedFile {
  const symbols: GraphSymbol[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (match) {
      addSymbol(symbols, relativePath, `heading${match[1].length}`, match[2], index + 1);
    }
  }
  return { symbols, imports: [] };
}

function parseYamlFile(relativePath: string, lines: string[]): ParsedFile {
  const symbols: GraphSymbol[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^([A-Za-z0-9_.-][A-Za-z0-9_.-]*):\s*/);
    if (match) {
      addSymbol(symbols, relativePath, "key", match[1], index + 1);
    }
  }
  return { symbols, imports: [] };
}

function parseJsonFile(relativePath: string, lines: string[]): ParsedFile {
  const symbols: GraphSymbol[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*"([A-Za-z0-9_.-]{2,80})"\s*:/);
    if (match) {
      addSymbol(symbols, relativePath, "key", match[1], index + 1);
    }
  }
  return { symbols, imports: [] };
}

function parseFile(relativePath: string, text: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".md" || ext === ".mdx") {
    return parseMarkdownFile(relativePath, lines);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return parseYamlFile(relativePath, lines);
  }
  if (ext === ".json") {
    return parseJsonFile(relativePath, lines);
  }
  return parseCodeFile(relativePath, lines);
}

function resolveImportTarget(fromPath: string, target: string, fileSet: Set<string>): string | undefined {
  if (target.startsWith(".")) {
    const base = normalizePathForGraph(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target)));
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = normalizePathForGraph(`${base}${ext}`);
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
    for (const ext of RESOLVE_EXTENSIONS.filter(Boolean)) {
      const candidate = normalizePathForGraph(path.posix.join(base, `index${ext}`));
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
  }

  const pythonCandidate = normalizePathForGraph(`${target.replace(/\./g, "/")}.py`);
  if (fileSet.has(pythonCandidate)) {
    return pythonCandidate;
  }

  return undefined;
}

function referenceSymbolMap(symbols: GraphSymbol[]): Map<string, GraphSymbol[]> {
  const map = new Map<string, GraphSymbol[]>();
  for (const symbol of symbols) {
    if (!CODE_SYMBOL_KINDS.has(symbol.kind) || !/^[A-Za-z_$][A-Za-z0-9_$-]{2,79}$/.test(symbol.name)) {
      continue;
    }
    const bucket = map.get(symbol.name) || [];
    bucket.push(symbol);
    map.set(symbol.name, bucket);
    if (map.size >= 1_200) {
      break;
    }
  }
  return map;
}

function extractReferences(
  fileTexts: Map<string, string>,
  symbols: GraphSymbol[],
  maxReferences = 12_000,
): GraphReference[] {
  const symbolMap = referenceSymbolMap(symbols);
  const perSymbol = new Map<string, number>();
  const references: GraphReference[] = [];

  for (const [relativePath, text] of fileTexts) {
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const tokens = line.match(/[A-Za-z_$][A-Za-z0-9_$-]{2,79}/g) || [];
      for (const token of new Set(tokens)) {
        const definitions = symbolMap.get(token);
        if (!definitions) {
          continue;
        }
        const isDefinitionLine = definitions.some((symbol) => symbol.path === relativePath && symbol.line === lineNumber);
        if (isDefinitionLine) {
          continue;
        }
        const count = perSymbol.get(token) || 0;
        if (count >= 80) {
          continue;
        }
        references.push({
          symbol: token,
          path: relativePath,
          line: lineNumber,
        });
        perSymbol.set(token, count + 1);
        if (references.length >= maxReferences) {
          return references;
        }
      }
    }
  }

  return references;
}

async function readFileText(
  root: string,
  relativePath: string,
  maxFileBytes: number,
): Promise<{ stat: { mtimeMs: number; size: number }; text: string } | null> {
  const absolutePath = path.join(root, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > maxFileBytes) {
    return null;
  }
  const buffer = await fs.readFile(absolutePath);
  if (buffer.includes(0)) {
    return null;
  }
  return { stat, text: buffer.toString("utf8") };
}

function compactIndexSummary(index: LanguageGraphIndex) {
  return {
    schema_version: index.schema_version,
    indexed_at: index.indexed_at,
    root_hash: index.root_hash,
    root_name: index.root_name,
    stats: index.stats,
    top_symbol_files: Object.values(index.files)
      .sort((a, b) => b.symbol_count - a.symbol_count || a.path.localeCompare(b.path))
      .slice(0, 30)
      .map((file) => ({ path: file.path, symbols: file.symbol_count, imports: file.import_count })),
    symbol_kinds: index.symbols.reduce<Record<string, number>>((acc, symbol) => {
      acc[symbol.kind] = (acc[symbol.kind] || 0) + 1;
      return acc;
    }, {}),
    import_kinds: index.imports.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] || 0) + 1;
      return acc;
    }, {}),
  };
}

function estimateBytesAsTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

function estimateFilesAsTokens(index: LanguageGraphIndex, paths: Iterable<string>): number {
  let bytes = 0;
  for (const relativePath of new Set(paths)) {
    bytes += index.files[relativePath]?.size_bytes || 0;
  }
  return estimateBytesAsTokens(bytes);
}

export async function buildLanguageGraphIndex(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const root = repoRootFromArgs(args);
  const maxFiles = Math.min(numberArg(args, "max_files") || config.maxFiles, config.maxFiles);
  const maxFileBytes = Math.min(numberArg(args, "max_file_bytes") || config.maxFileBytes, config.maxFileBytes);
  const candidates = await listCandidateFiles(root, maxFiles);
  const fileTexts = new Map<string, string>();
  const files: Record<string, GraphFile> = {};
  const symbols: GraphSymbol[] = [];
  const imports: GraphImport[] = [];
  let skippedFiles = 0;
  let totalBytes = 0;

  for (const relativePath of candidates) {
    try {
      const loaded = await readFileText(root, relativePath, maxFileBytes);
      if (!loaded) {
        skippedFiles += 1;
        continue;
      }
      const parsed = parseFile(relativePath, loaded.text);
      fileTexts.set(relativePath, loaded.text);
      totalBytes += loaded.stat.size;
      files[relativePath] = {
        content_hash: stableHash(loaded.text),
        ext: path.extname(relativePath).toLowerCase(),
        import_count: parsed.imports.length,
        mtime_ms: Math.round(loaded.stat.mtimeMs),
        path: relativePath,
        size_bytes: loaded.stat.size,
        symbol_count: parsed.symbols.length,
      };
      symbols.push(...parsed.symbols);
      imports.push(...parsed.imports);
    } catch {
      skippedFiles += 1;
    }
  }

  const fileSet = new Set(Object.keys(files));
  for (const edge of imports) {
    edge.resolved_path = resolveImportTarget(edge.path, edge.target, fileSet);
  }

  const references = extractReferences(fileTexts, symbols);
  const dynamicImports = imports.filter((edge) => edge.kind === "dynamic_import").length;
  const index: LanguageGraphIndex = {
    schema_version: LANGUAGE_GRAPH_SCHEMA_VERSION,
    pipeline_version: LANGUAGE_GRAPH_PIPELINE_VERSION,
    indexed_at: new Date().toISOString(),
    root_hash: rootHash(root),
    root_name: path.basename(root),
    files,
    symbols,
    imports,
    references,
    stats: {
      files_indexed: Object.keys(files).length,
      symbols_indexed: symbols.length,
      imports_indexed: imports.length,
      dynamic_imports_indexed: dynamicImports,
      references_indexed: references.length,
      skipped_files: skippedFiles,
      total_bytes_indexed: totalBytes,
    },
  };

  await fs.mkdir(config.indexDir, { recursive: true });
  await fs.writeFile(indexPath(config, root), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const artifact = await writeArtifact(
    config,
    `language-graph-summary-${index.root_hash}-${Date.now()}.json`,
    `${JSON.stringify(compactIndexSummary(index), null, 2)}\n`,
  );
  const compactTokens = estimateTokens(JSON.stringify(compactIndexSummary(index)));
  const rawTokens = estimateBytesAsTokens(totalBytes);

  return {
    schema_version: LANGUAGE_GRAPH_SCHEMA_VERSION,
    status: "indexed",
    root_hash: index.root_hash,
    root_name: index.root_name,
    indexed_at: index.indexed_at,
    files_indexed: index.stats.files_indexed,
    symbols_indexed: index.stats.symbols_indexed,
    imports_indexed: index.stats.imports_indexed,
    dynamic_imports_indexed: index.stats.dynamic_imports_indexed,
    references_indexed: index.stats.references_indexed,
    skipped_files: index.stats.skipped_files,
    index_file: path.basename(indexPath(config, root)),
    artifact_file: artifact.file,
    artifact_url: artifact.url,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

async function loadIndex(config: LanguageGraphConfig, root: string): Promise<LanguageGraphIndex | null> {
  try {
    const raw = await fs.readFile(indexPath(config, root), "utf8");
    return JSON.parse(raw) as LanguageGraphIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadOrBuildIndex(config: LanguageGraphConfig, args: Record<string, unknown>): Promise<LanguageGraphIndex> {
  const root = repoRootFromArgs(args);
  if (!boolArg(args, "refresh")) {
    const existing = await loadIndex(config, root);
    if (existing) {
      return existing;
    }
  }
  if (!boolArg(args, "refresh") && !boolArg(args, "auto_index")) {
    throw new Error("language graph index is missing; call index_repo first or pass auto_index=true");
  }
  await buildLanguageGraphIndex(config, args);
  const index = await loadIndex(config, root);
  if (!index) {
    throw new Error("language graph index was not created");
  }
  return index;
}

async function staleFileCount(root: string, index: LanguageGraphIndex): Promise<number> {
  let stale = 0;
  for (const file of Object.values(index.files)) {
    try {
      const stat = await fs.stat(path.join(root, file.path));
      if (!stat.isFile() || stat.size !== file.size_bytes || Math.round(stat.mtimeMs) !== file.mtime_ms) {
        stale += 1;
      }
    } catch {
      stale += 1;
    }
  }
  return stale;
}

function safeRelativePath(root: string, rawPath: string): string {
  const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  const relative = normalizePathForGraph(path.relative(root, absolute));
  if (relative.startsWith("..")) {
    throw new Error("file_path must be inside repo_root");
  }
  return relative;
}

export async function getGraphStatus(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const root = repoRootFromArgs(args);
  const index = await loadIndex(config, root);
  if (!index) {
    return {
      schema_version: "language-graph-status.v1",
      status: "missing",
      root_hash: rootHash(root),
      files_indexed: 0,
      stale_files: 0,
      recommendation: "call index_repo before graph lookups",
    };
  }
  const staleFiles = await staleFileCount(root, index);
  return {
    schema_version: "language-graph-status.v1",
    status: staleFiles > 0 ? "stale" : "fresh",
    root_hash: index.root_hash,
    root_name: index.root_name,
    indexed_at: index.indexed_at,
    files_indexed: index.stats.files_indexed,
    symbols_indexed: index.stats.symbols_indexed,
    imports_indexed: index.stats.imports_indexed,
    dynamic_imports_indexed: index.stats.dynamic_imports_indexed || 0,
    references_indexed: index.stats.references_indexed,
    stale_files: staleFiles,
  };
}

export async function getFileOutline(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const root = repoRootFromArgs(args);
  const filePath = stringArg(args, "file_path");
  if (!filePath) {
    throw new Error("file_path is required");
  }
  const index = await loadOrBuildIndex(config, args);
  const relativePath = safeRelativePath(root, filePath);
  const file = index.files[relativePath];
  if (!file) {
    throw new Error(`file not indexed: ${relativePath}`);
  }
  const symbols = index.symbols.filter((symbol) => symbol.path === relativePath);
  const imports = index.imports.filter((edge) => edge.path === relativePath);
  const importers = index.imports.filter((edge) => edge.resolved_path === relativePath).slice(0, 40);
  const result = {
    schema_version: "language-graph-outline.v1",
    path: relativePath,
    file,
    symbols,
    imports,
    importers,
    symbol_count: symbols.length,
    import_count: imports.length,
    importer_count: importers.length,
  };
  const compactTokens = estimateTokens(JSON.stringify(result));
  const rawTokens = estimateBytesAsTokens(file.size_bytes);
  return {
    ...result,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

function symbolScore(symbol: GraphSymbol, query: string): number {
  const name = symbol.name.toLowerCase();
  const q = query.toLowerCase();
  if (name === q) {
    return 100;
  }
  if (name.includes(q)) {
    return 70;
  }
  const basename = basenameWithoutExt(symbol.path).toLowerCase();
  let score = basename.includes(q) ? 20 : 0;
  const queryParts = q.split(/[^a-z0-9_$-]+/).filter(Boolean);
  for (const part of queryParts) {
    if (name.includes(part)) {
      score += 15;
    }
  }
  if (score > 0 && (symbol.kind === "tool" || symbol.kind === "route")) {
    score += 5;
  }
  return score;
}

export async function findSymbol(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const query = stringArg(args, "symbol_name") || stringArg(args, "query");
  if (!query) {
    throw new Error("symbol_name or query is required");
  }
  const maxResults = Math.min(numberArg(args, "max_results") || 20, 100);
  const index = await loadOrBuildIndex(config, args);
  const matches = index.symbols
    .map((symbol) => ({ ...symbol, score: symbolScore(symbol, query) }))
    .filter((symbol) => symbol.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, maxResults);
  const result = {
    schema_version: "language-graph-symbol-search.v1",
    query_hash: stableHash(query),
    result_count: matches.length,
    symbols: matches,
  };
  const compactTokens = estimateTokens(JSON.stringify(result));
  const rawTokens = estimateFilesAsTokens(
    index,
    matches.map((item) => item.path),
  );
  return {
    ...result,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

export async function findReferences(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const symbolName = stringArg(args, "symbol_name");
  if (!symbolName) {
    throw new Error("symbol_name is required");
  }
  const maxResults = Math.min(numberArg(args, "max_results") || 80, 300);
  const index = await loadOrBuildIndex(config, args);
  const definitions = index.symbols.filter((symbol) => symbol.name === symbolName).slice(0, 40);
  const references = index.references
    .filter((reference) => reference.symbol === symbolName)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, maxResults);
  const byFile = references.reduce<Record<string, number>>((acc, reference) => {
    acc[reference.path] = (acc[reference.path] || 0) + 1;
    return acc;
  }, {});
  const result = {
    schema_version: "language-graph-references.v1",
    symbol_name: symbolName,
    definitions,
    references,
    files: Object.entries(byFile)
      .map(([file, count]) => ({ path: file, reference_count: count }))
      .sort((a, b) => b.reference_count - a.reference_count || a.path.localeCompare(b.path)),
    definition_count: definitions.length,
    references_returned: references.length,
  };
  const compactTokens = estimateTokens(JSON.stringify(result));
  const rawTokens = estimateFilesAsTokens(index, [
    ...definitions.map((item) => item.path),
    ...references.map((item) => item.path),
  ]);
  return {
    ...result,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

export async function getImportNeighbors(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const root = repoRootFromArgs(args);
  const filePath = stringArg(args, "file_path");
  if (!filePath) {
    throw new Error("file_path is required");
  }
  const maxResults = Math.min(numberArg(args, "max_results") || 80, 300);
  const index = await loadOrBuildIndex(config, args);
  const relativePath = safeRelativePath(root, filePath);
  const imports = index.imports.filter((edge) => edge.path === relativePath).slice(0, maxResults);
  const importers = index.imports.filter((edge) => edge.resolved_path === relativePath).slice(0, maxResults);
  const result = {
    schema_version: "language-graph-import-neighbors.v1",
    path: relativePath,
    imports,
    importers,
    import_count: imports.length,
    importer_count: importers.length,
  };
  const compactTokens = estimateTokens(JSON.stringify(result));
  const rawTokens = estimateFilesAsTokens(index, [
    relativePath,
    ...imports.flatMap((edge) => (edge.resolved_path ? [edge.resolved_path] : [])),
    ...importers.map((edge) => edge.path),
  ]);
  return {
    ...result,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

export async function getBlastRadius(config: LanguageGraphConfig, args: Record<string, unknown>) {
  const root = repoRootFromArgs(args);
  const index = await loadOrBuildIndex(config, args);
  const filePath = stringArg(args, "file_path");
  const symbolName = stringArg(args, "symbol_name");
  const files = new Set<string>();
  const reasons: Record<string, string[]> = {};

  function addFile(relativePath: string, reason: string) {
    files.add(relativePath);
    reasons[relativePath] = reasons[relativePath] || [];
    if (!reasons[relativePath].includes(reason)) {
      reasons[relativePath].push(reason);
    }
  }

  if (filePath) {
    const relativePath = safeRelativePath(root, filePath);
    addFile(relativePath, "target file");
    for (const edge of index.imports.filter((candidate) => candidate.resolved_path === relativePath)) {
      addFile(edge.path, "imports target");
    }
    const exportedSymbols = index.symbols
      .filter((symbol) => symbol.path === relativePath && CODE_SYMBOL_KINDS.has(symbol.kind))
      .map((symbol) => symbol.name);
    for (const reference of index.references.filter((candidate) => exportedSymbols.includes(candidate.symbol))) {
      addFile(reference.path, `references ${reference.symbol}`);
    }
  }

  if (symbolName) {
    for (const definition of index.symbols.filter((symbol) => symbol.name === symbolName)) {
      addFile(definition.path, "defines symbol");
    }
    for (const reference of index.references.filter((candidate) => candidate.symbol === symbolName)) {
      addFile(reference.path, "references symbol");
    }
  }

  if (!filePath && !symbolName) {
    throw new Error("file_path or symbol_name is required");
  }

  const resultFiles = Array.from(files)
    .sort()
    .slice(0, Math.min(numberArg(args, "max_results") || 120, 500))
    .map((relativePath) => ({
      path: relativePath,
      reasons: reasons[relativePath] || [],
      symbol_count: index.files[relativePath]?.symbol_count || 0,
      import_count: index.files[relativePath]?.import_count || 0,
    }));
  const result = {
    schema_version: "language-graph-blast-radius.v1",
    target: {
      file_path: filePath ? safeRelativePath(root, filePath) : undefined,
      symbol_name: symbolName,
    },
    files: resultFiles,
    blast_radius_files: resultFiles.length,
  };
  const compactTokens = estimateTokens(JSON.stringify(result));
  const rawTokens = estimateFilesAsTokens(
    index,
    resultFiles.map((item) => item.path),
  );
  return {
    ...result,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
  };
}

export function graphArgs(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}
