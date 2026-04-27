import fs from "node:fs/promises";
import path from "node:path";
import { VisionRuntimeConfig } from "./config.js";

export interface VisionRequestLogEvent {
  duration_ms: number;
  error?: string;
  input?: Record<string, unknown>;
  ok: boolean;
  output?: Record<string, unknown>;
  tool: string;
  transport: "mcp" | "http";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(sk_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***");
}

export async function appendRequestLog(
  config: VisionRuntimeConfig,
  event: VisionRequestLogEvent,
): Promise<void> {
  if (!config.requestLogPath) {
    return;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "vision-mcp",
    pipeline_version: "2026-04-23.prep-first-diff",
    ...event,
    error: event.error ? safeError(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("vision request log write failed:", safeError(error));
  }
}
