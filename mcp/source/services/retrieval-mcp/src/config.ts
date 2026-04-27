import path from "node:path";

export const RETRIEVAL_SCHEMA_VERSION = "retrieval.v1";
export const RETRIEVAL_PIPELINE_VERSION = "2026-04-23.local-rg-symbol-fanout-hints-measure-v4";

export interface RetrievalConfig {
  artifactDir: string;
  cacheDir: string;
  commandTimeoutMs: number;
  defaultRoot: string;
  httpHost: string;
  httpPort: number;
  maxBodyBytes: number;
  maxFileBytes: number;
  maxRipgrepBufferBytes: number;
  measurementUsdPer1MTokens: number;
  publicBaseUrl: string;
  feedbackLogPath: string;
  requestLogPath: string;
  transportMode: "stdio" | "http";
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePublicBaseUrl(host: string, port: number): string {
  const explicit = process.env.RETRIEVAL_PUBLIC_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${normalizedHost}:${port}`;
}

function resolveDefaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  if (home) {
    return path.join(home, ".hwai", "retrieval-mcp");
  }
  return path.join("/tmp", "hwai-retrieval-mcp-cache");
}

export function getRetrievalConfig(): RetrievalConfig {
  const httpHost = process.env.RETRIEVAL_HTTP_HOST || "127.0.0.1";
  const httpPort = readPositiveInt(process.env.RETRIEVAL_HTTP_PORT, 3395);
  const cacheDir = process.env.RETRIEVAL_CACHE_DIR || resolveDefaultCacheDir();

  return {
    artifactDir: process.env.RETRIEVAL_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    commandTimeoutMs: readPositiveInt(process.env.RETRIEVAL_COMMAND_TIMEOUT_MS, 8000),
    defaultRoot: process.env.RETRIEVAL_DEFAULT_ROOT || process.cwd(),
    httpHost,
    httpPort,
    maxBodyBytes: readPositiveInt(process.env.RETRIEVAL_MAX_BODY_BYTES, 2 * 1024 * 1024),
    maxFileBytes: readPositiveInt(process.env.RETRIEVAL_MAX_FILE_BYTES, 512 * 1024),
    maxRipgrepBufferBytes: readPositiveInt(
      process.env.RETRIEVAL_MAX_RG_BUFFER_BYTES,
      8 * 1024 * 1024,
    ),
    measurementUsdPer1MTokens: readPositiveFloat(
      process.env.RETRIEVAL_USD_PER_1M_TOKENS,
      3,
    ),
    publicBaseUrl: resolvePublicBaseUrl(httpHost, httpPort),
    feedbackLogPath:
      process.env.RETRIEVAL_FEEDBACK_LOG_PATH || path.join(cacheDir, "feedback.jsonl"),
    requestLogPath:
      process.env.RETRIEVAL_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    transportMode:
      process.argv.includes("--http") || process.env.RETRIEVAL_TRANSPORT === "http"
        ? "http"
        : "stdio",
  };
}
