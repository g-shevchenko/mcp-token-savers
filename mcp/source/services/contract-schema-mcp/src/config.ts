import path from "node:path";

export const CONTRACT_SCHEMA_SCHEMA_VERSION = "contract-schema.v0.1";
export const CONTRACT_SCHEMA_MEASUREMENT_SCHEMA_VERSION = "contract-schema-measurement.v0.1";
export const CONTRACT_SCHEMA_PIPELINE_VERSION = "2026-04-26.local-contract-schema-v0.1.1";

export interface ContractSchemaConfig {
  artifactDir: string;
  cacheDir: string;
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
  return home ? path.join(home, ".hwai", "contract-schema-mcp") : path.join("/tmp", "hwai-contract-schema-mcp-cache");
}

export function getContractSchemaConfig(): ContractSchemaConfig {
  const cacheDir = process.env.CONTRACT_SCHEMA_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.CONTRACT_SCHEMA_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    maxArtifactChars: readPositiveInt(process.env.CONTRACT_SCHEMA_MAX_ARTIFACT_CHARS, 2_000_000),
    maxFileBytes: readPositiveInt(process.env.CONTRACT_SCHEMA_MAX_FILE_BYTES, 1_000_000),
    maxFiles: readPositiveInt(process.env.CONTRACT_SCHEMA_MAX_FILES, 6_000),
    maxFindings: readPositiveInt(process.env.CONTRACT_SCHEMA_MAX_FINDINGS, 100),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.CONTRACT_SCHEMA_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.CONTRACT_SCHEMA_PUBLIC_BASE_URL || "contract-schema://local").replace(/\/+$/, ""),
    requestLogPath: process.env.CONTRACT_SCHEMA_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
