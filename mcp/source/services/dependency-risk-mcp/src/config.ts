import path from "node:path";

export const DEPENDENCY_RISK_SCHEMA_VERSION = "dependency-risk.v0.1";
export const DEPENDENCY_RISK_MEASUREMENT_SCHEMA_VERSION = "dependency-risk-measurement.v0.1";
export const DEPENDENCY_RISK_PIPELINE_VERSION = "2026-04-27.local-dependency-risk-v0.1.2";

export interface DependencyRiskConfig {
  artifactDir: string;
  cacheDir: string;
  defaultDisallowedLicenses: string[];
  maxArtifactChars: number;
  maxFindings: number;
  maxJsonBytes: number;
  measurementUsdPer1MTokens: number;
  publicBaseUrl: string;
  requestLogPath: string;
  toolTimeoutMs: number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readList(raw: string | undefined, fallback: string[]): string[] {
  const values = (raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".hwai", "dependency-risk-mcp") : path.join("/tmp", "hwai-dependency-risk-mcp-cache");
}

export function getDependencyRiskConfig(): DependencyRiskConfig {
  const cacheDir = process.env.DEPENDENCY_RISK_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.DEPENDENCY_RISK_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    defaultDisallowedLicenses: readList(process.env.DEPENDENCY_RISK_DISALLOWED_LICENSES, [
      "AGPL-3.0",
      "AGPL-3.0-only",
      "AGPL-3.0-or-later",
      "GPL-3.0",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
    ]),
    maxArtifactChars: readPositiveInt(process.env.DEPENDENCY_RISK_MAX_ARTIFACT_CHARS, 2_000_000),
    maxFindings: readPositiveInt(process.env.DEPENDENCY_RISK_MAX_FINDINGS, 100),
    maxJsonBytes: readPositiveInt(process.env.DEPENDENCY_RISK_MAX_JSON_BYTES, 5_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.DEPENDENCY_RISK_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.DEPENDENCY_RISK_PUBLIC_BASE_URL || "dependency-risk://local").replace(/\/+$/, ""),
    requestLogPath: process.env.DEPENDENCY_RISK_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    toolTimeoutMs: readPositiveInt(process.env.DEPENDENCY_RISK_TOOL_TIMEOUT_MS, 45_000),
  };
}
