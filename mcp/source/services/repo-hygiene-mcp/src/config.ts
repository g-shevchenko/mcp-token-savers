import path from "node:path";

export const REPO_HYGIENE_SCHEMA_VERSION = "repo-hygiene.v0.1";
export const REPO_HYGIENE_MEASUREMENT_SCHEMA_VERSION = "repo-hygiene-measurement.v0.1";
export const REPO_HYGIENE_PIPELINE_VERSION = "2026-04-26.local-repo-hygiene-v0.1.1";

export interface RepoHygieneConfig {
  artifactDir: string;
  cacheDir: string;
  duplicateBlockLines: number;
  maxArtifactChars: number;
  maxFileBytes: number;
  maxFiles: number;
  maxFindings: number;
  measurementUsdPer1MTokens: number;
  publicBaseUrl: string;
  requestLogPath: string;
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
  return home ? path.join(home, ".hwai", "repo-hygiene-mcp") : path.join("/tmp", "hwai-repo-hygiene-mcp-cache");
}

export function getRepoHygieneConfig(): RepoHygieneConfig {
  const cacheDir = process.env.REPO_HYGIENE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.REPO_HYGIENE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    duplicateBlockLines: readPositiveInt(process.env.REPO_HYGIENE_DUPLICATE_BLOCK_LINES, 6),
    maxArtifactChars: readPositiveInt(process.env.REPO_HYGIENE_MAX_ARTIFACT_CHARS, 2_000_000),
    maxFileBytes: readPositiveInt(process.env.REPO_HYGIENE_MAX_FILE_BYTES, 512_000),
    maxFiles: readPositiveInt(process.env.REPO_HYGIENE_MAX_FILES, 4_000),
    maxFindings: readPositiveInt(process.env.REPO_HYGIENE_MAX_FINDINGS, 80),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.REPO_HYGIENE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.REPO_HYGIENE_PUBLIC_BASE_URL || "repo-hygiene://local").replace(/\/+$/, ""),
    requestLogPath: process.env.REPO_HYGIENE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
