import fs from "node:fs/promises";
import path from "node:path";
import { DOCS_SYNC_PIPELINE_VERSION, DocsSyncConfig } from "./config.js";
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

export async function appendRequestLog(config: DocsSyncConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "docs-sync-mcp",
    pipeline_version: DOCS_SYNC_PIPELINE_VERSION,
    ...event,
    error: event.error ? redactSensitive(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("docs sync request log write failed:", redactSensitive(error instanceof Error ? error.message : String(error)));
  }
}
