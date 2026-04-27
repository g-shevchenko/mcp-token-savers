import fs from "node:fs/promises";
import path from "node:path";
import { REPO_HISTORY_PIPELINE_VERSION, RepoHistoryConfig } from "./config.js";
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

export async function appendRequestLog(config: RepoHistoryConfig, event: RequestLogEvent): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "repo-history-mcp",
    pipeline_version: REPO_HISTORY_PIPELINE_VERSION,
    ...event,
    error: event.error ? redactSecrets(event.error) : undefined,
  });

  try {
    await fs.mkdir(path.dirname(config.requestLogPath), { recursive: true });
    await fs.appendFile(config.requestLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error("repo history request log write failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
