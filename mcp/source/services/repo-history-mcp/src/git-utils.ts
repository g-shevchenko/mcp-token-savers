import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { RepoHistoryConfig } from "./config.js";
import { clampText, redactSecrets, stableHash } from "./text-utils.js";

export interface GitResult {
  args: string[];
  duration_ms: number;
  exit_code: number | null;
  stderr: string;
  stdout: string;
  timed_out: boolean;
}

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,180}$/;

export async function runGit(
  args: string[],
  cwd: string,
  config: RepoHistoryConfig,
  timeoutMs = config.timeoutMs,
): Promise<GitResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = clampText(stdout + chunk.toString(), config.maxGitOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = clampText(stderr + chunk.toString(), config.maxGitOutputChars);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        args,
        duration_ms: Date.now() - started,
        exit_code: error.code === "ENOENT" ? 127 : null,
        stderr: redactSecrets(error.message),
        stdout: "",
        timed_out: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        args,
        duration_ms: Date.now() - started,
        exit_code: code,
        stderr: redactSecrets(stderr),
        stdout: redactSecrets(stdout),
        timed_out: timedOut,
      });
    });
  });
}

export async function resolveRepoRoot(config: RepoHistoryConfig, rawRoot?: string): Promise<string> {
  const base = path.resolve(rawRoot || config.defaultRoot);
  const stat = await fs.stat(base);
  if (!stat.isDirectory()) {
    throw new Error("repo_root is not a directory");
  }
  const result = await runGit(["rev-parse", "--show-toplevel"], base, config, 5000);
  if (result.exit_code !== 0) {
    throw new Error(`git root resolution failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return result.stdout.trim();
}

export async function repoBasics(config: RepoHistoryConfig, root: string) {
  const [branch, head, dirty] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, config, 5000),
    runGit(["rev-parse", "--short=12", "HEAD"], root, config, 5000),
    runGit(["status", "--porcelain"], root, config, 5000),
  ]);
  return {
    repo_name: path.basename(root),
    repo_root_hash: stableHash(root),
    branch: branch.exit_code === 0 ? branch.stdout.trim() : "unknown",
    head_short: head.exit_code === 0 ? head.stdout.trim() : "unknown",
    dirty: dirty.exit_code === 0 ? dirty.stdout.trim().length > 0 : undefined,
  };
}

export function safeRef(raw: unknown, fallback: string): string {
  const ref = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  if (ref.startsWith("-") || !SAFE_REF_RE.test(ref)) {
    throw new Error(`unsafe git ref: ${ref}`);
  }
  return ref;
}

export function optionalSafeRef(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  return safeRef(raw, "HEAD");
}

export function clampCount(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(parsed));
}

export function safeRelativePath(root: string, rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return undefined;
  }
  const trimmed = rawPath.trim();
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path must stay inside repo_root");
  }
  return relative.split(path.sep).join("/");
}

export function safeRelativePaths(root: string, rawPaths: unknown): string[] {
  if (!Array.isArray(rawPaths)) {
    return [];
  }
  return rawPaths.flatMap((item) => {
    const rel = safeRelativePath(root, item);
    return rel ? [rel] : [];
  });
}

export function parseNameStatusLine(line: string): { status: string; path: string; old_path?: string } | null {
  const parts = line.split("\t").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const status = parts[0];
  if (status.startsWith("R") || status.startsWith("C")) {
    return { status, old_path: parts[1], path: parts[2] || parts[1] };
  }
  return { status, path: parts[1] };
}
