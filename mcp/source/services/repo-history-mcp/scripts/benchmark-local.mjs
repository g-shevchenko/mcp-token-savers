#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-history-mcp-benchmark-"));
process.env.REPO_HISTORY_CACHE_DIR = path.join(tempDir, "cache");

await git(tempDir, ["init"]);
await git(tempDir, ["config", "user.email", "alice@example.test"]);
await git(tempDir, ["config", "user.name", "Alice Bench"]);
await fs.writeFile(path.join(tempDir, "alpha.txt"), "line one\nline two\nline three\n", "utf8");
await git(tempDir, ["add", "alpha.txt"]);
await git(tempDir, ["commit", "-m", "add alpha"]);
await git(tempDir, ["config", "user.email", "bob@example.test"]);
await git(tempDir, ["config", "user.name", "Bob Bench"]);
await fs.writeFile(path.join(tempDir, "alpha.txt"), "line one\nline two changed\nline three\n", "utf8");
await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
await fs.writeFile(path.join(tempDir, "src", "beta.ts"), "export const beta = 1;\n", "utf8");
await git(tempDir, ["add", "."]);
await git(tempDir, ["commit", "-m", "update alpha and beta"]);
await fs.rename(path.join(tempDir, "alpha.txt"), path.join(tempDir, "alpha-renamed.txt"));
await git(tempDir, ["add", "-A"]);
await git(tempDir, ["commit", "-m", "rename alpha"]);

const { getRepoHistoryConfig } = await import("../dist/config.js");
const {
  findCochangeFiles,
  findChangeHotspots,
  searchCommits,
  summarizeBlame,
  summarizeDiffStat,
  summarizeFileHistory,
  summarizeRecentCommits,
} = await import("../dist/history.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getRepoHistoryConfig();
const failures = [];

function assert(name, condition, details = {}) {
  if (!condition) {
    failures.push({ name, details });
  }
}

const recent = await summarizeRecentCommits(config, {
  repo_root: tempDir,
  max_commits: 3,
  metadata: { source: "benchmark-local" },
});
const fileHistory = await summarizeFileHistory(config, {
  repo_root: tempDir,
  file_path: "alpha-renamed.txt",
  max_commits: 5,
  metadata: { source: "benchmark-local" },
});
const diffStat = await summarizeDiffStat(config, {
  repo_root: tempDir,
  base_ref: "HEAD~1",
  head_ref: "HEAD",
  metadata: { source: "benchmark-local" },
});
const hotspots = await findChangeHotspots(config, {
  repo_root: tempDir,
  max_commits: 10,
  metadata: { source: "benchmark-local" },
});
const commitSearch = await searchCommits(config, {
  repo_root: tempDir,
  query: "beta",
  max_commits: 5,
  metadata: { source: "benchmark-local" },
});
const blame = await summarizeBlame(config, {
  repo_root: tempDir,
  file_path: "alpha-renamed.txt",
  max_authors: 5,
  metadata: { source: "benchmark-local" },
});
const cochange = await findCochangeFiles(config, {
  repo_root: tempDir,
  paths: ["src/beta.ts"],
  max_commits: 5,
  metadata: { source: "benchmark-local" },
});
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combinedJson = JSON.stringify({ recent, fileHistory, diffStat, hotspots, commitSearch, blame, cochange, measurement });

assert("recent-commits-count", recent.commits_returned === 3, { commits_returned: recent.commits_returned });
assert("file-history-follow", fileHistory.commits_returned >= 2, { commits_returned: fileHistory.commits_returned });
assert("diff-stat-rename", diffStat.files.some((file) => String(file.status).startsWith("R") || file.path === "alpha-renamed.txt"), diffStat.files);
assert("hotspots-returned", hotspots.files_returned >= 2, { files_returned: hotspots.files_returned });
assert("search-commits-finds-beta", commitSearch.search_results_returned === 1, { search_results_returned: commitSearch.search_results_returned });
assert("blame-authors", blame.authors_returned >= 2 && blame.line_count === 3, {
  authors_returned: blame.authors_returned,
  line_count: blame.line_count,
});
assert("cochange-finds-alpha", cochange.cochange_files.some((file) => file.file_path === "alpha.txt"), cochange.cochange_files);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert(
  "no-raw-file-body",
  !combinedJson.includes("line two changed") && !combinedJson.includes("export const beta"),
  {},
);
assert("measurement-token-events", measurement.token_savings.saved_tokens_estimate >= 0, measurement.token_savings);

const result = {
  benchmark: "repo-history-local-golden",
  cases: 10,
  failures,
  rows: [
    { name: "recent-commits", value: recent.commits_returned },
    { name: "file-history", value: fileHistory.commits_returned },
    { name: "diff-files", value: diffStat.files_returned },
    { name: "hotspots", value: hotspots.files_returned },
    { name: "commit-search", value: commitSearch.search_results_returned },
    { name: "blame-authors", value: blame.authors_returned },
    { name: "cochange-files", value: cochange.cochange_files_returned },
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
