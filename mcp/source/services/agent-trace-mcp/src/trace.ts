import crypto from "node:crypto";
import { writeArtifact } from "./artifact-store.js";
import { AGENT_TRACE_SCHEMA_VERSION, AgentTraceConfig } from "./config.js";
import { appendEvent, readEvents, TraceEvent } from "./event-store.js";
import { estimateTokens, round, safePreview, stableHash } from "./text-utils.js";

export interface TraceWindowOptions {
  date?: string;
  since_iso?: string;
  until_iso?: string;
}

export interface TraceMetadata {
  source?: string;
  [key: string]: unknown;
}

function id(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return result.length ? result.slice(0, 20) : undefined;
}

function metadataSource(metadata: unknown, fallback?: string): string | undefined {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const source = asString((metadata as Record<string, unknown>).source);
    if (source) {
      return source.slice(0, 80);
    }
  }
  return fallback ? fallback.slice(0, 80) : undefined;
}

function dateRange(options: TraceWindowOptions): { date: string; since: Date; until: Date } {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const since = options.since_iso ? new Date(options.since_iso) : new Date(`${date}T00:00:00.000Z`);
  const until = options.until_iso
    ? new Date(options.until_iso)
    : new Date(since.getTime() + 24 * 60 * 60 * 1000);
  return { date, since, until };
}

function inRange(ts: string | undefined, since: Date, until: Date): boolean {
  if (!ts) {
    return false;
  }
  const parsed = new Date(ts);
  return Number.isFinite(parsed.getTime()) && parsed >= since && parsed < until;
}

function countBy<T>(rows: T[], keyFn: (row: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function sum(rows: TraceEvent[], key: keyof TraceEvent): number {
  return rows.reduce((total, row) => {
    const value = row[key];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function firstValue(rows: TraceEvent[], key: keyof TraceEvent): string | undefined {
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function traceSource(row: TraceEvent): string {
  return row.source || "unknown";
}

function compactMarkdown(sessionId: string, rows: TraceEvent[]): string {
  const raw = sum(rows, "raw_tokens_estimate");
  const compact = sum(rows, "compact_tokens_estimate");
  const saved = sum(rows, "saved_tokens_estimate") || Math.max(0, raw - compact);
  const lines = [
    "# Agent trace session summary",
    "",
    `Session: ${sessionId}`,
    `Events: ${rows.length}`,
    `Sources: ${Object.keys(countBy(rows, traceSource)).join(", ") || "unknown"}`,
    `Utilities: ${Object.keys(countBy(rows, (row) => row.utility_mcp)).join(", ") || "none"}`,
    `Token estimate: raw=${raw}, compact=${compact}, saved=${saved}`,
  ];
  return `${lines.join("\n")}\n`;
}

function setDiff(current: Record<string, number>, baseline: Record<string, number>): string[] {
  return Object.keys(current).filter((key) => key !== "unknown" && !baseline[key]).sort();
}

function buildSessionRollup(sessionId: string, rows: TraceEvent[]) {
  const rawTokens = sum(rows, "raw_tokens_estimate");
  const compactTokens = sum(rows, "compact_tokens_estimate");
  const savedTokens = sum(rows, "saved_tokens_estimate") || Math.max(0, rawTokens - compactTokens);
  const timestamps = rows
    .map((row) => new Date(row.ts).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    session_id: sessionId,
    task_id: firstValue(rows, "task_id"),
    surface: firstValue(rows, "surface"),
    events: rows.length,
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : undefined,
    ended_at: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : undefined,
    by_event_type: countBy(rows, (row) => row.event_type),
    by_status: countBy(rows, (row) => row.status),
    by_source: countBy(rows, traceSource),
    by_utility_mcp: countBy(rows, (row) => row.utility_mcp),
    by_tool: countBy(rows, (row) => row.tool_name),
    failed_events: rows.filter((row) => row.ok === false || row.status === "failed").length,
    high_uncertainty_count: rows.filter((row) => (row.uncertainty || 0) > 0.03).length,
    unknown_source_count: rows.filter((row) => !row.source).length,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

export async function startTrace(
  config: AgentTraceConfig,
  input: Record<string, unknown>,
) {
  const sessionId = asString(input.session_id) || id("trace");
  const summary = asString(input.summary) || asString(input.title);
  const event = await appendEvent(config, {
    event_id: id("evt"),
    event_type: "trace_started",
    ok: true,
    session_id: sessionId,
    source: metadataSource(input.metadata, asString(input.source)),
    status: "started",
    summary_chars: summary?.length,
    summary_hash: summary ? stableHash(summary) : undefined,
    summary_preview: safePreview(summary),
    surface: asString(input.surface),
    task_id: asString(input.task_id),
    tags: stringArray(input.tags),
    transport: "mcp",
  });
  return {
    schema_version: AGENT_TRACE_SCHEMA_VERSION,
    status: "started",
    session_id: sessionId,
    event_id: event.event_id,
    source: event.source || "unknown",
    data_policy: {
      raw_prompts_logged: false,
      raw_code_logged: false,
      pantheon_safe: true,
    },
  };
}

export async function recordStep(
  config: AgentTraceConfig,
  input: Record<string, unknown>,
) {
  const sessionId = asString(input.session_id);
  if (!sessionId) {
    throw new Error("session_id is required");
  }
  const summary = asString(input.summary);
  const rawTokens = asNumber(input.raw_tokens_estimate);
  const compactTokens = asNumber(input.compact_tokens_estimate);
  const savedTokens = asNumber(input.saved_tokens_estimate) ?? (
    rawTokens !== undefined && compactTokens !== undefined ? Math.max(0, rawTokens - compactTokens) : undefined
  );
  const event = await appendEvent(config, {
    compact_tokens_estimate: compactTokens,
    duration_ms: asNumber(input.duration_ms),
    event_id: id("evt"),
    event_type: "step",
    ok: asString(input.status) !== "failed",
    raw_tokens_estimate: rawTokens,
    saved_tokens_estimate: savedTokens,
    session_id: sessionId,
    source: metadataSource(input.metadata, asString(input.source)),
    status: asString(input.status) || "ok",
    step_type: asString(input.step_type) || "work",
    summary_chars: summary?.length,
    summary_hash: summary ? stableHash(summary) : undefined,
    summary_preview: safePreview(summary),
    surface: asString(input.surface),
    tags: stringArray(input.tags),
    task_id: asString(input.task_id),
    transport: "mcp",
  });
  return {
    schema_version: AGENT_TRACE_SCHEMA_VERSION,
    status: "recorded",
    session_id: sessionId,
    event_id: event.event_id,
    event_type: event.event_type,
    source: event.source || "unknown",
    raw_tokens_estimate: rawTokens || 0,
    compact_tokens_estimate: compactTokens || 0,
    saved_tokens_estimate: savedTokens || 0,
  };
}

export async function recordToolResult(
  config: AgentTraceConfig,
  input: Record<string, unknown>,
) {
  const sessionId = asString(input.session_id);
  if (!sessionId) {
    throw new Error("session_id is required");
  }
  const utilityMcp = asString(input.utility_mcp);
  const toolName = asString(input.tool_name);
  if (!utilityMcp || !toolName) {
    throw new Error("utility_mcp and tool_name are required");
  }
  const rawTokens = asNumber(input.raw_tokens_estimate);
  const compactTokens = asNumber(input.compact_tokens_estimate);
  const savedTokens = asNumber(input.saved_tokens_estimate) ?? (
    rawTokens !== undefined && compactTokens !== undefined ? Math.max(0, rawTokens - compactTokens) : undefined
  );
  const event = await appendEvent(config, {
    compact_tokens_estimate: compactTokens,
    duration_ms: asNumber(input.duration_ms),
    event_id: id("evt"),
    event_type: "tool_result",
    ok: asString(input.status) !== "failed",
    raw_tokens_estimate: rawTokens,
    saved_tokens_estimate: savedTokens,
    session_id: sessionId,
    source: metadataSource(input.metadata, asString(input.source)),
    status: asString(input.status) || "ok",
    surface: asString(input.surface),
    task_id: asString(input.task_id),
    tool_name: toolName,
    transport: "mcp",
    uncertainty: asNumber(input.uncertainty),
    utility_mcp: utilityMcp,
  });
  return {
    schema_version: AGENT_TRACE_SCHEMA_VERSION,
    status: "recorded",
    session_id: sessionId,
    event_id: event.event_id,
    utility_mcp: utilityMcp,
    tool_name: toolName,
    raw_tokens_estimate: rawTokens || 0,
    compact_tokens_estimate: compactTokens || 0,
    saved_tokens_estimate: savedTokens || 0,
  };
}

export async function summarizeSession(
  config: AgentTraceConfig,
  input: Record<string, unknown>,
) {
  const sessionId = asString(input.session_id);
  if (!sessionId) {
    throw new Error("session_id is required");
  }
  const allEvents = await readEvents(config);
  const rows = allEvents.filter((row) => row.session_id === sessionId);
  const rollup = buildSessionRollup(sessionId, rows);
  const markdown = compactMarkdown(sessionId, rows);
  const payload = {
    schema_version: AGENT_TRACE_SCHEMA_VERSION,
    ...rollup,
    compact_tokens_estimate: rollup.compact_tokens_estimate || estimateTokens(markdown),
    compact_markdown: markdown,
  };
  const hash = stableHash(`${sessionId}:${rows.length}:${rollup.raw_tokens_estimate}:${rollup.compact_tokens_estimate}:${rollup.saved_tokens_estimate}`);
  const jsonArtifact = await writeArtifact(config, `session-${hash}.summary.json`, JSON.stringify(payload, null, 2));
  const markdownArtifact = await writeArtifact(config, `session-${hash}.summary.md`, markdown);
  return {
    ...payload,
    artifacts: {
      summary_file: jsonArtifact.file,
      summary_url: jsonArtifact.url,
      compact_file: markdownArtifact.file,
      compact_url: markdownArtifact.url,
    },
  };
}

export async function compareSessions(
  config: AgentTraceConfig,
  input: Record<string, unknown>,
) {
  const baselineSessionId = asString(input.baseline_session_id) || asString(input.from_session_id);
  const candidateSessionId = asString(input.candidate_session_id) || asString(input.to_session_id);
  if (!baselineSessionId || !candidateSessionId) {
    throw new Error("baseline_session_id and candidate_session_id are required");
  }
  const allEvents = await readEvents(config);
  const baseline = buildSessionRollup(
    baselineSessionId,
    allEvents.filter((row) => row.session_id === baselineSessionId),
  );
  const candidate = buildSessionRollup(
    candidateSessionId,
    allEvents.filter((row) => row.session_id === candidateSessionId),
  );
  const delta = {
    events: candidate.events - baseline.events,
    failed_events: candidate.failed_events - baseline.failed_events,
    high_uncertainty_count: candidate.high_uncertainty_count - baseline.high_uncertainty_count,
    unknown_source_count: candidate.unknown_source_count - baseline.unknown_source_count,
    raw_tokens_estimate: candidate.raw_tokens_estimate - baseline.raw_tokens_estimate,
    compact_tokens_estimate: candidate.compact_tokens_estimate - baseline.compact_tokens_estimate,
    saved_tokens_estimate: candidate.saved_tokens_estimate - baseline.saved_tokens_estimate,
    savings_pct_points: round(candidate.savings_pct - baseline.savings_pct, 1),
  };
  const regressions = [
    delta.failed_events > 0 ? "failed_events_increased" : undefined,
    delta.high_uncertainty_count > 0 ? "high_uncertainty_increased" : undefined,
    delta.unknown_source_count > 0 ? "unknown_source_increased" : undefined,
    delta.saved_tokens_estimate < 0 ? "saved_tokens_decreased" : undefined,
  ].filter((item): item is string => typeof item === "string");
  return {
    schema_version: "agent-trace-session-diff.v1",
    status: "ok",
    baseline_session_id: baselineSessionId,
    candidate_session_id: candidateSessionId,
    baseline,
    candidate,
    delta,
    added: {
      sources: setDiff(candidate.by_source, baseline.by_source),
      utilities: setDiff(candidate.by_utility_mcp, baseline.by_utility_mcp),
      tools: setDiff(candidate.by_tool, baseline.by_tool),
    },
    removed: {
      sources: setDiff(baseline.by_source, candidate.by_source),
      utilities: setDiff(baseline.by_utility_mcp, candidate.by_utility_mcp),
      tools: setDiff(baseline.by_tool, candidate.by_tool),
    },
    regressions,
    data_policy: {
      aggregate_only: true,
      includes_raw_prompts: false,
      includes_raw_code: false,
      includes_file_paths: false,
      includes_artifact_urls: false,
      includes_event_summaries: false,
    },
  };
}

export async function exportPantheonSafe(
  config: AgentTraceConfig,
  input: TraceWindowOptions = {},
) {
  const { date, since, until } = dateRange(input);
  const rows = (await readEvents(config)).filter((row) => inRange(row.ts, since, until));
  const sessions = new Set(rows.map((row) => row.session_id)).size;
  const rawTokens = sum(rows, "raw_tokens_estimate");
  const compactTokens = sum(rows, "compact_tokens_estimate");
  const savedTokens = sum(rows, "saved_tokens_estimate") || Math.max(0, rawTokens - compactTokens);
  return {
    schema_version: "agent-trace-pantheon-export.v1",
    date,
    window: {
      since_iso: since.toISOString(),
      until_iso: until.toISOString(),
    },
    safe_for_pantheon: true,
    data_policy: {
      aggregate_only: true,
      includes_raw_prompts: false,
      includes_raw_code: false,
      includes_file_paths: false,
      includes_artifact_urls: false,
      includes_event_summaries: false,
    },
    summary: {
      events: rows.length,
      sessions,
      source_tokens_estimate: rawTokens,
      compact_tokens_estimate: compactTokens,
      saved_tokens_estimate: savedTokens,
      savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
      high_uncertainty_count: rows.filter((row) => (row.uncertainty || 0) > 0.03).length,
      unknown_source_count: rows.filter((row) => !row.source).length,
    },
    by_event_type: countBy(rows, (row) => row.event_type),
    by_source: countBy(rows, traceSource),
    by_surface: countBy(rows, (row) => row.surface),
    by_utility_mcp: countBy(rows, (row) => row.utility_mcp),
    by_tool: countBy(rows, (row) => row.tool_name),
  };
}
