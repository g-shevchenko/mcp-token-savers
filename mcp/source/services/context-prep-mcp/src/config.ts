import path from "node:path";

export const CONTEXT_PREP_SCHEMA_VERSION = "context-prep.v1";
export const CONTEXT_PREP_PIPELINE_VERSION = "2026-04-23.parser-first-v1";

export interface ContextPrepConfig {
  allowAnyUrl: boolean;
  allowedHosts: string[];
  allowPrivateUrls: boolean;
  artifactDir: string;
  cacheDir: string;
  fetchTimeoutMs: number;
  httpHost: string;
  httpPort: number;
  maxBodyBytes: number;
  maxInputChars: number;
  publicBaseUrl: string;
  requestLogPath: string;
  scraperCoreKey: string;
  scraperCoreUrl: string;
  scraperFallbackMode: "auto" | "disabled";
  scraperMaxTier: string;
  scraperTimeoutMs: number;
  transportMode: "stdio" | "http";
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePublicBaseUrl(host: string, port: number): string {
  const explicit = process.env.CONTEXT_PREP_PUBLIC_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${normalizedHost}:${port}`;
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  return home
    ? path.join(home, ".hwai", "context-prep-mcp")
    : path.join("/tmp", "hwai-context-prep-mcp-cache");
}

export function getContextPrepConfig(): ContextPrepConfig {
  const httpHost = process.env.CONTEXT_PREP_HTTP_HOST || "127.0.0.1";
  const httpPort = readPositiveInt(process.env.CONTEXT_PREP_HTTP_PORT, 3394);
  const cacheDir = process.env.CONTEXT_PREP_CACHE_DIR || defaultCacheDir();

  return {
    allowAnyUrl: process.env.CONTEXT_PREP_ALLOW_ANY_URL !== "0",
    allowedHosts: splitCsv(process.env.CONTEXT_PREP_ALLOWED_HOSTS),
    allowPrivateUrls: process.env.CONTEXT_PREP_ALLOW_PRIVATE_URLS === "1",
    artifactDir: process.env.CONTEXT_PREP_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    fetchTimeoutMs: readPositiveInt(process.env.CONTEXT_PREP_FETCH_TIMEOUT_MS, 8000),
    httpHost,
    httpPort,
    maxBodyBytes: readPositiveInt(process.env.CONTEXT_PREP_MAX_BODY_BYTES, 2 * 1024 * 1024),
    maxInputChars: readPositiveInt(process.env.CONTEXT_PREP_MAX_INPUT_CHARS, 500_000),
    publicBaseUrl: resolvePublicBaseUrl(httpHost, httpPort),
    requestLogPath:
      process.env.CONTEXT_PREP_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    scraperCoreKey: process.env.CONTEXT_PREP_SCRAPER_KEY || "",
    scraperCoreUrl:
      (process.env.CONTEXT_PREP_SCRAPER_CORE_URL ||
        "http://localhost:8090").replace(/\/+$/, ""),
    scraperFallbackMode:
      process.env.CONTEXT_PREP_SCRAPER_FALLBACK === "disabled" ? "disabled" : "auto",
    scraperMaxTier: process.env.CONTEXT_PREP_SCRAPER_MAX_TIER || "camoufox",
    scraperTimeoutMs: readPositiveInt(process.env.CONTEXT_PREP_SCRAPER_TIMEOUT_MS, 30_000),
    transportMode:
      process.argv.includes("--http") || process.env.CONTEXT_PREP_TRANSPORT === "http"
        ? "http"
        : "stdio",
  };
}
