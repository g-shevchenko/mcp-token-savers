import path from "node:path";

export const DOCS_SYNC_SCHEMA_VERSION = "docs-sync.v0.1";
export const DOCS_SYNC_MEASUREMENT_SCHEMA_VERSION = "docs-sync-measurement.v0.1";
export const DOCS_SYNC_PIPELINE_VERSION = "2026-04-26.local-docs-sync-v0.1.1";

export interface DocsSyncConfig {
  artifactDir: string;
  cacheDir: string;
  maxArtifactChars: number;
  maxDocBytes: number;
  maxDocs: number;
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
  return home ? path.join(home, ".hwai", "docs-sync-mcp") : path.join("/tmp", "hwai-docs-sync-mcp-cache");
}

export function getDocsSyncConfig(): DocsSyncConfig {
  const cacheDir = process.env.DOCS_SYNC_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.DOCS_SYNC_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    maxArtifactChars: readPositiveInt(process.env.DOCS_SYNC_MAX_ARTIFACT_CHARS, 2_000_000),
    maxDocBytes: readPositiveInt(process.env.DOCS_SYNC_MAX_DOC_BYTES, 1_000_000),
    maxDocs: readPositiveInt(process.env.DOCS_SYNC_MAX_DOCS, 5_000),
    maxFindings: readPositiveInt(process.env.DOCS_SYNC_MAX_FINDINGS, 100),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.DOCS_SYNC_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.DOCS_SYNC_PUBLIC_BASE_URL || "docs-sync://local").replace(/\/+$/, ""),
    requestLogPath: process.env.DOCS_SYNC_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
