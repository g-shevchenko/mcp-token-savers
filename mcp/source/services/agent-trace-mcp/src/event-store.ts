import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_TRACE_PIPELINE_VERSION, AgentTraceConfig } from "./config.js";
import { redactSecrets } from "./text-utils.js";

export interface TraceEvent {
  compact_tokens_estimate?: number;
  duration_ms?: number;
  event_id: string;
  event_type: "trace_started" | "step" | "tool_result";
  ok?: boolean;
  pipeline_version: string;
  raw_tokens_estimate?: number;
  saved_tokens_estimate?: number;
  service: "agent-trace-mcp";
  session_id: string;
  source?: string;
  status?: string;
  step_type?: string;
  summary_chars?: number;
  summary_hash?: string;
  summary_preview?: string;
  surface?: string;
  tags?: string[];
  task_id?: string;
  tool_name?: string;
  transport?: "mcp";
  ts: string;
  uncertainty?: number;
  utility_mcp?: string;
}

export async function appendEvent(config: AgentTraceConfig, event: Omit<TraceEvent, "pipeline_version" | "service" | "ts">): Promise<TraceEvent> {
  const row: TraceEvent = {
    ts: new Date().toISOString(),
    service: "agent-trace-mcp",
    pipeline_version: AGENT_TRACE_PIPELINE_VERSION,
    ...event,
  };
  try {
    await fs.mkdir(path.dirname(config.eventsLogPath), { recursive: true });
    await fs.appendFile(config.eventsLogPath, `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    console.error("agent trace event write failed:", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
  return row;
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readEvents(config: AgentTraceConfig): Promise<TraceEvent[]> {
  return readJsonl<TraceEvent>(config.eventsLogPath);
}
