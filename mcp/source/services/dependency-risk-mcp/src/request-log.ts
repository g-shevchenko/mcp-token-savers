import fs from "node:fs/promises";
import path from "node:path";
import { DEPENDENCY_RISK_PIPELINE_VERSION, DependencyRiskConfig } from "./config.js";
import { redactSensitive } from "./text-utils.js";

export interface RequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  transport: "mcp";
}

export async function appendRequestLog(config: DependencyRiskConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "dependency-risk-mcp",
    pipeline_version: DEPENDENCY_RISK_PIPELINE_VERSION,
    ...event,
    error: event.error ? redactSensitive(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("dependency risk request log write failed:", redactSensitive(error instanceof Error ? error.message : String(error)));
  }
}
