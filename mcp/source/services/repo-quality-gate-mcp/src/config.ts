import path from "node:path";

export const REPO_QUALITY_GATE_SCHEMA_VERSION = "repo-quality-gate.v0.1";
export const REPO_QUALITY_GATE_MEASUREMENT_SCHEMA_VERSION = "repo-quality-gate-measurement.v0.1";
export const REPO_QUALITY_GATE_PIPELINE_VERSION = "2026-04-27.local-quality-gate-v0.1.2";

export interface RepoQualityGateConfig {
  artifactDir: string;
  cacheDir: string;
  largeDocLines: number;
  maxAddedCodeLines: number;
  maxAddedDocLines: number;
  maxArtifactChars: number;
  maxChangedCodeFiles: number;
  maxChangedDocFiles: number;
  maxContextPressureScore: number;
  maxFiles: number;
  maxFindings: number;
  maxLargeDocs: number;
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
  return home ? path.join(home, ".hwai", "repo-quality-gate-mcp") : path.join("/tmp", "hwai-repo-quality-gate-mcp-cache");
}

export function getRepoQualityGateConfig(): RepoQualityGateConfig {
  const cacheDir = process.env.REPO_QUALITY_GATE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.REPO_QUALITY_GATE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    largeDocLines: readPositiveInt(process.env.REPO_QUALITY_GATE_LARGE_DOC_LINES, 800),
    maxAddedCodeLines: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_ADDED_CODE_LINES, 2500),
    maxAddedDocLines: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_ADDED_DOC_LINES, 4000),
    maxArtifactChars: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_ARTIFACT_CHARS, 2_000_000),
    maxChangedCodeFiles: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_CHANGED_CODE_FILES, 80),
    maxChangedDocFiles: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_CHANGED_DOC_FILES, 80),
    maxContextPressureScore: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_CONTEXT_PRESSURE_SCORE, 500_000),
    maxFiles: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_FILES, 8_000),
    maxFindings: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_FINDINGS, 100),
    maxLargeDocs: readPositiveInt(process.env.REPO_QUALITY_GATE_MAX_LARGE_DOCS, 10),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.REPO_QUALITY_GATE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.REPO_QUALITY_GATE_PUBLIC_BASE_URL || "repo-quality-gate://local").replace(/\/+$/, ""),
    requestLogPath: process.env.REPO_QUALITY_GATE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
