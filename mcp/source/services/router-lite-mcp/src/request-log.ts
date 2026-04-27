import fs from "node:fs/promises";
import path from "node:path";
import { ROUTER_LITE_PIPELINE_VERSION, RouterLiteConfig } from "./config.js";

export interface RequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  transport: "mcp";
}

export async function appendRequestLog(config: RouterLiteConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "router-lite-mcp",
    pipeline_version: ROUTER_LITE_PIPELINE_VERSION,
    ...event,
  });
  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("router-lite request log write failed:", error instanceof Error ? error.message : String(error));
  }
}
