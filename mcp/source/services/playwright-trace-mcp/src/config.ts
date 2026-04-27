import path from "node:path";

export const PLAYWRIGHT_TRACE_SCHEMA_VERSION = "playwright-trace.v1";
export const PLAYWRIGHT_TRACE_MEASUREMENT_SCHEMA_VERSION = "playwright-trace-measurement.v1";
export const PLAYWRIGHT_TRACE_PIPELINE_VERSION = "2026-04-24.local-playwright-trace-v1";

export interface PlaywrightTraceConfig {
  artifactDir: string;
  cacheDir: string;
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
    ? path.join(home, ".hwai", "playwright-trace-mcp")
    : path.join("/tmp", "hwai-playwright-trace-mcp-cache");
}

export function getPlaywrightTraceConfig(): PlaywrightTraceConfig {
  const cacheDir = process.env.PLAYWRIGHT_TRACE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.PLAYWRIGHT_TRACE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    maxArtifactChars: readPositiveInt(process.env.PLAYWRIGHT_TRACE_MAX_ARTIFACT_CHARS, 4_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.PLAYWRIGHT_TRACE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.PLAYWRIGHT_TRACE_PUBLIC_BASE_URL || "playwright-trace://local").replace(/\/+$/, ""),
    requestLogPath:
      process.env.PLAYWRIGHT_TRACE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
