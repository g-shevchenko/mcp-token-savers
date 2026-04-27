import path from "node:path";

export const GOLDEN_DATASET_SCHEMA_VERSION = "golden-dataset.v1";
export const GOLDEN_DATASET_MEASUREMENT_SCHEMA_VERSION = "golden-dataset-measurement.v1";
export const GOLDEN_DATASET_PIPELINE_VERSION = "2026-04-26.local-golden-dataset-v0.1.1";

export interface GoldenDatasetConfig {
  artifactDir: string;
  cacheDir: string;
  datasetsDir: string;
  maxArtifactChars: number;
  measurementUsdPer1MTokens: number;
  publicBaseUrl: string;
  requestLogPath: string;
  runsDir: string;
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
  return home ? path.join(home, ".hwai", "golden-dataset-mcp") : path.join("/tmp", "hwai-golden-dataset-mcp-cache");
}

export function getGoldenDatasetConfig(): GoldenDatasetConfig {
  const cacheDir = process.env.GOLDEN_DATASET_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.GOLDEN_DATASET_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    datasetsDir: process.env.GOLDEN_DATASET_DATASETS_DIR || path.join(cacheDir, "datasets"),
    maxArtifactChars: readPositiveInt(process.env.GOLDEN_DATASET_MAX_ARTIFACT_CHARS, 2_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.GOLDEN_DATASET_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.GOLDEN_DATASET_PUBLIC_BASE_URL || "golden-dataset://local").replace(/\/+$/, ""),
    requestLogPath: process.env.GOLDEN_DATASET_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    runsDir: process.env.GOLDEN_DATASET_RUNS_DIR || path.join(cacheDir, "runs"),
  };
}
