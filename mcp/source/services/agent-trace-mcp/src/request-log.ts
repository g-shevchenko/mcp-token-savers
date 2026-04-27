import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_TRACE_PIPELINE_VERSION, AgentTraceConfig } from "./config.js";
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

export async function appendRequestLog(config: AgentTraceConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "agent-trace-mcp",
    pipeline_version: AGENT_TRACE_PIPELINE_VERSION,
    ...event,
    error: event.error ? redactSecrets(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("agent trace request log write failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
