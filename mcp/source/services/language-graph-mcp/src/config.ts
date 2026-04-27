import path from "node:path";

export const LANGUAGE_GRAPH_SCHEMA_VERSION = "language-graph.v1";
export const LANGUAGE_GRAPH_MEASUREMENT_SCHEMA_VERSION = "language-graph-measurement.v1";
export const LANGUAGE_GRAPH_PIPELINE_VERSION = "2026-04-26.local-language-graph-v0.1.1";

export interface LanguageGraphConfig {
  artifactDir: string;
  cacheDir: string;
  indexDir: string;
  maxArtifactChars: number;
  maxFileBytes: number;
  maxFiles: number;
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
  return home ? path.join(home, ".hwai", "language-graph-mcp") : path.join("/tmp", "hwai-language-graph-mcp-cache");
}

export function getLanguageGraphConfig(): LanguageGraphConfig {
  const cacheDir = process.env.LANGUAGE_GRAPH_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.LANGUAGE_GRAPH_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    indexDir: process.env.LANGUAGE_GRAPH_INDEX_DIR || path.join(cacheDir, "indexes"),
    maxArtifactChars: readPositiveInt(process.env.LANGUAGE_GRAPH_MAX_ARTIFACT_CHARS, 2_000_000),
    maxFileBytes: readPositiveInt(process.env.LANGUAGE_GRAPH_MAX_FILE_BYTES, 512_000),
    maxFiles: readPositiveInt(process.env.LANGUAGE_GRAPH_MAX_FILES, 4_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.LANGUAGE_GRAPH_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.LANGUAGE_GRAPH_PUBLIC_BASE_URL || "language-graph://local").replace(/\/+$/, ""),
    requestLogPath: process.env.LANGUAGE_GRAPH_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
