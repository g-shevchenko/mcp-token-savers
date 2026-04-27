import { randomUUID } from "node:crypto";
import fetch from "node-fetch";
import { ContextPrepConfig } from "./config.js";

const FREE_TIER_CEILING = new Set(["firstparty", "curl_cffi", "httpx_warm", "patchright", "camoufox"]);

export interface ScraperCoreFetchOptions {
  allow_paid_tiers?: boolean;
  country?: string;
  max_tier?: string;
  metadata?: unknown;
  session_id?: string;
}

export interface ScraperCoreFetchResult {
  cache_hit?: boolean;
  challenge_detected?: string | null;
  duration_ms?: number;
  engine?: string;
  error?: string | null;
  final_url?: string;
  html?: string;
  jsonld?: unknown[];
  markdown?: string;
  metadata?: Record<string, unknown>;
  status?: number;
  text?: string;
  tiers_tried?: string[];
  title?: string;
  url?: string;
}

export function isScraperCoreConfigured(config: ContextPrepConfig): boolean {
  return Boolean(config.scraperCoreKey);
}

function safeContext(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") {
    return "context-prep-mcp";
  }

  const record = metadata as Record<string, unknown>;
  return [
    record.surface,
    record.project,
    record.repo,
    record.branch,
    record.session_id,
  ]
    .map((item) => (typeof item === "string" ? item : ""))
    .filter(Boolean)
    .join("/")
    .replace(/(?:token|key|secret|password)=[^&\s]+/gi, "$1=***")
    .slice(0, 64) || "context-prep-mcp";
}

function resolveMaxTier(config: ContextPrepConfig, options: ScraperCoreFetchOptions): string {
  const requested = options.max_tier || config.scraperMaxTier || "camoufox";
  if (options.allow_paid_tiers || FREE_TIER_CEILING.has(requested)) {
    return requested;
  }

  return "camoufox";
}

export async function fetchWithScraperCore(
  url: string,
  config: ContextPrepConfig,
  options: ScraperCoreFetchOptions = {},
): Promise<ScraperCoreFetchResult> {
  if (!config.scraperCoreKey) {
    throw new Error("scraper-core key is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.scraperTimeoutMs);
  const traceId = randomUUID();

  try {
    const response = await fetch(`${config.scraperCoreUrl}/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.scraperCoreKey}`,
        "Content-Type": "application/json",
        "User-Agent": "HWAI-Context-Prep-MCP/1.0",
        "X-HWAI-MCP": "context-prep-mcp@1.0.0",
        "X-HWAI-Context": safeContext(options.metadata),
        "X-HWAI-Trace-Id": traceId,
      },
      body: JSON.stringify({
        url,
        extract_markdown: true,
        max_tier: resolveMaxTier(config, options),
        bypass_cache: false,
        timeout_seconds: Math.ceil(config.scraperTimeoutMs / 1000),
        ...(options.country ? { country: options.country } : {}),
        ...(options.session_id ? { session_id: options.session_id } : {}),
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`scraper-core /fetch HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    return body ? (JSON.parse(body) as ScraperCoreFetchResult) : {};
  } finally {
    clearTimeout(timeout);
  }
}
