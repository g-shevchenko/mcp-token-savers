import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type ContextEvent = {
  session_id: string;
  surface: "claude-code" | "codex" | "cursor" | "windsurf" | "automation" | "other";
  event_type: "tool_result" | "decision" | "handoff" | "approval" | "error" | "milestone";
  summary: string;
  artifact_paths?: string[];
  token_estimate?: number;
  trust_label?: "trusted" | "semi_trusted" | "untrusted";
};

export type StoredEvent = ContextEvent & {
  schema_version: "context-handoff.event.v1";
  id: string;
  ts: string;
};

export function defaultDataDir(): string {
  return process.env.CONTEXT_HANDOFF_CACHE_DIR || path.join(os.homedir(), ".hwai", "context-handoff-mcp");
}

function eventFile(dataDir: string): string {
  return path.join(dataDir, "events.jsonl");
}

function sanitizeEvent(event: ContextEvent): ContextEvent {
  return {
    session_id: event.session_id.slice(0, 120),
    surface: event.surface,
    event_type: event.event_type,
    summary: event.summary.slice(0, 1000),
    artifact_paths: event.artifact_paths?.slice(0, 20),
    token_estimate: event.token_estimate,
    trust_label: event.trust_label,
  };
}

export async function recordEvent(event: ContextEvent, options?: { data_dir?: string }): Promise<StoredEvent> {
  const dataDir = options?.data_dir || defaultDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const clean = sanitizeEvent(event);
  const stored: StoredEvent = {
    schema_version: "context-handoff.event.v1",
    id: `evt_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    ...clean,
  };
  await fs.appendFile(eventFile(dataDir), `${JSON.stringify(stored)}\n`, "utf8");
  return stored;
}

async function readEvents(dataDir: string): Promise<StoredEvent[]> {
  try {
    const text = await fs.readFile(eventFile(dataDir), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredEvent];
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

export async function getStats(options?: { data_dir?: string }): Promise<{
  schema_version: "context-handoff.stats.v1";
  total_events: number;
  by_surface: Record<string, number>;
  by_event_type: Record<string, number>;
}> {
  const events = await readEvents(options?.data_dir || defaultDataDir());
  const bySurface: Record<string, number> = {};
  const byEventType: Record<string, number> = {};
  for (const event of events) {
    bySurface[event.surface] = (bySurface[event.surface] || 0) + 1;
    byEventType[event.event_type] = (byEventType[event.event_type] || 0) + 1;
  }
  return {
    schema_version: "context-handoff.stats.v1",
    total_events: events.length,
    by_surface: bySurface,
    by_event_type: byEventType,
  };
}

export async function latestEvents(options?: { data_dir?: string; session_id?: string; limit?: number }): Promise<StoredEvent[]> {
  const events = await readEvents(options?.data_dir || defaultDataDir());
  const filtered = options?.session_id ? events.filter((event) => event.session_id === options.session_id) : events;
  return filtered.slice(-(options?.limit || 20)).reverse();
}
