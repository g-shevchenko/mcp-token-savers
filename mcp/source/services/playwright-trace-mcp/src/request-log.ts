import fs from "node:fs/promises";
import path from "node:path";
import { PLAYWRIGHT_TRACE_PIPELINE_VERSION, PlaywrightTraceConfig } from "./config.js";
import { redactSecrets } from "./text-utils.js";

export interface RequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  transport: "mcp";
}

export async function appendRequestLog(config: PlaywrightTraceConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "playwright-trace-mcp",
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    ...event,
    error: event.error ? redactSecrets(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("playwright trace request log write failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
