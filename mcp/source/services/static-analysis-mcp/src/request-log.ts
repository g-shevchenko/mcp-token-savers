import fs from "node:fs/promises";
import path from "node:path";
import { STATIC_ANALYSIS_PIPELINE_VERSION, StaticAnalysisConfig } from "./config.js";
import { redactSecrets } from "./text-utils.js";

export interface RequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  trace_source?: string;
  transport: "mcp";
}

function safeTraceLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80);
}

function classifyTraceSource(event: RequestLogEvent): string {
  const explicit = safeTraceLabel(event.trace_source);
  if (explicit) {
    return explicit;
  }

  const metadataSource = safeTraceLabel(event.input?.metadata_source);
  if (!metadataSource) {
    return "unknown";
  }

  const lower = metadataSource.toLowerCase();
  if (
    lower.includes("benchmark") ||
    lower.includes("smoke") ||
    lower.includes("regression") ||
    lower.includes("proof")
  ) {
    return "proof_loop";
  }

  return metadataSource;
}

export async function appendRequestLog(
  config: StaticAnalysisConfig,
  event: RequestLogEvent,
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "static-analysis-mcp",
    pipeline_version: STATIC_ANALYSIS_PIPELINE_VERSION,
    ...event,
    trace_source: classifyTraceSource(event),
    error: event.error ? redactSecrets(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("request log write failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
