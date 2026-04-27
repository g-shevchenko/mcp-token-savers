import path from "node:path";

export const REPO_HISTORY_SCHEMA_VERSION = "repo-history.v1";
export const REPO_HISTORY_MEASUREMENT_SCHEMA_VERSION = "repo-history-measurement.v1";
export const REPO_HISTORY_PIPELINE_VERSION = "2026-04-24.local-repo-history-v1.1";

export interface RepoHistoryConfig {
  artifactDir: string;
  cacheDir: string;
  defaultRoot: string;
  maxArtifactChars: number;
  maxGitOutputChars: number;
  measurementUsdPer1MTokens: number;
  publicBaseUrl: string;
  requestLogPath: string;
  timeoutMs: number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  return home
    ? path.join(home, ".hwai", "repo-history-mcp")
    : path.join("/tmp", "hwai-repo-history-mcp-cache");
}

export function getRepoHistoryConfig(): RepoHistoryConfig {
  const cacheDir = process.env.REPO_HISTORY_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.REPO_HISTORY_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    defaultRoot: process.env.REPO_HISTORY_DEFAULT_ROOT || process.cwd(),
    maxArtifactChars: readPositiveInt(process.env.REPO_HISTORY_MAX_ARTIFACT_CHARS, 2_000_000),
    maxGitOutputChars: readPositiveInt(process.env.REPO_HISTORY_MAX_GIT_OUTPUT_CHARS, 2_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.REPO_HISTORY_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.REPO_HISTORY_PUBLIC_BASE_URL || "repo-history://local").replace(/\/+$/, ""),
    requestLogPath: process.env.REPO_HISTORY_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    timeoutMs: readPositiveInt(process.env.REPO_HISTORY_TIMEOUT_MS, 20_000),
  };
}
