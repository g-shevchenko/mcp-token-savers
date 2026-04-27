import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  RETRIEVAL_PIPELINE_VERSION,
  RETRIEVAL_SCHEMA_VERSION,
  RetrievalConfig,
} from "./config.js";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import {
  commandUnavailableWarning,
  isMissingCommandError,
  resolveLocalCommand,
} from "./command-utils.js";
import {
  buildPathPolicy,
  classifyFilteredPath,
  displayPath,
  PathPolicy,
} from "./path-policy.js";
import { clampText, unique } from "./text-utils.js";
import { estimateTokens, savingsPct } from "./token-estimates.js";
import {
  buildSymbolContext,
  extractSymbolMap,
  SymbolScan,
  symbolMatchScore,
} from "./symbol-map.js";
import { buildRepoMap } from "./repo-map.js";

const execFileAsync = promisify(execFile);

export type TaskIntent = "bug_fix" | "implementation" | "review" | "explain" | "test" | "docs" | "unknown";

export interface RetrievalMetadata {
  branch?: string;
  commit_sha?: string;
  owner?: string;
  project?: string;
  repo?: string;
  session_id?: string;
  source?: string;
  surface?: string;
}

export interface RetrievalContextHints {
  changed_files_override?: string[];
  diagnostic_files?: string[];
  open_files?: string[];
  recent_files?: string[];
  selected_paths?: string[];
}

export interface RetrieveContextOptions {
  context_hints?: RetrievalContextHints;
  exclude_globs?: string[];
  git_context?: boolean;
  include_globs?: string[];
  include_repo_map?: boolean;
  include_tests?: boolean;
  max_chars?: number;
  max_files?: number;
  max_snippets?: number;
  metadata?: RetrievalMetadata;
  repo_map_max_chars?: number;
  root_path?: string;
  task_intent?: TaskIntent;
}

export interface FindFilesOptions {
  context_hints?: RetrievalContextHints;
  exclude_globs?: string[];
  include_globs?: string[];
  max_files?: number;
  metadata?: RetrievalMetadata;
  root_path?: string;
}

interface CommandResult {
  stderr: string;
  stdout: string;
  truncated: boolean;
  warnings: string[];
}

interface FileScore {
  extension: string;
  lineMatches: Map<number, string>;
  matchSources: Set<string>;
  path: string;
  reasons: Set<string>;
  score: number;
  sizeBytes?: number;
}

interface Snippet {
  end_line: number;
  path: string;
  reason: string;
  score: number;
  start_line: number;
  text: string;
}

interface FilteredHit {
  path: string;
  reason: string;
  stage: "context-hints" | "list-files" | "search-lines" | "related-files";
}

interface RetrievalDiagnostics {
  contextHints: ContextHintDiagnostics;
  filteredHits: FilteredHit[];
  pathPolicy: PathPolicy;
  queryPlans: QueryPlanSummary[];
  topExtensions: Record<string, number>;
  truncated: boolean;
  warnings: string[];
}

type SymbolContext = ReturnType<typeof buildSymbolContext>;

interface QueryPlan {
  boost: number;
  name: string;
  terms: string[];
}

interface QueryPlanSummary {
  boost: number;
  name: string;
  terms_count: number;
}

interface SearchLineResult {
  filteredHits: FilteredHit[];
  matches: Map<string, Map<number, string>>;
  matchSources: Map<string, Set<string>>;
  queryPlans: QueryPlanSummary[];
  truncated: boolean;
  warnings: string[];
}

type ContextHintKind = keyof RetrievalContextHints;

interface ContextHintScore {
  boost: number;
  kinds: ContextHintKind[];
  path: string;
}

interface ContextHintDiagnostics {
  applied: Array<{ boost: number; kinds: ContextHintKind[]; path: string }>;
  applied_counts: Record<string, number>;
  ignored_sample: Array<{ kind: ContextHintKind; path: string; reason: string }>;
  provided_counts: Record<string, number>;
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".php",
  ".rb",
  ".cs",
  ".swift",
  ".vue",
  ".svelte",
  ".astro",
  ".sql",
  ".sh",
  ".yaml",
  ".yml",
  ".json",
  ".md",
  ".mdx",
]);

function toNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitIdentifier(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function queryTermVariants(raw: string): string[] {
  const lower = raw.toLowerCase();
  const variants = new Set([raw]);
  if (/^[a-z]+$/.test(lower)) {
    if (lower.endsWith("ing") && lower.length > 5) {
      const stem = lower.slice(0, -3);
      variants.add(stem);
      if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
        variants.add(stem.slice(0, -1));
      }
    }
    if (lower.endsWith("er") && lower.length > 5) {
      variants.add(lower.slice(0, -2));
    }
    if (lower.endsWith("ies") && lower.length > 5) {
      variants.add(`${lower.slice(0, -3)}y`);
    }
    if (lower.endsWith("s") && lower.length > 4) {
      variants.add(lower.slice(0, -1));
    }
  }
  return Array.from(variants).filter((term) => term.length >= 2);
}

function queryTerms(query: string): string[] {
  const exactish = query.match(/[A-Za-z_$][A-Za-z0-9_$:./-]{2,}|[\u0400-\u04ff]{3,}/g) || [];
  const expanded = exactish.flatMap((term) => [term, ...splitIdentifier(term)]);
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_\u0400-\u04ff]+/i)
    .filter((part) => part.length >= 3);

  return unique([...expanded, ...words])
    .flatMap(queryTermVariants)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 24);
}

function camelCase(parts: string[], pascal = false): string {
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (index === 0 && !pascal) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

const PATH_BOOST_STOP_WORDS = new Set([
  "where",
  "what",
  "when",
  "which",
  "does",
  "with",
  "from",
  "into",
  "file",
  "code",
  "implemented",
  "implementation",
  "documented",
  "documents",
  "rules",
  "cursor",
  "claude",
]);

function importantPathTerms(terms: string[]): string[] {
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 4 && !PATH_BOOST_STOP_WORDS.has(term));
}

function quotedPhrases(query: string): string[] {
  const phrases: string[] = [];
  const pattern = /["'`]([^"'`]{4,80})["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query))) {
    phrases.push(match[1].trim());
  }
  return unique(phrases).slice(0, 6);
}

function compoundTermVariants(terms: string[]): string[] {
  const important = importantPathTerms(terms).slice(0, 10);
  const variants: string[] = [];

  for (let index = 0; index < important.length - 1; index += 1) {
    const pair = [important[index], important[index + 1]];
    variants.push(pair.join("-"), pair.join("_"), camelCase(pair), camelCase(pair, true));
  }

  return unique(variants).slice(0, 24);
}

function domainTermExpansions(terms: string[], intent: TaskIntent): string[] {
  const lower = new Set(terms.map((term) => term.toLowerCase()));
  const expansions: string[] = [];

  if (lower.has("mcp")) {
    expansions.push("tools/list", "CallToolRequestSchema");
  }
  if (lower.has("api") || lower.has("route") || lower.has("endpoint")) {
    expansions.push("/api/", "route", "endpoint");
  }
  if (lower.has("screenshot") || lower.has("screenshots")) {
    expansions.push("prepare_screenshot", "vision-mcp", "image_urls_for_model");
  }
  if (lower.has("retrieval") || lower.has("retrieve")) {
    expansions.push("retrieve_context", "find_files", "raw_search");
  }
  if (lower.has("context") && (lower.has("prep") || lower.has("prepare"))) {
    expansions.push("prep_logs", "prep_url", "prep_text", "context-prep-mcp");
  }
  if (intent === "test") {
    expansions.push(".test.", ".spec.", "describe(", "it(");
  }

  return unique(expansions).slice(0, 18);
}

function codeLikeTerms(terms: string[]): string[] {
  return terms
    .filter((term) => /[_:./-]|[a-z][A-Z]/.test(term))
    .filter((term) => term.length >= 4)
    .slice(0, 18);
}

function buildQueryPlans(query: string, terms: string[], intent: TaskIntent): QueryPlan[] {
  const plans: QueryPlan[] = [];
  const addPlan = (name: string, planTerms: string[], boost: number) => {
    const normalized = unique(planTerms.map((term) => term.trim()).filter((term) => term.length >= 2)).slice(0, 18);
    if (normalized.length > 0 && !plans.some((plan) => plan.name === name)) {
      plans.push({ name, terms: normalized, boost });
    }
  };

  addPlan("lexical", terms.slice(0, 18), 0);
  addPlan(
    "expanded-variants",
    [...compoundTermVariants(terms), ...codeLikeTerms(terms), ...domainTermExpansions(terms, intent)],
    6,
  );
  addPlan("quoted-phrases", quotedPhrases(query), 8);

  return plans.slice(0, 3);
}

function appendRgGlobs(args: string[], pathPolicy: PathPolicy): void {
  for (const glob of pathPolicy.rgGlobs) {
    args.push("--glob", glob);
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  config: RetrievalConfig,
): Promise<CommandResult> {
  try {
    const executable = resolveLocalCommand(command, cwd);
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd,
      maxBuffer: config.maxRipgrepBufferBytes,
      timeout: config.commandTimeoutMs,
    });
    return { stdout, stderr, truncated: false, warnings: [] };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error || "");
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      message.includes("stdout maxBuffer")
    ) {
      return {
        stdout,
        stderr: `${stderr}\n${command} output exceeded maxBuffer; using partial output`.trim(),
        truncated: true,
        warnings: [`${command} output exceeded maxBuffer; using partial output`],
      };
    }
    if (error?.code === 1 && typeof error.stdout === "string") {
      return { stdout: error.stdout, stderr: error.stderr || "", truncated: false, warnings: [] };
    }
    if (isMissingCommandError(error, command)) {
      const warning = commandUnavailableWarning(command);
      return {
        stdout,
        stderr: `${stderr}\n${warning}`.trim(),
        truncated: false,
        warnings: [warning],
      };
    }
    throw error;
  }
}

async function resolveRoot(rootPath: string | undefined, config: RetrievalConfig): Promise<string> {
  const candidate = path.resolve(rootPath || config.defaultRoot);
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`root_path is not a directory: ${candidate}`);
  }
  return resolved;
}

async function listFiles(
  root: string,
  config: RetrievalConfig,
  pathPolicy: PathPolicy,
): Promise<{ files: string[]; filteredHits: FilteredHit[]; truncated: boolean; warnings: string[] }> {
  const args = ["--files", "--hidden"];
  appendRgGlobs(args, pathPolicy);

  const { stdout, truncated, warnings } = await runCommand("rg", args, root, config);
  const files: string[] = [];
  const filteredHits: FilteredHit[] = [];
  for (const rawLine of stdout.split("\n")) {
    const file = rawLine.trim();
    if (!file) {
      continue;
    }
    const reason = classifyFilteredPath(file);
    if (reason) {
      filteredHits.push({ path: displayPath(file), reason, stage: "list-files" });
      continue;
    }
    files.push(file);
  }

  return { files, filteredHits, truncated, warnings };
}

async function gitChangedFiles(root: string, config: RetrievalConfig): Promise<Set<string>> {
  try {
    const { stdout } = await runCommand("git", ["status", "--short"], root, config);
    return new Set(
      stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .map((file) => file.replace(/\\/g, "/")),
    );
  } catch {
    return new Set();
  }
}

async function searchLines(
  root: string,
  config: RetrievalConfig,
  query: string,
  terms: string[],
  intent: TaskIntent,
  pathPolicy: PathPolicy,
): Promise<SearchLineResult> {
  const matches = new Map<string, Map<number, string>>();
  const matchSources = new Map<string, Set<string>>();
  const filteredHits: FilteredHit[] = [];
  const queryPlans = buildQueryPlans(query, terms, intent);
  if (queryPlans.length === 0) {
    return { matches, matchSources, queryPlans: [], filteredHits, truncated: false, warnings: [] };
  }

  const searchResults = await Promise.all(
    queryPlans.map(async (plan) => {
      const pattern = plan.terms.map(escapeRegex).join("|");
      const args = [
        "--json",
        "--hidden",
        "--ignore-case",
        "--line-number",
        "--max-count",
        "12",
        "--max-filesize",
        `${Math.ceil(config.maxFileBytes / 1024)}K`,
      ];

      appendRgGlobs(args, pathPolicy);
      args.push(pattern, ".");

      const result = await runCommand("rg", args, root, config);
      return { plan, ...result };
    }),
  );

  for (const result of searchResults) {
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        if (event.type !== "match") {
          continue;
        }

        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const text = event.data?.lines?.text;
        const normalizedFilePath = typeof filePath === "string" ? displayPath(filePath) : "";
        if (
          !normalizedFilePath ||
          typeof lineNumber !== "number" ||
          typeof text !== "string"
        ) {
          continue;
        }
        const filteredReason = classifyFilteredPath(normalizedFilePath);
        if (filteredReason) {
          filteredHits.push({
            path: normalizedFilePath,
            reason: filteredReason,
            stage: "search-lines",
          });
          continue;
        }

        if (!matches.has(normalizedFilePath)) {
          matches.set(normalizedFilePath, new Map());
        }
        matches.get(normalizedFilePath)!.set(lineNumber, text.replace(/\n$/, ""));
        if (!matchSources.has(normalizedFilePath)) {
          matchSources.set(normalizedFilePath, new Set());
        }
        matchSources.get(normalizedFilePath)!.add(result.plan.name);
      } catch {
        // Ignore malformed rg event lines; rg JSON can include diagnostics.
      }
    }
  }

  return {
    matches,
    matchSources,
    queryPlans: queryPlans.map((plan) => ({
      name: plan.name,
      terms_count: plan.terms.length,
      boost: plan.boost,
    })),
    filteredHits,
    truncated: searchResults.some((result) => result.truncated),
    warnings: unique(searchResults.flatMap((result) => result.warnings)),
  };
}

function pathScore(relativePath: string, terms: string[], intent: TaskIntent): { score: number; reasons: string[] } {
  const normalized = relativePath.toLowerCase();
  const base = path.basename(normalized);
  const reasons: string[] = [];
  let score = 0;
  const importantTerms = importantPathTerms(terms);

  for (const term of terms) {
    const lower = term.toLowerCase();
    if (base.includes(lower)) {
      score += 12;
      reasons.push(`filename contains "${term}"`);
    } else if (normalized.includes(lower)) {
      score += 6;
      reasons.push(`path contains "${term}"`);
    }
  }

  if (CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    score += 2;
  }

  const isTest = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[tj]sx?$/.test(normalized);
  if (isTest && intent === "test") {
    score += 12;
    reasons.push("test file boosted by task intent");
  } else if (isTest) {
    score -= 1;
  }

  if (intent === "docs" && /\.(md|mdx|txt)$/i.test(relativePath)) {
    score += 10;
    reasons.push("docs file boosted by task intent");
  }

  if (/\/(rules|skills)\//.test(normalized)) {
    for (const term of importantTerms) {
      if (base.includes(term)) {
        score += 24;
        reasons.push(`agent rule/skill filename matches "${term}"`);
      }
    }
  }

  return { score, reasons };
}

function topExtensionCounts(files: string[], limit = 8): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || "[none]";
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  return Object.fromEntries(
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit),
  );
}

function filteredCounts(filteredHits: FilteredHit[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const hit of filteredHits) {
    counts.set(hit.reason, (counts.get(hit.reason) || 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => b[1] - a[1]));
}

const CONTEXT_HINT_BOOSTS: Record<ContextHintKind, number> = {
  selected_paths: 90,
  diagnostic_files: 70,
  changed_files_override: 60,
  open_files: 32,
  recent_files: 18,
};

function normalizeHintPath(root: string, rawPath: string): { path?: string; reason?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { reason: "empty hint path" };
  }

  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const relative = displayPath(path.relative(root, absolute));
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return { reason: "outside root" };
  }
  return { path: relative };
}

function addCount(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] || 0) + amount;
}

function buildContextHintScores(
  root: string,
  fileSet: Set<string>,
  hints?: RetrievalContextHints,
): { diagnostics: ContextHintDiagnostics; filteredHits: FilteredHit[]; hintScores: Map<string, ContextHintScore> } {
  const appliedCounts: Record<string, number> = {};
  const filteredHits: FilteredHit[] = [];
  const hintScores = new Map<string, ContextHintScore>();
  const ignored: ContextHintDiagnostics["ignored_sample"] = [];
  const providedCounts: Record<string, number> = {};

  if (!hints) {
    return {
      hintScores,
      filteredHits,
      diagnostics: {
        applied: [],
        applied_counts: appliedCounts,
        ignored_sample: ignored,
        provided_counts: providedCounts,
      },
    };
  }

  for (const kind of Object.keys(CONTEXT_HINT_BOOSTS) as ContextHintKind[]) {
    const rawPaths = Array.isArray(hints[kind]) ? hints[kind] || [] : [];
    providedCounts[kind] = rawPaths.length;
    for (const rawPath of rawPaths.slice(0, 50)) {
      if (typeof rawPath !== "string") {
        continue;
      }

      const normalized = normalizeHintPath(root, rawPath);
      const candidatePath = normalized.path || displayPath(rawPath);
      let ignoredReason = normalized.reason;
      if (!ignoredReason && normalized.path) {
        ignoredReason = classifyFilteredPath(normalized.path) || undefined;
      }
      if (!ignoredReason && normalized.path && !fileSet.has(normalized.path)) {
        ignoredReason = "not in path policy or file listing";
      }

      if (ignoredReason || !normalized.path) {
        if (ignored.length < 20) {
          ignored.push({ kind, path: candidatePath, reason: ignoredReason || "invalid hint path" });
        }
        filteredHits.push({
          path: candidatePath,
          reason: `context-hint-${ignoredReason || "invalid"}`,
          stage: "context-hints",
        });
        continue;
      }

      const boost = CONTEXT_HINT_BOOSTS[kind];
      const existing = hintScores.get(normalized.path) || {
        path: normalized.path,
        kinds: [],
        boost: 0,
      };
      if (!existing.kinds.includes(kind)) {
        existing.kinds.push(kind);
        existing.boost = Math.min(120, existing.boost + boost);
      }
      hintScores.set(normalized.path, existing);
      addCount(appliedCounts, kind);
    }
  }

  const applied = Array.from(hintScores.values())
    .sort((a, b) => b.boost - a.boost || a.path.localeCompare(b.path))
    .slice(0, 20)
    .map((hint) => ({
      path: displayPath(hint.path),
      kinds: hint.kinds,
      boost: hint.boost,
    }));

  return {
    hintScores,
    filteredHits,
    diagnostics: {
      applied,
      applied_counts: appliedCounts,
      ignored_sample: ignored,
      provided_counts: providedCounts,
    },
  };
}

async function scoreFiles(
  root: string,
  config: RetrievalConfig,
  query: string,
  options: RetrieveContextOptions | FindFilesOptions,
): Promise<{
  changedFiles: Set<string>;
  diagnostics: RetrievalDiagnostics;
  files: FileScore[];
  filesConsidered: number;
  terms: string[];
}> {
  const terms = queryTerms(query);
  const intent = ("task_intent" in options ? options.task_intent : undefined) || "unknown";
  const includeTests = !("include_tests" in options) || options.include_tests !== false;
  const pathPolicy = await buildPathPolicy(root, options.include_globs, options.exclude_globs, includeTests);
  const [fileListing, lineSearch, changedFiles] = await Promise.all([
    listFiles(root, config, pathPolicy),
    searchLines(root, config, query, terms, intent, pathPolicy),
    "git_context" in options && options.git_context === false
      ? Promise.resolve(new Set<string>())
      : gitChangedFiles(root, config),
  ]);
  const hintResult = buildContextHintScores(root, new Set(fileListing.files), options.context_hints);
  for (const [hintedPath, hint] of hintResult.hintScores.entries()) {
    if (hint.kinds.includes("changed_files_override")) {
      changedFiles.add(hintedPath);
    }
  }

  const byPath = new Map<string, FileScore>();
  for (const file of fileListing.files) {
    const { score, reasons } = pathScore(file, terms, intent);
    if (score > 0) {
      byPath.set(file, {
        extension: path.extname(file).toLowerCase(),
        lineMatches: new Map(),
        matchSources: new Set(),
        path: file,
        reasons: new Set(reasons),
        score,
      });
    }
  }

  for (const [file, lineMatches] of lineSearch.matches.entries()) {
    const existing =
      byPath.get(file) ||
      ({
        extension: path.extname(file).toLowerCase(),
        lineMatches: new Map(),
        matchSources: new Set(),
        path: file,
        reasons: new Set<string>(),
        score: 0,
      } satisfies FileScore);

    existing.score += Math.min(80, lineMatches.size * 10);
    existing.lineMatches = lineMatches;
    existing.matchSources = lineSearch.matchSources.get(file) || new Set();
    const planBoost = Array.from(existing.matchSources).reduce((sum, source) => {
      const plan = lineSearch.queryPlans.find((item) => item.name === source);
      return sum + (plan?.boost || 0);
    }, 0);
    existing.score += Math.min(24, planBoost);
    existing.reasons.add(`${lineMatches.size} content match${lineMatches.size === 1 ? "" : "es"}`);
    if (existing.matchSources.size > 0) {
      existing.reasons.add(`matched query plans: ${Array.from(existing.matchSources).join(", ")}`);
    }
    byPath.set(file, existing);
  }

  for (const [hintedPath, hint] of hintResult.hintScores.entries()) {
    const existing =
      byPath.get(hintedPath) ||
      ({
        extension: path.extname(hintedPath).toLowerCase(),
        lineMatches: new Map(),
        matchSources: new Set(),
        path: hintedPath,
        reasons: new Set<string>(),
        score: CODE_EXTENSIONS.has(path.extname(hintedPath).toLowerCase()) ? 2 : 0,
      } satisfies FileScore);

    existing.score += hint.boost;
    existing.reasons.add(`context hint: ${hint.kinds.join(", ")}`);
    byPath.set(hintedPath, existing);
  }

  for (const changed of changedFiles) {
    const normalized = changed.replace(/\\/g, "/");
    const existing = byPath.get(normalized);
    if (existing) {
      existing.score += 8;
      existing.reasons.add("changed in current git worktree");
    }
  }

  const scored = Array.from(byPath.values()).filter((file) => file.score > 0);
  const symbolCandidates = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 200)
    .map((file) => file.path);
  const symbolScans = await extractSymbolMap(root, symbolCandidates, config.maxFileBytes);
  for (const [filePath, scan] of symbolScans.entries()) {
    const existing = byPath.get(filePath);
    if (!existing) {
      continue;
    }
    const symbolScore = symbolMatchScore(scan, terms);
    if (symbolScore.score > 0) {
      existing.score += symbolScore.score;
      for (const reason of symbolScore.reasons) {
        existing.reasons.add(reason);
      }
    }
  }

  const rescored = Array.from(byPath.values()).filter((file) => file.score > 0);
  await Promise.all(
    rescored.slice(0, 80).map(async (file) => {
      try {
        const info = await stat(path.join(root, file.path));
        file.sizeBytes = info.size;
        if (info.size > config.maxFileBytes) {
          file.score -= 6;
          file.reasons.add("large file partially skipped");
        }
      } catch {
        file.score -= 20;
      }
    }),
  );

  rescored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const topExtensions = topExtensionCounts(fileListing.files);
  const warnings = unique([...pathPolicy.warnings, ...fileListing.warnings, ...lineSearch.warnings]);
  return {
    files: rescored,
    filesConsidered: fileListing.files.length,
    terms,
    changedFiles,
    diagnostics: {
      contextHints: hintResult.diagnostics,
      filteredHits: [...fileListing.filteredHits, ...lineSearch.filteredHits, ...hintResult.filteredHits],
      pathPolicy,
      queryPlans: lineSearch.queryPlans,
      topExtensions,
      truncated: fileListing.truncated || lineSearch.truncated,
      warnings,
    },
  };
}

function mergeLineRanges(lines: number[], radius = 3): Array<[number, number]> {
  const sorted = unique(lines).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const line of sorted) {
    const start = Math.max(1, line - radius);
    const end = line + radius;
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

async function readFileLines(root: string, relativePath: string, config: RetrievalConfig): Promise<string[] | null> {
  if (classifyFilteredPath(relativePath)) {
    return null;
  }

  const absolute = path.join(root, relativePath);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > config.maxFileBytes) {
    return null;
  }

  const buffer = await readFile(absolute);
  if (buffer.includes(0)) {
    return null;
  }
  return buffer.toString("utf8").split(/\r?\n/);
}

async function buildSnippets(
  root: string,
  config: RetrievalConfig,
  scoredFiles: FileScore[],
  maxSnippets: number,
  symbolScans: Map<string, SymbolScan>,
  terms: string[],
  intent: TaskIntent,
): Promise<Snippet[]> {
  const snippets: Snippet[] = [];
  const implementationLike =
    intent === "implementation" || intent === "bug_fix" || intent === "review" || intent === "test";
  const identifierTerms = exactIdentifierTerms(terms);
  const prioritizedFiles = scoredFiles.slice().sort((left, right) => {
    if (!implementationLike || identifierTerms.length === 0) {
      return 0;
    }

    const leftDefinitionMatches = definitionMatchLines(symbolScans.get(left.path), identifierTerms).length;
    const rightDefinitionMatches = definitionMatchLines(symbolScans.get(right.path), identifierTerms).length;
    const leftTier = snippetPriorityTier(left, leftDefinitionMatches > 0);
    const rightTier = snippetPriorityTier(right, rightDefinitionMatches > 0);
    if (leftTier !== rightTier) {
      return leftTier - rightTier;
    }
    return 0;
  });

  for (const file of prioritizedFiles) {
    if (snippets.length >= maxSnippets) {
      break;
    }

    const lines = await readFileLines(root, file.path, config);
    if (!lines) {
      continue;
    }

    const preferredDefinitionLines = definitionMatchLines(symbolScans.get(file.path), identifierTerms);
    const ranges = selectSnippetRanges(
      file,
      lines.length,
      preferredDefinitionLines,
      implementationLike,
    );

    for (const [start, end] of ranges) {
      if (snippets.length >= maxSnippets) {
        break;
      }
      const body = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(4, " ")} | ${line}`)
        .join("\n");

      snippets.push({
        path: displayPath(file.path),
        start_line: start,
        end_line: Math.min(end, lines.length),
        score: file.score,
        reason: Array.from(file.reasons).slice(0, 4).join("; "),
        text: body,
      });
    }
  }

  return snippets;
}

function rangesOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

function definitionMatchLines(scan: SymbolScan | undefined, identifierTerms: string[]): number[] {
  if (!scan || identifierTerms.length === 0) {
    return [];
  }

  const exact: number[] = [];
  const partial: number[] = [];

  for (const symbol of scan.symbols) {
    const lowerName = symbol.name.toLowerCase();
    for (const term of identifierTerms) {
      if (lowerName === term) {
        exact.push(symbol.line);
        break;
      }
      if (lowerName.includes(term)) {
        partial.push(symbol.line);
        break;
      }
    }
  }

  return unique([...exact, ...partial]).slice(0, 3);
}

function exactIdentifierTerms(terms: string[]): string[] {
  return unique(
    terms
      .filter((term) => /[_:./-]|[a-z0-9][A-Z]/.test(term))
      .filter((term) => term.length >= 4)
      .map((term) => term.toLowerCase()),
  ).slice(0, 6);
}

function isDocLikeSnippetFile(file: FileScore): boolean {
  return [".md", ".mdx", ".txt"].includes(file.extension);
}

function snippetPriorityTier(file: FileScore, hasDefinitionMatch: boolean): number {
  if (hasDefinitionMatch) {
    return 0;
  }
  if (CODE_EXTENSIONS.has(file.extension) && !isDocLikeSnippetFile(file)) {
    return 1;
  }
  if (isDocLikeSnippetFile(file)) {
    return 3;
  }
  return 2;
}

function selectSnippetRanges(
  file: FileScore,
  lineCount: number,
  preferredDefinitionLines: number[],
  implementationLike: boolean,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fallbackRanges =
    file.lineMatches.size > 0
      ? mergeLineRanges(Array.from(file.lineMatches.keys())).slice(0, 3)
      : ([[1, Math.min(40, lineCount)]] as Array<[number, number]>);

  if (preferredDefinitionLines.length > 0) {
    ranges.push(...mergeLineRanges(preferredDefinitionLines).slice(0, 2));
  }

  const perFileLimit =
    preferredDefinitionLines.length > 0
      ? 2
      : implementationLike && isDocLikeSnippetFile(file)
        ? 1
        : 3;

  for (const range of fallbackRanges) {
    if (ranges.length >= perFileLimit) {
      break;
    }
    if (ranges.some((existing) => rangesOverlap(existing, range))) {
      continue;
    }
    ranges.push(range);
  }

  return ranges.slice(0, perFileLimit);
}

async function findRelatedFiles(
  root: string,
  config: RetrievalConfig,
  topFiles: FileScore[],
  allFiles: FileScore[],
  pathPolicy: PathPolicy,
): Promise<Array<{ path: string; reason: string }>> {
  const related = new Map<string, string>();
  const allPaths = allFiles.map((file) => file.path);

  for (const file of topFiles.slice(0, 8)) {
    const parsed = path.parse(file.path);
    const normalizedDir = parsed.dir.replace(/\\/g, "/");
    const baseWithoutTest = parsed.name.replace(/\.(test|spec)$/i, "");
    const counterpartPatterns = [
      `${normalizedDir}/${baseWithoutTest}.test`,
      `${normalizedDir}/${baseWithoutTest}.spec`,
      `${normalizedDir}/__tests__/${baseWithoutTest}`,
    ].map((item) => item.toLowerCase());

    for (const candidate of allPaths) {
      const lower = candidate.toLowerCase();
      if (candidate !== file.path && counterpartPatterns.some((pattern) => lower.includes(pattern))) {
        related.set(candidate, `test/spec counterpart for ${file.path}`);
      }
    }
  }

  const importTargets = topFiles
    .slice(0, 5)
    .map((file) => path.basename(file.path, path.extname(file.path)))
    .filter((name) => name.length >= 4);

  for (const target of importTargets) {
    try {
      const { stdout } = await runCommand(
        "rg",
        [
          "--files-with-matches",
          "--hidden",
          "--ignore-case",
          "--max-count",
          "5",
          ...pathPolicy.rgGlobs.flatMap((glob) => ["--glob", glob]),
          escapeRegex(target),
          ".",
        ],
        root,
        config,
      );
      for (const file of stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8)) {
        const normalized = displayPath(file);
        if (
          !classifyFilteredPath(normalized) &&
          !topFiles.some((top) => top.path === normalized)
        ) {
          related.set(normalized, `mentions/imports "${target}"`);
        }
      }
    } catch {
      // Related-file hints are best-effort only.
    }
  }

  return Array.from(related.entries())
    .slice(0, 20)
    .map(([relatedPath, reason]) => ({ path: displayPath(relatedPath), reason }));
}

function compactContext(
  query: string,
  snippets: Snippet[],
  related: Array<{ path: string; reason: string }>,
  symbols?: SymbolContext,
  identifierTerms: string[] = [],
): string {
  const symbolDefinitions = selectCompactDefinitions(symbols, identifierTerms);
  const parts = [
    `# Retrieval Context`,
    ``,
    `Query: ${query}`,
    ``,
    `## Ranked snippets`,
  ];

  for (const snippet of snippets) {
    parts.push(
      ``,
      `### ${snippet.path}:${snippet.start_line}`,
      `Reason: ${snippet.reason}`,
      "```",
      snippet.text,
      "```",
    );
  }

  if (related.length > 0) {
    parts.push("", "## Related files");
    for (const item of related.slice(0, 12)) {
      parts.push(`- ${item.path} — ${item.reason}`);
    }
  }

  if (symbols && (symbolDefinitions.length > 0 || symbols.test_counterparts.length > 0)) {
    parts.push("", "## Symbol map");
    for (const symbol of symbolDefinitions) {
      parts.push(`- ${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}`);
    }
    for (const item of symbols.test_counterparts.slice(0, 6)) {
      parts.push(`- ${item.path} — ${item.reason}`);
    }
  }

  return parts.join("\n");
}

function selectCompactDefinitions(
  symbols: SymbolContext | undefined,
  identifierTerms: string[],
) {
  if (!symbols) {
    return [];
  }

  if (identifierTerms.length === 0) {
    return symbols.definitions.slice(0, 12);
  }

  const exact: typeof symbols.definitions = [];
  const partial: typeof symbols.definitions = [];
  for (const symbol of symbols.definitions) {
    const lowerName = symbol.name.toLowerCase();
    if (identifierTerms.some((term) => lowerName === term)) {
      exact.push(symbol);
      continue;
    }
    if (identifierTerms.some((term) => lowerName.includes(term))) {
      partial.push(symbol);
    }
  }

  const narrowed = [...exact, ...partial];
  return (narrowed.length > 0 ? narrowed : symbols.definitions).slice(0, 6);
}

function confidence(files: FileScore[], snippets: Snippet[]): { uncertainty: number; reasons: string[] } {
  if (snippets.length === 0) {
    return {
      uncertainty: 0.42,
      reasons: ["no code snippets found"],
    };
  }

  const topScore = files[0]?.score || 0;
  const scoreGap = topScore - (files[1]?.score || 0);
  const reasons: string[] = [];
  let uncertainty = 0.08;

  if (topScore >= 60) {
    uncertainty -= 0.03;
    reasons.push("strong top match");
  } else if (topScore < 25) {
    uncertainty += 0.12;
    reasons.push("weak top match");
  }

  if (scoreGap < 8 && files.length > 3) {
    uncertainty += 0.06;
    reasons.push("multiple similarly ranked files");
  }

  if (snippets.length < 3) {
    uncertainty += 0.05;
    reasons.push("few snippets returned");
  }

  return {
    uncertainty: Math.max(0.01, Math.min(0.5, Math.round(uncertainty * 100) / 100)),
    reasons,
  };
}

function qualitySummary(diagnostics: RetrievalDiagnostics) {
  return {
    truncated: diagnostics.truncated,
    warnings: diagnostics.warnings,
    filtered_counts: filteredCounts(diagnostics.filteredHits),
    filtered_hits_sample: diagnostics.filteredHits.slice(0, 20),
    context_hints: diagnostics.contextHints,
    top_extensions: diagnostics.topExtensions,
    path_policy: {
      effective_globs_count: diagnostics.pathPolicy.rgGlobs.length,
      sources: diagnostics.pathPolicy.sources,
    },
    query_plans: diagnostics.queryPlans,
  };
}

function artifactFileName(raw: string): string {
  try {
    return path.basename(new URL(raw).pathname);
  } catch {
    return path.basename(raw);
  }
}

export function artifactNameFromInput(raw: string): string {
  return artifactFileName(raw);
}

function createRetrievalCallId(prefix: "retrieve" | "find"): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

export async function retrieveContext(
  query: string,
  config: RetrievalConfig,
  options: RetrieveContextOptions = {},
) {
  const root = await resolveRoot(options.root_path, config);
  const maxFiles = toNumber(options.max_files, 12, 1, 40);
  const requestedMaxSnippets = toNumber(options.max_snippets, 18, 1, 60);
  const maxChars = toNumber(options.max_chars, 12_000, 2000, 50_000);
  const intent = options.task_intent || "unknown";
  const { files, filesConsidered, terms, changedFiles, diagnostics } = await scoreFiles(
    root,
    config,
    query,
    options,
  );
  const topFiles = files.slice(0, maxFiles);
  const symbolScans = await extractSymbolMap(root, topFiles.map((file) => file.path), config.maxFileBytes);
  const definitionFocusedQuery =
    (intent === "implementation" || intent === "bug_fix" || intent === "review" || intent === "test") &&
    exactIdentifierTerms(terms).length > 0;
  const maxSnippets = definitionFocusedQuery ? Math.min(requestedMaxSnippets, 12) : requestedMaxSnippets;
  const snippets = await buildSnippets(root, config, topFiles, maxSnippets, symbolScans, terms, intent);
  const related = await findRelatedFiles(root, config, topFiles, files, diagnostics.pathPolicy);
  const symbolContext = buildSymbolContext(symbolScans, terms, related);
  const quality = qualitySummary(diagnostics);
  const rawPayload = {
    query,
    root,
    terms,
    files_considered: filesConsidered,
    changed_files: Array.from(changedFiles),
    quality,
    ranked_files: files.slice(0, 80).map((file) => ({
      path: displayPath(file.path),
      score: file.score,
      reasons: Array.from(file.reasons),
      match_lines: Array.from(file.lineMatches.keys()).slice(0, 20),
      size_bytes: file.sizeBytes,
    })),
    snippets,
    related,
    symbols: symbolContext.symbols,
    definitions: symbolContext.definitions,
    import_edges: symbolContext.import_edges,
    test_counterparts: symbolContext.test_counterparts,
  };
  const compact = clampText(
    compactContext(query, snippets, related, symbolContext, exactIdentifierTerms(terms)),
    maxChars,
  );
  const key = stableKey("retrieval", JSON.stringify({ query, root, options, terms }));
  const [rawArtifact, compactArtifact] = await Promise.all([
    persistArtifactJson(config, key, rawPayload),
    persistArtifactText(config, `${key}-compact`, "md", compact),
  ]);
  const rawTokensEstimate = Math.max(
    estimateTokens(JSON.stringify(rawPayload.ranked_files.slice(0, 60))) +
      snippets.reduce((sum, snippet) => sum + estimateTokens(snippet.text), 0),
    estimateTokens(compact),
  );
  const compactTokensEstimate = estimateTokens(compact);
  const conf = confidence(files, snippets);
  const callId = createRetrievalCallId("retrieve");
  const repoMap = options.include_repo_map
    ? await buildRepoMap(config, {
        root_path: root,
        include_globs: options.include_globs,
        exclude_globs: options.exclude_globs,
        include_tests: options.include_tests,
        max_chars: options.repo_map_max_chars || 8_000,
        max_files: Math.max(maxFiles * 8, 80),
      })
    : undefined;

  return {
    schema_version: RETRIEVAL_SCHEMA_VERSION,
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    call_id: callId,
    retrieval_mode: "local-rg",
    query,
    root_path: root,
    input_stats: {
      files_considered: filesConsidered,
      ranked_files_returned: topFiles.length,
      snippets_returned: snippets.length,
      truncated: diagnostics.truncated,
      warnings_count: diagnostics.warnings.length,
      filtered_hits_count: diagnostics.filteredHits.length,
      context_hints_applied_count: diagnostics.contextHints.applied.length,
      raw_tokens_estimate: rawTokensEstimate,
      compact_tokens_estimate: compactTokensEstimate,
      saved_tokens_estimate: Math.max(0, rawTokensEstimate - compactTokensEstimate),
      savings_pct: savingsPct(rawTokensEstimate, compactTokensEstimate),
    },
    ranked_files: topFiles.map((file) => ({
      path: displayPath(file.path),
      score: file.score,
      reasons: Array.from(file.reasons).slice(0, 5),
      match_lines: Array.from(file.lineMatches.keys()).slice(0, 12),
    })),
    snippets,
    related_files: related,
    symbols: symbolContext.symbols,
    definitions: symbolContext.definitions,
    import_edges: symbolContext.import_edges,
    test_counterparts: symbolContext.test_counterparts,
    compact_context: compact,
    quality,
    artifacts: {
      raw_search_url: rawArtifact.url,
      raw_search_file: rawArtifact.fileName,
      compact_context_url: compactArtifact.url,
      compact_context_file: compactArtifact.fileName,
      repo_map_url: repoMap?.artifacts.repo_map_url,
      repo_map_file: repoMap?.artifacts.repo_map_file,
    },
    repo_map: repoMap
      ? {
          schema_version: repoMap.schema_version,
          input_stats: repoMap.input_stats,
          repo_map: repoMap.repo_map,
          artifacts: repoMap.artifacts,
        }
      : undefined,
    confidence: conf,
    autopilot: {
      requires_clarification: diagnostics.truncated || (conf.uncertainty > 0.03 && snippets.length === 0),
      suggested_action:
        diagnostics.truncated
          ? "inspect raw_search artifact or narrow the query before editing"
          : snippets.length > 0
          ? "use ranked snippets first; open artifact or exact files before editing"
          : "ask for a narrower query or inspect repo manually",
    },
    prompt_scaffold:
      "Use compact_context to orient. Before editing, read the exact listed files/lines that will be changed. If uncertainty > 0.03 or files conflict, inspect raw_search artifact or ask one clarification.",
    metadata: options.metadata,
  };
}

export async function findFiles(
  query: string,
  config: RetrievalConfig,
  options: FindFilesOptions = {},
) {
  const root = await resolveRoot(options.root_path, config);
  const maxFiles = toNumber(options.max_files, 30, 1, 100);
  const { files, filesConsidered, terms, diagnostics } = await scoreFiles(root, config, query, options);
  const ranked = files.slice(0, maxFiles).map((file) => ({
    path: displayPath(file.path),
    score: file.score,
    reasons: Array.from(file.reasons).slice(0, 5),
    match_lines: Array.from(file.lineMatches.keys()).slice(0, 12),
  }));
  const key = stableKey("find-files", JSON.stringify({ query, root, options, terms }));
  const rawArtifact = await persistArtifactJson(config, key, {
    query,
    root,
    terms,
    files_considered: filesConsidered,
    quality: qualitySummary(diagnostics),
    ranked,
  });
  const quality = qualitySummary(diagnostics);
  const callId = createRetrievalCallId("find");

  return {
    schema_version: RETRIEVAL_SCHEMA_VERSION,
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    call_id: callId,
    retrieval_mode: "local-rg-files",
    query,
    root_path: root,
    input_stats: {
      files_considered: filesConsidered,
      ranked_files_returned: ranked.length,
      truncated: diagnostics.truncated,
      warnings_count: diagnostics.warnings.length,
      filtered_hits_count: diagnostics.filteredHits.length,
      context_hints_applied_count: diagnostics.contextHints.applied.length,
    },
    ranked_files: ranked,
    quality,
    artifacts: {
      raw_search_url: rawArtifact.url,
      raw_search_file: rawArtifact.fileName,
    },
    confidence: {
      uncertainty: ranked.length > 0 ? 0.04 : 0.35,
      reasons: ranked.length > 0 ? ["file candidates found"] : ["no file candidates found"],
    },
    metadata: options.metadata,
  };
}
