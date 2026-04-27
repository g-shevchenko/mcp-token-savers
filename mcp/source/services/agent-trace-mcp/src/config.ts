import path from "node:path";

export const AGENT_TRACE_SCHEMA_VERSION = "agent-trace.v1";
export const AGENT_TRACE_MEASUREMENT_SCHEMA_VERSION = "agent-trace-measurement.v1";
export const AGENT_TRACE_PIPELINE_VERSION = "2026-04-24.local-agent-trace-v1";

export interface AgentTraceConfig {
  artifactDir: string;
  cacheDir: string;
  eventsLogPath: string;
  maxArtifactChars: number;
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
  return home
    ? path.join(home, ".hwai", "agent-trace-mcp")
    : path.join("/tmp", "hwai-agent-trace-mcp-cache");
}

export function getAgentTraceConfig(): AgentTraceConfig {
  const cacheDir = process.env.AGENT_TRACE_CACHE_DIR || defaultCacheDir();
  return {
    artifactDir: process.env.AGENT_TRACE_ARTIFACT_DIR || path.join(cacheDir, "artifacts"),
    cacheDir,
    eventsLogPath: process.env.AGENT_TRACE_EVENTS_LOG_PATH || path.join(cacheDir, "events.jsonl"),
    maxArtifactChars: readPositiveInt(process.env.AGENT_TRACE_MAX_ARTIFACT_CHARS, 2_000_000),
    measurementUsdPer1MTokens: readPositiveFloat(process.env.AGENT_TRACE_USD_PER_1M_TOKENS, 3),
    publicBaseUrl: (process.env.AGENT_TRACE_PUBLIC_BASE_URL || "agent-trace://local").replace(/\/+$/, ""),
    requestLogPath: process.env.AGENT_TRACE_REQUEST_LOG_PATH || path.join(cacheDir, "requests.jsonl"),
  };
}
