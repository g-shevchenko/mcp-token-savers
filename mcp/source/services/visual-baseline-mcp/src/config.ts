import path from "node:path";

export const VISUAL_BASELINE_SCHEMA_VERSION = "visual-baseline.v1";
export const VISUAL_BASELINE_MEASUREMENT_SCHEMA_VERSION = "visual-baseline-measurement.v1";
export const VISUAL_BASELINE_PIPELINE_VERSION = "2026-04-24.local-visual-baseline-v1";

export interface VisualBaselineConfig {
  artifactDir: string;
  baselineDir: string;
  cacheDir: string;
  maxImagePixels: number;
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
    ? path.join(home, ".hwai", "visual-baseline-mcp")
    : path.join("/tmp", "hwai-visual-baseline-mcp-cache");
}

export function getVisualBaselineConfig(): VisualBaselineConfig {
  const cacheDir = process.env.VISUAL_BASELINE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.VISUAL_BASELINE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    baselineDir: process.env.VISUAL_BASELINE_BASELINE_DIR || path.join(cacheDir, "baselines"),
    cacheDir,
    maxImagePixels: readPositiveInt(process.env.VISUAL_BASELINE_MAX_IMAGE_PIXELS, 16_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.VISUAL_BASELINE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.VISUAL_BASELINE_PUBLIC_BASE_URL || "visual-baseline://local").replace(/\/+$/, ""),
    requestLogPath:
      process.env.VISUAL_BASELINE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
