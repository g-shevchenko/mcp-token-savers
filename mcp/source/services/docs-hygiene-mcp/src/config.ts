import path from "node:path";

export const DOCS_HYGIENE_SCHEMA_VERSION = "docs-hygiene.v0.1";
export const DOCS_HYGIENE_MEASUREMENT_SCHEMA_VERSION = "docs-hygiene-measurement.v0.1";
export const DOCS_HYGIENE_PIPELINE_VERSION = "2026-04-26.local-docs-hygiene-v0.1.1";

export interface DocsHygieneConfig {
  artifactDir: string;
  cacheDir: string;
  duplicateMinSectionLines: number;
  largeDocLines: number;
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
  return home ? path.join(home, ".hwai", "docs-hygiene-mcp") : path.join("/tmp", "hwai-docs-hygiene-mcp-cache");
}

export function getDocsHygieneConfig(): DocsHygieneConfig {
  const cacheDir = process.env.DOCS_HYGIENE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.DOCS_HYGIENE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    duplicateMinSectionLines: readPositiveInt(process.env.DOCS_HYGIENE_DUPLICATE_MIN_SECTION_LINES, 4),
    largeDocLines: readPositiveInt(process.env.DOCS_HYGIENE_LARGE_DOC_LINES, 800),
    maxArtifactChars: readPositiveInt(process.env.DOCS_HYGIENE_MAX_ARTIFACT_CHARS, 2_000_000),
    maxFileBytes: readPositiveInt(process.env.DOCS_HYGIENE_MAX_FILE_BYTES, 512_000),
    maxFiles: readPositiveInt(process.env.DOCS_HYGIENE_MAX_FILES, 6_000),
    maxFindings: readPositiveInt(process.env.DOCS_HYGIENE_MAX_FINDINGS, 100),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.DOCS_HYGIENE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.DOCS_HYGIENE_PUBLIC_BASE_URL || "docs-hygiene://local").replace(/\/+$/, ""),
    requestLogPath: process.env.DOCS_HYGIENE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
