import path from "node:path";

export const STATIC_ANALYSIS_SCHEMA_VERSION = "static-analysis.v1";
export const STATIC_ANALYSIS_PIPELINE_VERSION = "2026-04-24.local-static-analysis-v1";

export interface StaticAnalysisConfig {
  artifactDir: string;
  cacheDir: string;
  commandTimeoutMs: number;
  defaultRoot: string;
  maxArtifactChars: number;
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
  return home
    ? path.join(home, ".hwai", "static-analysis-mcp")
    : path.join("/tmp", "hwai-static-analysis-mcp-cache");
}

export function getStaticAnalysisConfig(): StaticAnalysisConfig {
  const cacheDir = process.env.STATIC_ANALYSIS_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.STATIC_ANALYSIS_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    commandTimeoutMs: readPositiveInt(process.env.STATIC_ANALYSIS_COMMAND_TIMEOUT_MS, 30_000),
    defaultRoot: process.env.STATIC_ANALYSIS_DEFAULT_ROOT || process.cwd(),
    maxArtifactChars: readPositiveInt(process.env.STATIC_ANALYSIS_MAX_ARTIFACT_CHARS, 2_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(
      process.env.STATIC_ANALYSIS_USD_PER_1M_TOKENS,
      3,
    ),
    publicBaseUrl: (process.env.STATIC_ANALYSIS_PUBLIC_BASE_URL || "static-analysis://local").replace(/\/+$/, ""),
    requestLogPath:
      process.env.STATIC_ANALYSIS_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
