import path from "node:path";
import { artifactFileName, writeArtifact } from "./artifact-store.js";
import { REPO_HISTORY_SCHEMA_VERSION, RepoHistoryConfig } from "./config.js";
import {
  clampCount,
  optionalSafeRef,
  parseNameStatusLine,
  repoBasics,
  resolveRepoRoot,
  runGit,
  safeRef,
  safeRelativePath,
  safeRelativePaths,
} from "./git-utils.js";
import { estimateTokens, round, safePreview, stableHash } from "./text-utils.js";

interface CommitSummary {
  author_date: string;
  changed_files?: Array<{ path: string; status: string; old_path?: string }>;
  changed_files_count?: number;
  hash: string;
  short_hash: string;
  subject: string;
}

interface HistoryOptions {
  base_ref?: string;
  date?: string;
  file_path?: string;
  head_ref?: string;
  include_changed_files?: boolean;
  max_authors?: number;
  max_commits?: number;
  max_files?: number;
  metadata?: Record<string, unknown>;
  paths?: string[];
  query?: string;
  repo_root?: string;
  since_ref?: string;
  start_line?: number;
  end_line?: number;
  until_ref?: string;
}

function asObject(args: Record<string, unknown>): HistoryOptions {
  return args as HistoryOptions;
}

function parseCommitLine(line: string): CommitSummary | null {
  const [hash, shortHash, authorDate, ...subjectParts] = line.split("\t");
  if (!hash || !shortHash) {
    return null;
  }
  return {
    hash,
    short_hash: shortHash,
    author_date: authorDate || "",
    subject: safePreview(subjectParts.join("\t"), 220) || "",
  };
}

function safeQuery(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("query is required");
  }
  return raw.trim().slice(0, 200);
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function safeLine(raw: unknown): number | undefined {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function buildLineRangeArgs(startLine?: number, endLine?: number): string[] {
  if (!startLine && !endLine) {
    return [];
  }
  const start = startLine || 1;
  const end = endLine && endLine >= start ? endLine : start;
  return ["-L", `${start},${end}`];
}

async function changedFilesForCommit(
  config: RepoHistoryConfig,
  root: string,
  commitHash: string,
  maxFiles: number,
): Promise<Array<{ path: string; status: string; old_path?: string }>> {
  const result = await runGit(["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", commitHash], root, config);
  if (result.exit_code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line.trim()))
    .filter((item): item is { path: string; status: string; old_path?: string } => Boolean(item))
    .slice(0, maxFiles);
}

async function writeResultArtifact(config: RepoHistoryConfig, prefix: string, payload: unknown) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return writeArtifact(config, `${prefix}-${stamp}.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

function withSavings(payload: Record<string, any>, rawText: string) {
  const rawTokens = Math.max(estimateTokens(rawText), estimateTokens(JSON.stringify(payload)));
  const compactTokens = estimateTokens(JSON.stringify(payload));
  return {
    ...payload,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: Math.max(0, rawTokens - compactTokens),
    savings_pct: rawTokens > 0 ? round(((rawTokens - compactTokens) / rawTokens) * 100) : 0,
  };
}

export async function summarizeRecentCommits(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const maxCommits = clampCount(args.max_commits, 10, 100);
  const maxFiles = clampCount(args.max_files, 20, 200);
  const paths = safeRelativePaths(root, args.paths);
  const sinceRef = optionalSafeRef(args.since_ref);
  const untilRef = safeRef(args.until_ref, "HEAD");
  const range = sinceRef ? `${sinceRef}..${untilRef}` : untilRef;
  const gitArgs = [
    "log",
    "--date=iso-strict",
    "--format=%H%x09%h%x09%aI%x09%s",
    "-n",
    String(maxCommits),
    range,
    "--",
    ...paths,
  ];
  const result = await runGit(gitArgs, root, config);
  if (result.exit_code !== 0) {
    throw new Error(`git log failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const commits = result.stdout
    .split("\n")
    .map((line) => parseCommitLine(line.trim()))
    .filter((item): item is CommitSummary => Boolean(item));
  if (args.include_changed_files !== false) {
    for (const commit of commits) {
      const changed = await changedFilesForCommit(config, root, commit.hash, maxFiles);
      commit.changed_files = changed;
      commit.changed_files_count = changed.length;
    }
  }
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "summarize_recent_commits",
      repo: await repoBasics(config, root),
      range: { since_ref: sinceRef || null, until_ref: untilRef },
      paths,
      commits,
      commits_returned: commits.length,
      data_policy: "No raw diffs or file bodies. Commit subjects and relative paths are local tool output only; request logs keep counts/hashes.",
    },
    result.stdout,
  );
  const artifact = await writeResultArtifact(config, "recent-commits", payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function searchCommits(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const query = safeQuery(args.query);
  const maxCommits = clampCount(args.max_commits, 20, 100);
  const maxFiles = clampCount(args.max_files, 20, 200);
  const paths = safeRelativePaths(root, args.paths);
  const sinceRef = optionalSafeRef(args.since_ref);
  const untilRef = safeRef(args.until_ref, "HEAD");
  const range = sinceRef ? `${sinceRef}..${untilRef}` : untilRef;
  const result = await runGit(
    [
      "log",
      "--regexp-ignore-case",
      "--fixed-strings",
      `--grep=${query}`,
      "--date=iso-strict",
      "--format=%H%x09%h%x09%aI%x09%s",
      "-n",
      String(maxCommits),
      range,
      "--",
      ...paths,
    ],
    root,
    config,
  );
  if (result.exit_code !== 0) {
    throw new Error(`git commit search failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const commits = result.stdout
    .split("\n")
    .map((line) => parseCommitLine(line.trim()))
    .filter((item): item is CommitSummary => Boolean(item));
  for (const commit of commits) {
    const changed = await changedFilesForCommit(config, root, commit.hash, maxFiles);
    commit.changed_files = changed;
    commit.changed_files_count = changed.length;
  }
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "search_commits",
      repo: await repoBasics(config, root),
      query_hash: stableHash(query),
      range: { since_ref: sinceRef || null, until_ref: untilRef },
      paths,
      commits,
      commits_returned: commits.length,
      search_results_returned: commits.length,
      data_policy: "No raw diffs or file bodies. Query is hashed in output; commit subjects and relative paths are local tool output only.",
    },
    result.stdout,
  );
  const artifact = await writeResultArtifact(config, "commit-search", payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function summarizeFileHistory(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const filePath = safeRelativePath(root, args.file_path);
  if (!filePath) {
    throw new Error("file_path is required");
  }
  const maxCommits = clampCount(args.max_commits, 20, 100);
  const result = await runGit(
    [
      "log",
      "--follow",
      "--date=iso-strict",
      "--format=@@commit@@%H%x09%h%x09%aI%x09%s",
      "--name-status",
      "-n",
      String(maxCommits),
      "--",
      filePath,
    ],
    root,
    config,
  );
  if (result.exit_code !== 0) {
    throw new Error(`git file history failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("@@commit@@")) {
      current = parseCommitLine(line.replace(/^@@commit@@/, ""));
      if (current) {
        current.changed_files = [];
        commits.push(current);
      }
      continue;
    }
    if (current) {
      const item = parseNameStatusLine(line);
      if (item) {
        current.changed_files?.push(item);
      }
    }
  }
  for (const commit of commits) {
    commit.changed_files_count = commit.changed_files?.length || 0;
  }
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "summarize_file_history",
      repo: await repoBasics(config, root),
      file_path: filePath,
      file_path_hash: stableHash(filePath),
      commits,
      commits_returned: commits.length,
      data_policy: "No raw diffs or file bodies. Relative file path is local tool output only; Pantheon/request summaries use counts and hashes.",
    },
    result.stdout,
  );
  const artifact = await writeResultArtifact(config, `file-history-${path.basename(filePath)}`, payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function summarizeBlame(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const filePath = safeRelativePath(root, args.file_path);
  if (!filePath) {
    throw new Error("file_path is required");
  }
  const maxAuthors = clampCount(args.max_authors, 10, 100);
  const maxCommits = clampCount(args.max_commits, 20, 200);
  const startLine = safeLine(args.start_line);
  const endLine = safeLine(args.end_line);
  const blameArgs = [
    "blame",
    "--line-porcelain",
    ...buildLineRangeArgs(startLine, endLine),
    "--",
    filePath,
  ];
  const result = await runGit(blameArgs, root, config);
  if (result.exit_code !== 0) {
    throw new Error(`git blame failed: ${result.stderr || result.stdout || "unknown error"}`);
  }

  type CommitBlame = {
    author: string;
    author_hash: string;
    last_author_time: number;
    lines: number;
    short_hash: string;
    summary: string;
  };
  type AuthorBlame = {
    author: string;
    author_hash: string;
    last_author_time: number;
    lines: number;
  };

  const commits = new Map<string, CommitBlame>();
  const authors = new Map<string, AuthorBlame>();
  let currentHash = "";
  let currentAuthor = "";
  let currentAuthorTime = 0;
  let currentSummary = "";
  let lineCount = 0;
  const finalizeLine = () => {
    if (!currentHash) {
      return;
    }
    const author = safePreview(currentAuthor || "unknown", 120) || "unknown";
    const authorHash = stableHash(author);
    const existingCommit = commits.get(currentHash) || {
      author,
      author_hash: authorHash,
      last_author_time: currentAuthorTime,
      lines: 0,
      short_hash: shortHash(currentHash),
      summary: safePreview(currentSummary, 180) || "",
    };
    existingCommit.lines += 1;
    existingCommit.last_author_time = Math.max(existingCommit.last_author_time, currentAuthorTime);
    commits.set(currentHash, existingCommit);

    const existingAuthor = authors.get(authorHash) || {
      author,
      author_hash: authorHash,
      last_author_time: currentAuthorTime,
      lines: 0,
    };
    existingAuthor.lines += 1;
    existingAuthor.last_author_time = Math.max(existingAuthor.last_author_time, currentAuthorTime);
    authors.set(authorHash, existingAuthor);
    lineCount += 1;
  };

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const commitMatch = line.match(/^([0-9a-f]{40})\s+\d+\s+\d+(?:\s+\d+)?$/);
    if (commitMatch) {
      currentHash = commitMatch[1];
      currentAuthor = "";
      currentAuthorTime = 0;
      currentSummary = "";
      continue;
    }
    if (line.startsWith("author ")) {
      currentAuthor = line.slice("author ".length);
      continue;
    }
    if (line.startsWith("author-time ")) {
      currentAuthorTime = Number.parseInt(line.slice("author-time ".length), 10) || 0;
      continue;
    }
    if (line.startsWith("summary ")) {
      currentSummary = line.slice("summary ".length);
      continue;
    }
    if (line.startsWith("\t")) {
      finalizeLine();
    }
  }

  const authorRows = Array.from(authors.values())
    .sort((a, b) => b.lines - a.lines || b.last_author_time - a.last_author_time)
    .slice(0, maxAuthors)
    .map((item) => ({
      author: item.author,
      author_hash: item.author_hash,
      lines: item.lines,
      last_author_date: item.last_author_time ? new Date(item.last_author_time * 1000).toISOString() : null,
    }));
  const commitRows = Array.from(commits.entries())
    .map(([hash, item]) => ({
      hash,
      short_hash: item.short_hash,
      author: item.author,
      author_hash: item.author_hash,
      lines: item.lines,
      last_author_date: item.last_author_time ? new Date(item.last_author_time * 1000).toISOString() : null,
      summary: item.summary,
    }))
    .sort((a, b) => b.lines - a.lines || String(b.last_author_date).localeCompare(String(a.last_author_date)))
    .slice(0, maxCommits);

  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "summarize_blame",
      repo: await repoBasics(config, root),
      file_path: filePath,
      file_path_hash: stableHash(filePath),
      line_range: { start_line: startLine || null, end_line: endLine || null },
      line_count: lineCount,
      authors: authorRows,
      authors_returned: authorRows.length,
      commits: commitRows,
      commits_returned: commitRows.length,
      data_policy: "No source lines, raw diffs, or file bodies. Blame output summarizes authors and commits only.",
    },
    result.stdout,
  );
  const artifact = await writeResultArtifact(config, `blame-${path.basename(filePath)}`, payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function summarizeDiffStat(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const baseRef = safeRef(args.base_ref, "HEAD~1");
  const headRef = safeRef(args.head_ref, "HEAD");
  const maxFiles = clampCount(args.max_files, 200, 1000);
  const paths = safeRelativePaths(root, args.paths);
  const range = `${baseRef}..${headRef}`;
  const nameStatus = await runGit(["diff", "--name-status", range, "--", ...paths], root, config);
  const shortStat = await runGit(["diff", "--shortstat", range, "--", ...paths], root, config);
  if (nameStatus.exit_code !== 0) {
    throw new Error(`git diff failed: ${nameStatus.stderr || nameStatus.stdout || "unknown error"}`);
  }
  const files = nameStatus.stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line.trim()))
    .filter((item): item is { path: string; status: string; old_path?: string } => Boolean(item))
    .slice(0, maxFiles);
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "summarize_diff_stat",
      repo: await repoBasics(config, root),
      range: { base_ref: baseRef, head_ref: headRef },
      paths,
      files,
      files_returned: files.length,
      shortstat: safePreview(shortStat.stdout || "", 240) || "",
      data_policy: "No raw diffs or file bodies. Name-status and shortstat only.",
    },
    `${nameStatus.stdout}\n${shortStat.stdout}`,
  );
  const artifact = await writeResultArtifact(config, "diff-stat", payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function findChangeHotspots(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const maxCommits = clampCount(args.max_commits, 100, 1000);
  const maxFiles = clampCount(args.max_files, 25, 200);
  const paths = safeRelativePaths(root, args.paths);
  const sinceRef = optionalSafeRef(args.since_ref);
  const untilRef = safeRef(args.until_ref, "HEAD");
  const rangeArgs = sinceRef
    ? ["-n", String(maxCommits), `${sinceRef}..${untilRef}`]
    : ["-n", String(maxCommits), untilRef];
  const result = await runGit(["log", "--name-only", "--format=@@commit@@%H", ...rangeArgs, "--", ...paths], root, config);
  if (result.exit_code !== 0) {
    throw new Error(`git hotspot log failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const counts = new Map<string, { commits: number; path_hash: string }>();
  let commitFiles = new Set<string>();
  const flush = () => {
    for (const file of commitFiles) {
      const current = counts.get(file) || { commits: 0, path_hash: stableHash(file) };
      current.commits += 1;
      counts.set(file, current);
    }
    commitFiles = new Set<string>();
  };
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("@@commit@@")) {
      flush();
      continue;
    }
    commitFiles.add(line);
  }
  flush();
  const hotspots = Array.from(counts.entries())
    .map(([file_path, item]) => ({ file_path, path_hash: item.path_hash, commits_touching: item.commits }))
    .sort((a, b) => b.commits_touching - a.commits_touching || a.file_path.localeCompare(b.file_path))
    .slice(0, maxFiles);
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "find_change_hotspots",
      repo: await repoBasics(config, root),
      range: { since_ref: sinceRef || null, until_ref: untilRef, max_commits: maxCommits },
      paths,
      hotspots,
      files_returned: hotspots.length,
      data_policy: "No raw diffs or file bodies. Hotspots are counts over relative paths.",
    },
    result.stdout,
  );
  const artifact = await writeResultArtifact(config, "change-hotspots", payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export async function findCochangeFiles(config: RepoHistoryConfig, rawArgs: Record<string, unknown>) {
  const args = asObject(rawArgs);
  const root = await resolveRepoRoot(config, args.repo_root);
  const targetPaths = safeRelativePaths(root, args.paths);
  if (targetPaths.length === 0) {
    throw new Error("paths must include at least one target file");
  }
  const maxCommits = clampCount(args.max_commits, 100, 1000);
  const maxFiles = clampCount(args.max_files, 25, 200);
  const sinceRef = optionalSafeRef(args.since_ref);
  const untilRef = safeRef(args.until_ref, "HEAD");
  const rangeArgs = sinceRef
    ? ["-n", String(maxCommits), `${sinceRef}..${untilRef}`]
    : ["-n", String(maxCommits), untilRef];
  const commitResult = await runGit(["log", "--format=%H", ...rangeArgs, "--", ...targetPaths], root, config);
  if (commitResult.exit_code !== 0) {
    throw new Error(`git cochange commit search failed: ${commitResult.stderr || commitResult.stdout || "unknown error"}`);
  }
  const commits = commitResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxCommits);
  const targetSet = new Set(targetPaths);
  const counts = new Map<string, { commits: Set<string>; path_hash: string }>();
  let rawCombined = commitResult.stdout;
  for (const commit of commits) {
    const filesResult = await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit], root, config);
    if (filesResult.exit_code !== 0) {
      continue;
    }
    rawCombined += `\n${filesResult.stdout}`;
    const files = new Set(filesResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    const touchedTarget = targetPaths.some((target) => files.has(target));
    if (!touchedTarget) {
      continue;
    }
    for (const file of files) {
      if (targetSet.has(file)) {
        continue;
      }
      const current = counts.get(file) || { commits: new Set<string>(), path_hash: stableHash(file) };
      current.commits.add(commit);
      counts.set(file, current);
    }
  }
  const cochangeFiles = Array.from(counts.entries())
    .map(([file_path, item]) => ({
      file_path,
      path_hash: item.path_hash,
      commits_together: item.commits.size,
      sample_commits: Array.from(item.commits).slice(0, 5).map(shortHash),
    }))
    .sort((a, b) => b.commits_together - a.commits_together || a.file_path.localeCompare(b.file_path))
    .slice(0, maxFiles);
  const payload = withSavings(
    {
      schema_version: REPO_HISTORY_SCHEMA_VERSION,
      tool: "find_cochange_files",
      repo: await repoBasics(config, root),
      target_paths: targetPaths,
      target_path_hashes: targetPaths.map((item) => stableHash(item)),
      range: { since_ref: sinceRef || null, until_ref: untilRef, max_commits: maxCommits },
      commits_scanned: commits.length,
      cochange_files: cochangeFiles,
      cochange_files_returned: cochangeFiles.length,
      files_returned: cochangeFiles.length,
      data_policy: "No raw diffs or file bodies. Co-change output is relative paths, counts, and short commit ids only.",
    },
    rawCombined,
  );
  const artifact = await writeResultArtifact(config, "cochange-files", payload);
  return { ...payload, artifact_url: artifact.url, artifact_file: artifact.file };
}

export function safeArtifactName(raw: string): string {
  return artifactFileName(raw);
}
