import fs from "node:fs/promises";
import path from "node:path";
import { ContextPrepConfig } from "./config.js";

export interface RequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  transport: "mcp" | "rest" | "http";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(sk_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***");
}

export async function appendRequestLog(
  config: ContextPrepConfig,
  event: RequestLogEvent,
): Promise<void> {
  if (!config.requestLogPath) {
    return;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "context-prep-mcp",
    pipeline_version: "2026-04-23.parser-first-v1",
    ...event,
    error: event.error ? safeError(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("request log write failed:", safeError(error));
  }
}
