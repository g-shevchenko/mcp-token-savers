import path from "node:path";

export const SCREENSHOT_ANALYSIS_PROMPT_VERSION = "2026-04-23.phase8-diff-mode";
export const CROP_PIPELINE_VERSION = "2026-04-23.red-annotation-regions-v4";
export const OPTIMIZATION_PIPELINE_VERSION = "2026-04-23.prep-first-diff";

export interface VisionRuntimeConfig {
  allowAnyImageUrl: boolean;
  allowedHosts: string[];
  artifactDir: string;
  cacheDir: string;
  cacheTtlMs: number;
  httpHost: string;
  httpPort: number;
  maxImageSizeBytes: number;
  ocrEnabled: boolean;
  ocrLang: string;
  ocrTimeoutMs: number;
  publicBaseUrl: string;
  requestLogPath: string;
  ollamaBaseUrl: string;
  ollamaGenerateUrl: string;
  transportMode: "stdio" | "http";
  vlmModel: string;
  vlmTimeoutMs: number;
}

function splitCsv(raw: string | undefined, defaults: string[]): string[] {
  if (!raw) {
    return defaults;
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

function normalizeBaseUrl(raw: string | undefined): string {
  const base = raw?.trim() || "http://127.0.0.1:11434";
  return base.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(host: string, port: number): string {
  const explicit = process.env.VISION_MCP_PUBLIC_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${normalizedHost}:${port}`;
}

function defaultCacheDir(): string {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".hwai", "vision-mcp") : path.join("/tmp", "hwai-vision-mcp-cache");
}

export function getVisionConfig(): VisionRuntimeConfig {
  const ollamaBaseUrl = normalizeBaseUrl(process.env.VISION_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL);
  const httpHost = process.env.VISION_MCP_HTTP_HOST || "127.0.0.1";
  const httpPort = readPositiveInt(process.env.VISION_MCP_HTTP_PORT, 3393);
  const cacheDir = process.env.VISION_MCP_CACHE_DIR || defaultCacheDir();

  return {
    allowAnyImageUrl: process.env.ALLOW_ANY_IMAGE_URL === "1",
    allowedHosts: splitCsv(process.env.VISION_ALLOWED_HOSTS, ["example.com"]),
    artifactDir: process.env.VISION_MCP_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    cacheTtlMs: readPositiveInt(process.env.VISION_MCP_CACHE_TTL_SEC, 7 * 24 * 60 * 60) * 1000,
    httpHost,
    httpPort,
    maxImageSizeBytes: readPositiveInt(process.env.VISION_MAX_IMAGE_SIZE_BYTES, 8 * 1024 * 1024),
    ocrEnabled: process.env.VISION_MCP_ENABLE_OCR !== "0",
    ocrLang: process.env.VISION_MCP_OCR_LANG || "eng",
    ocrTimeoutMs: readPositiveInt(process.env.VISION_MCP_OCR_TIMEOUT_MS, 7000),
    publicBaseUrl: resolvePublicBaseUrl(httpHost, httpPort),
    requestLogPath: process.env.VISION_MCP_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
    ollamaBaseUrl,
    ollamaGenerateUrl: `${ollamaBaseUrl}/api/generate`,
    transportMode: process.argv.includes("--http") || process.env.VISION_MCP_TRANSPORT === "http" ? "http" : "stdio",
    vlmModel: process.env.VISION_VLM_MODEL || "qwen3-vl:latest",
    vlmTimeoutMs: readPositiveInt(process.env.VISION_VLM_TIMEOUT_MS, 300000),
  };
}
