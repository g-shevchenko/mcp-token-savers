import path from "node:path";

export const ROUTER_LITE_SCHEMA_VERSION = "router-lite.v0.1";
export const ROUTER_LITE_MEASUREMENT_SCHEMA_VERSION = "router-lite-measurement.v0.1";
export const ROUTER_LITE_PIPELINE_VERSION = "2026-04-27.trigger-policy-v0.1.0";

export interface RouterLiteConfig {
  cacheDir: string;
  measurementUsdPer1MTokens: number;
  requestLogPath: string;
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".hwai", "router-lite-mcp") : path.join("/tmp", "hwai-router-lite-mcp-cache");
}

function readPositiveFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRouterLiteConfig(): RouterLiteConfig {
  const cacheDir = process.env.ROUTER_LITE_CACHE_DIR || defaultCacheDir();
  return {
    cacheDir,
    measurementUsdPer1MTokens: readPositiveFloat(process.env.ROUTER_LITE_USD_PER_1M_TOKENS, 3),
    requestLogPath: process.env.ROUTER_LITE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
