import { execFile } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  RETRIEVAL_PIPELINE_VERSION,
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
import { clampText } from "./text-utils.js";
import { estimateTokens } from "./token-estimates.js";
import { extractSymbolMap, SymbolEntry, SymbolScan } from "./symbol-map.js";

const execFileAsync = promisify(execFile);

export interface RepoMapOptions {
  exclude_globs?: string[];
  include_globs?: string[];
  include_tests?: boolean;
  max_chars?: number;
  max_files?: number;
  root_path?: string;
}

interface CommandResult {
  stdout: string;
  truncated: boolean;
  warnings: string[];
}

interface MappedFile {
  path: string;
  priority: number;
  reasons: string[];
  scan?: SymbolScan;
}

const IMPORTANT_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Dockerfile",
]);

const IMPORTANT_PATH_PARTS = [
  "/src/",
  "/scripts/",
  "/benchmarks/",
  "/configs/",
  "/notes/",
  "/rules/",
  "/skills/",
  "/services/",
];

function toNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
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
    const { stdout } = await execFileAsync(executable, args, {
      cwd,
      maxBuffer: config.maxRipgrepBufferBytes,
      timeout: config.commandTimeoutMs,
    });
    return { stdout, truncated: false, warnings: [] };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error || "");
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      message.includes("stdout maxBuffer")
    ) {
      return {
        stdout,
        truncated: true,
        warnings: [`${command} output exceeded maxBuffer; using partial output`],
      };
    }
    if (error?.code === 1 && typeof error.stdout === "string") {
      return { stdout: error.stdout, truncated: false, warnings: [] };
    }
    if (isMissingCommandError(error, command)) {
      return {
        stdout,
        truncated: false,
        warnings: [commandUnavailableWarning(command)],
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
): Promise<{ files: string[]; truncated: boolean; warnings: string[] }> {
  const args = ["--files", "--hidden"];
  appendRgGlobs(args, pathPolicy);
  const { stdout, truncated, warnings } = await runCommand("rg", args, root, config);
  const files = stdout
    .split("\n")
    .map((line) => displayPath(line.trim()))
    .filter(Boolean)
    .filter((file) => !classifyFilteredPath(file));
  return { files, truncated, warnings };
}

function pathPriority(relativePath: string): { priority: number; reasons: string[] } {
  const normalized = `/${relativePath.replace(/\\/g, "/")}`;
  const base = path.basename(relativePath);
  const ext = path.extname(relativePath).toLowerCase();
  const reasons: string[] = [];
  let priority = 0;

  if (IMPORTANT_BASENAMES.has(base)) {
    priority += 80;
    reasons.push("core repo metadata");
  }
  if (/\/README\.md$/i.test(normalized)) {
    priority += 36;
    reasons.push("package README");
  }
  if (/\/src\/(index|server|tools?|routes?|config|retrieval|repo-map)\.[tj]s$/i.test(normalized)) {
    priority += 42;
    reasons.push("entrypoint or core source");
  }
  if (/\/scripts\/[^/]+(\.mjs|\.js|\.sh)$/i.test(normalized)) {
    priority += 24;
    reasons.push("operator script");
  }
  if (/\/benchmarks\/.+\.json$/i.test(normalized)) {
    priority += 24;
    reasons.push("benchmark fixture");
  }
  if (/\/notes\/.*(plan|roadmap|runbook|strategy|mcp|retrieval|vision|context|scraper).*\.md$/i.test(normalized)) {
    priority += 34;
    reasons.push("planning/runbook note");
  }
  if (/\/(rules|skills)\//i.test(normalized)) {
    priority += 28;
    reasons.push("agent rule or skill");
  }
  if ([".ts", ".tsx", ".js", ".mjs", ".py", ".md", ".yaml", ".yml"].includes(ext)) {
    priority += 8;
  }
  for (const part of IMPORTANT_PATH_PARTS) {
    if (normalized.includes(part)) {
      priority += 4;
    }
  }

  const depthPenalty = Math.max(0, relativePath.split("/").length - 2) * 2;
  priority -= depthPenalty;

  return { priority, reasons };
}

function topSymbols(scan: SymbolScan | undefined): SymbolEntry[] {
  if (!scan) {
    return [];
  }
  const preferred = scan.symbols.filter((symbol) =>
    ["function", "class", "type", "route", "tool", "heading1", "heading2"].includes(symbol.kind),
  );
  return preferred.slice(0, 8);
}

function groupName(relativePath: string): string {
  const parts = relativePath.split("/");
  if (parts[0] === "services" && parts[1]) {
    return `services/${parts[1]}`;
  }
  if (parts[0] === "experiments" && parts[1]) {
    return `experiments/${parts[1]}`;
  }
  if (parts[0] === "notes") {
    return "notes";
  }
  if (parts[0] === "claude" || parts[0] === ".claude" || parts[0] === ".cursor" || parts[0] === ".windsurf") {
    return "agent-rules";
  }
  return parts[0] || ".";
}

function composeRepoMap(root: string, mappedFiles: MappedFile[], maxChars: number): string {
  const groups = new Map<string, MappedFile[]>();
  for (const file of mappedFiles) {
    const name = groupName(file.path);
    groups.set(name, [...(groups.get(name) || []), file]);
  }

  const parts = [
    "# Retrieval Repo Map",
    "",
    `Root: ${root}`,
    "",
    "This map is deterministic, local-first, and token-budgeted. Use it for orientation; read exact files before edits.",
  ];

  for (const [group, files] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push("", `## ${group}`);
    for (const file of files.slice(0, 18)) {
      const symbols = topSymbols(file.scan)
        .map((symbol) => `${symbol.kind} ${symbol.name}`)
        .slice(0, 5);
      const reason = file.reasons.slice(0, 2).join("; ") || "path priority";
      parts.push(`- ${file.path} (${reason})`);
      if (symbols.length > 0) {
        parts.push(`  symbols: ${symbols.join("; ")}`);
      }
    }
  }

  return clampText(parts.join("\n"), maxChars);
}

export async function buildRepoMap(
  config: RetrievalConfig,
  options: RepoMapOptions = {},
) {
  const root = await resolveRoot(options.root_path, config);
  const maxFiles = toNumber(options.max_files, 240, 20, 1000);
  const maxChars = toNumber(options.max_chars, 12_000, 2000, 50_000);
  const includeTests = options.include_tests !== false;
  const pathPolicy = await buildPathPolicy(root, options.include_globs, options.exclude_globs, includeTests);
  const fileListing = await listFiles(root, config, pathPolicy);
  const prioritized = fileListing.files
    .map((file) => ({ path: file, ...pathPriority(file) }))
    .filter((file) => file.priority > 0)
    .sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
  const scans = await extractSymbolMap(root, prioritized.map((file) => file.path), config.maxFileBytes);
  const mappedFiles = prioritized.map((file) => ({
    ...file,
    scan: scans.get(file.path),
  }));
  const repoMap = composeRepoMap(root, mappedFiles, maxChars);
  const key = stableKey("repo-map", JSON.stringify({ root, options, files: mappedFiles.map((file) => file.path) }));
  const manifest = {
    root,
    files_considered: fileListing.files.length,
    files_mapped: mappedFiles.length,
    path_policy: {
      effective_globs_count: pathPolicy.rgGlobs.length,
      sources: pathPolicy.sources,
    },
    mapped_files: mappedFiles.map((file) => ({
      path: file.path,
      priority: file.priority,
      reasons: file.reasons,
      symbols: topSymbols(file.scan).map((symbol) => ({
        kind: symbol.kind,
        name: symbol.name,
        line: symbol.line,
      })),
    })),
  };
  const [repoMapArtifact, manifestArtifact] = await Promise.all([
    persistArtifactText(config, key, "md", repoMap),
    persistArtifactJson(config, `${key}-manifest`, manifest),
  ]);

  return {
    schema_version: "retrieval-repo-map.v1",
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    root_path: root,
    repo_map: repoMap,
    input_stats: {
      files_considered: fileListing.files.length,
      files_mapped: mappedFiles.length,
      symbols_returned: mappedFiles.reduce((sum, file) => sum + topSymbols(file.scan).length, 0),
      truncated: fileListing.truncated || repoMap.length >= maxChars,
      warnings_count: fileListing.warnings.length + pathPolicy.warnings.length,
      compact_tokens_estimate: estimateTokens(repoMap),
    },
    quality: {
      truncated: fileListing.truncated || repoMap.length >= maxChars,
      warnings: [...pathPolicy.warnings, ...fileListing.warnings],
      path_policy: {
        effective_globs_count: pathPolicy.rgGlobs.length,
        sources: pathPolicy.sources,
      },
    },
    artifacts: {
      repo_map_url: repoMapArtifact.url,
      repo_map_file: repoMapArtifact.fileName,
      manifest_url: manifestArtifact.url,
      manifest_file: manifestArtifact.fileName,
    },
  };
}
