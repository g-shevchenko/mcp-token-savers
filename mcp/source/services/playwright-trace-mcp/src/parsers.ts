import path from "node:path";
import {
  PLAYWRIGHT_TRACE_PIPELINE_VERSION,
  PLAYWRIGHT_TRACE_SCHEMA_VERSION,
  PlaywrightTraceConfig,
} from "./config.js";
import { writeArtifact } from "./artifact-store.js";
import { estimateTokens, redactSecrets, round, safeUrlPreview, stableHash } from "./text-utils.js";
import { isNetworkEntry, isScreenshotEntry, isTraceEntry, listZipEntries, readZipEntry } from "./zip-utils.js";

export interface TraceInput {
  console_json?: string;
  console_text?: string;
  har_json?: string;
  max_events?: number;
  max_screenshots?: number;
  network_json?: string;
  screenshot_paths?: string[];
  trace_json?: string;
  trace_text?: string;
  trace_zip_path?: string;
}

interface ConsoleFinding {
  location?: string;
  text: string;
  time_ms?: number;
  type: "error" | "warning" | "log";
}

interface NetworkFinding {
  duration_ms?: number;
  end_time_ms?: number;
  method?: string;
  status?: number;
  status_text?: string;
  time_ms?: number;
  url?: string;
  url_hash?: string;
}

interface ActionFinding {
  api_name?: string;
  call_id?: string;
  duration_ms?: number;
  end_time_ms?: number;
  error?: string;
  selector?: string;
  start_time_ms?: number;
  title?: string;
}

interface ParsedEvidence {
  actions: ActionFinding[];
  console: ConsoleFinding[];
  errors: string[];
  network: NetworkFinding[];
  raw_chars: number;
  screenshot_entries: string[];
  source_kind: "inline" | "zip" | "empty";
  zip_entries_count?: number;
}

interface FailureWindow {
  anchor_kind: string;
  anchor_time_ms?: number;
  nearby_actions: Array<{
    api_name?: string;
    call_id?: string;
    duration_ms?: number;
    error?: string;
    selector?: string;
    start_time_ms?: number;
  }>;
  nearby_console_errors: number;
  nearby_network_failures: number;
  nearby_slow_requests: number;
  range_end_ms?: number;
  range_start_ms?: number;
  summary: string;
  warnings: string[];
}

function parseJsonLines(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [{ text: line }];
        }
      });
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return textOf(obj.text) || textOf(obj.message) || textOf(obj.error) || textOf(obj.value);
  }
  return undefined;
}

function statusOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function urlHash(url: string | undefined): string | undefined {
  return url ? stableHash(url) : undefined;
}

function scanObject(value: unknown, evidence: ParsedEvidence): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const obj = value as Record<string, unknown>;
  const params = objectOf(obj.params);
  const request = objectOf(obj.request);
  const response = objectOf(obj.response);
  const failure = objectOf(obj.failure);
  const errorObject = objectOf(obj.error);
  const messageObject = objectOf(obj.message) || objectOf(params?.message);
  const className = textOf(obj.class);
  const rawMethod = textOf(obj.method);
  const method = rawMethod || textOf(obj.apiName) || textOf(obj.api_name);
  const methodLower = (method || "").toLowerCase();
  const apiName =
    textOf(obj.apiName) ||
    textOf(obj.api_name) ||
    (className && rawMethod ? `${className}.${rawMethod}` : method && method.includes(".") ? method : undefined);
  const eventType = `${textOf(obj.type) || ""} ${textOf(obj.event) || ""} ${textOf(obj.class) || ""}`.toLowerCase();
  const message =
    textOf(obj.message) ||
    textOf(obj.text) ||
    textOf(obj.error) ||
    textOf(errorObject?.message) ||
    textOf(params?.message);
  const url = textOf(obj.url) || textOf(request?.url);
  const status = statusOf(obj.status) || statusOf(obj.statusCode) || statusOf(response?.status);
  const statusText = textOf(obj.statusText) || textOf(obj.errorText) || textOf(failure?.errorText);
  const statusTextLooksFailure = /abort|blocked|error|failed|net::|timeout/i.test(statusText || "");
  const timing = objectOf(obj.timing) || objectOf(obj.timings);
  const explicitDuration = statusOf(obj.duration_ms) || statusOf(obj.duration) || statusOf(timing?.duration);
  const networkDuration = request || response || eventType.includes("resource") ? statusOf(obj.time) : undefined;
  const durationMs = explicitDuration || networkDuration;
  const networkStartMs = timeOf(obj._monotonicTime) || timeOf(obj.monotonicTime);
  const eventTimeMs = timeOf(obj.time) || networkStartMs;
  const networkEndMs =
    networkStartMs !== undefined && durationMs !== undefined
      ? networkStartMs + durationMs
      : networkStartMs;
  const consoleType = `${textOf(obj.type) || ""} ${textOf(obj.messageType) || ""} ${textOf(messageObject?.type) || ""}`.toLowerCase();
  const consoleLike =
    eventType.includes("console") ||
    methodLower === "console" ||
    consoleType.includes("error") ||
    consoleType.includes("warning") ||
    consoleType.includes("log");

  if (message && consoleLike) {
    const type = consoleType.includes("warning") ? "warning" : consoleType.includes("log") ? "log" : "error";
    evidence.console.push({
      location: textOf(obj.location),
      text: redactSecrets(message),
      time_ms: eventTimeMs,
      type,
    });
  }

  if (message && (eventType.includes("error") || obj.error || obj.errorText)) {
    evidence.errors.push(redactSecrets(message));
  }

  const networkLike =
    Boolean(url) ||
    status !== undefined ||
    eventType.includes("request") ||
    eventType.includes("response") ||
    eventType.includes("network") ||
    methodLower.includes("request") ||
    methodLower.includes("response");
  const hasNetworkRequestContext = Boolean(url || request);
  const hasNetworkResult = status !== undefined || durationMs !== undefined || statusTextLooksFailure;
  if (networkLike && ((hasNetworkRequestContext && hasNetworkResult) || (status === undefined && statusTextLooksFailure))) {
    evidence.network.push({
      duration_ms: durationMs,
      end_time_ms: networkEndMs,
      method: method && /^[A-Z]+$/.test(method) ? method : textOf(request?.method),
      status,
      status_text: statusText,
      time_ms: networkStartMs,
      url,
      url_hash: urlHash(url),
    });
  }

  const callId = textOf(obj.callId) || textOf(obj.call_id);
  const startTime = statusOf(obj.startTime) || statusOf(obj.start_time);
  const endTime = statusOf(obj.endTime) || statusOf(obj.end_time);
  const actionError = message && (obj.error || eventType.includes("error") || eventType.includes("after")) ? redactSecrets(message) : undefined;
  const actionLike = Boolean(callId || apiName || obj.beforeSnapshot || obj.afterSnapshot || actionError);
  if (actionLike) {
    evidence.actions.push({
      api_name: apiName,
      call_id: callId,
      duration_ms: durationMs,
      end_time_ms: endTime,
      error: actionError,
      selector: textOf(params?.selector),
      start_time_ms: startTime,
      title: textOf(obj.title),
    });
  }

  for (const child of Object.values(obj)) {
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child.slice(0, 1000)) {
          scanObject(item, evidence);
        }
      } else {
        scanObject(child, evidence);
      }
    }
  }
}

function scanConsoleText(raw: string, evidence: ParsedEvidence): void {
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    const lower = text.toLowerCase();
    if (!/(error|warning|warn|exception|failed|failure)/.test(lower)) {
      continue;
    }
    evidence.console.push({
      text: redactSecrets(text),
      type: lower.includes("warn") ? "warning" : "error",
    });
  }
}

function scanNetworkText(raw: string, evidence: ParsedEvidence): void {
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) {
      continue;
    }
    const status = statusOf(text.match(/\b([1-5][0-9]{2})\b/)?.[1]);
    const url = text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
    const method = text.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/)?.[1];
    if (!status && !url) {
      continue;
    }
    evidence.network.push({
      method,
      status,
      status_text: /timeout|failed|blocked|abort/i.test(text) ? redactSecrets(text) : undefined,
      url,
      url_hash: urlHash(url),
    });
  }
}

function mergeActions(rows: ActionFinding[]): ActionFinding[] {
  const byCallId = new Map<string, ActionFinding>();
  const withoutCallId: ActionFinding[] = [];

  for (const row of rows) {
    if (!row.call_id) {
      withoutCallId.push(row);
      continue;
    }
    const current = byCallId.get(row.call_id) || { call_id: row.call_id };
    current.api_name ||= row.api_name;
    current.selector ||= row.selector;
    current.title ||= row.title;
    current.error ||= row.error;
    current.duration_ms ||= row.duration_ms;
    current.start_time_ms =
      current.start_time_ms === undefined
        ? row.start_time_ms
        : row.start_time_ms === undefined
          ? current.start_time_ms
          : Math.min(current.start_time_ms, row.start_time_ms);
    current.end_time_ms =
      current.end_time_ms === undefined
        ? row.end_time_ms
        : row.end_time_ms === undefined
          ? current.end_time_ms
          : Math.max(current.end_time_ms, row.end_time_ms);
    if (!current.duration_ms && current.start_time_ms !== undefined && current.end_time_ms !== undefined) {
      current.duration_ms = Math.max(0, current.end_time_ms - current.start_time_ms);
    }
    byCallId.set(row.call_id, current);
  }

  return [...byCallId.values(), ...withoutCallId];
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

function emptyEvidence(): ParsedEvidence {
  return {
    actions: [],
    console: [],
    errors: [],
    network: [],
    raw_chars: 0,
    screenshot_entries: [],
    source_kind: "empty",
  };
}

async function parseEvidence(config: PlaywrightTraceConfig, input: TraceInput): Promise<ParsedEvidence> {
  const evidence = emptyEvidence();
  const chunks: string[] = [];

  if (input.trace_zip_path) {
    const entries = await listZipEntries(input.trace_zip_path);
    evidence.source_kind = "zip";
    evidence.zip_entries_count = entries.length;
    evidence.screenshot_entries = entries.filter(isScreenshotEntry).slice(0, input.max_screenshots || 20);
    const traceEntry = entries.find(isTraceEntry);
    const networkEntry = entries.find(isNetworkEntry);
    for (const entry of [traceEntry, networkEntry].filter(Boolean) as string[]) {
      const raw = await readZipEntry(input.trace_zip_path, entry, config.maxArtifactChars);
      chunks.push(raw.toString("utf8"));
    }
  }

  for (const chunk of [input.trace_json, input.trace_text, input.console_json, input.console_text, input.network_json, input.har_json]) {
    if (chunk) {
      evidence.source_kind = evidence.source_kind === "empty" ? "inline" : evidence.source_kind;
      chunks.push(chunk);
    }
  }

  evidence.raw_chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  for (const chunk of chunks) {
    for (const item of parseJsonLines(chunk)) {
      scanObject(item, evidence);
    }
  }
  if (input.console_text) {
    scanConsoleText(input.console_text, evidence);
  }
  if (input.network_json || input.trace_text) {
    scanNetworkText(`${input.network_json || ""}\n${input.trace_text || ""}`, evidence);
  }

  evidence.console = dedupeBy(evidence.console, (row) => `${row.type}:${row.text}:${row.location || ""}`).slice(0, input.max_events || 100);
  evidence.errors = Array.from(new Set(evidence.errors)).slice(0, input.max_events || 100);
  evidence.network = dedupeBy(evidence.network, (row) => `${row.status || ""}:${row.url_hash || ""}:${row.status_text || ""}`).slice(0, input.max_events || 200);
  evidence.actions = dedupeBy(mergeActions(evidence.actions), (row) => `${row.call_id || ""}:${row.api_name || ""}:${row.selector || ""}:${row.error || ""}`).slice(0, input.max_events || 100);
  return evidence;
}

function summarizeConsoleEvidence(evidence: ParsedEvidence) {
  const errors = evidence.console.filter((item) => item.type === "error");
  const warnings = evidence.console.filter((item) => item.type === "warning");
  return {
    total: evidence.console.length,
    errors: errors.length,
    warnings: warnings.length,
    top_errors: errors.slice(0, 10).map((item) => ({
      text: item.text,
      location: item.location,
    })),
    top_warnings: warnings.slice(0, 10).map((item) => ({
      text: item.text,
      location: item.location,
    })),
  };
}

function isNetworkFailure(item: NetworkFinding): boolean {
  const status = item.status || 0;
  if (status >= 400) {
    return true;
  }
  if (status > 0) {
    return false;
  }
  return /abort|blocked|error|failed|net::|timeout/i.test(item.status_text || "");
}

function summarizeNetworkEvidence(evidence: ParsedEvidence) {
  const bad = evidence.network.filter(isNetworkFailure);
  const status4xx = evidence.network.filter((item) => (item.status || 0) >= 400 && (item.status || 0) < 500);
  const status5xx = evidence.network.filter((item) => (item.status || 0) >= 500);
  const slow = evidence.network
    .filter((item) => (item.duration_ms || 0) >= 1000)
    .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0));
  return {
    total: evidence.network.length,
    failures: bad.length,
    slow_requests: slow.length,
    status_4xx: status4xx.length,
    status_5xx: status5xx.length,
    failed_requests: bad.slice(0, 20).map((item) => ({
      duration_ms: item.duration_ms,
      method: item.method,
      status: item.status,
      status_text: item.status_text,
      url_hash: item.url_hash,
      url_preview: safeUrlPreview(item.url, 120),
    })),
    slow_request_samples: slow.slice(0, 10).map((item) => ({
      duration_ms: item.duration_ms,
      method: item.method,
      status: item.status,
      url_hash: item.url_hash,
      url_preview: safeUrlPreview(item.url, 120),
    })),
  };
}

function extractFailure(evidence: ParsedEvidence) {
  const actionFailure = evidence.actions.find((item) => item.error);
  const consoleFailure = evidence.console.find((item) => item.type === "error");
  const networkFailure = evidence.network.find((item) => (item.status || 0) >= 500) || evidence.network.find((item) => (item.status || 0) >= 400);
  if (actionFailure) {
    return {
      kind: "action",
      api_name: actionFailure.api_name,
      call_id: actionFailure.call_id,
      duration_ms: actionFailure.duration_ms,
      end_time_ms: actionFailure.end_time_ms,
      selector: actionFailure.selector,
      start_time_ms: actionFailure.start_time_ms,
      message: actionFailure.error,
    };
  }
  if (consoleFailure) {
    return {
      kind: "console",
      message: consoleFailure.text,
      location: consoleFailure.location,
      time_ms: consoleFailure.time_ms,
    };
  }
  if (networkFailure) {
    return {
      kind: "network",
      duration_ms: networkFailure.duration_ms,
      end_time_ms: networkFailure.end_time_ms,
      status: networkFailure.status,
      status_text: networkFailure.status_text,
      time_ms: networkFailure.time_ms,
      url_hash: networkFailure.url_hash,
      url_preview: safeUrlPreview(networkFailure.url, 120),
    };
  }
  if (evidence.errors.length > 0) {
    return {
      kind: "error",
      message: evidence.errors[0],
    };
  }
  return null;
}

function actionOverlaps(action: ActionFinding, startMs: number, endMs: number): boolean {
  const actionStart = action.start_time_ms ?? action.end_time_ms;
  const actionEnd = action.end_time_ms ?? action.start_time_ms;
  if (actionStart === undefined && actionEnd === undefined) {
    return false;
  }
  return (actionEnd ?? actionStart ?? 0) >= startMs && (actionStart ?? actionEnd ?? 0) <= endMs;
}

function pointInRange(timeMs: number | undefined, startMs: number, endMs: number): boolean {
  return timeMs !== undefined && timeMs >= startMs && timeMs <= endMs;
}

function summarizeFailureWindow(
  evidence: ParsedEvidence,
  failure: ReturnType<typeof extractFailure>,
  windowMs = 1500,
): FailureWindow | null {
  if (!failure) {
    return null;
  }

  const failureRecord = failure as Record<string, unknown>;
  const startTime = timeOf(failureRecord.start_time_ms);
  const endTime = timeOf(failureRecord.end_time_ms);
  const pointTime = timeOf(failureRecord.time_ms);
  const anchorTime = startTime ?? pointTime ?? endTime;
  if (anchorTime === undefined) {
    return {
      anchor_kind: String(failureRecord.kind || "unknown"),
      nearby_actions: evidence.actions
        .filter((item) => item.error)
        .slice(0, 3)
        .map((item) => ({
          api_name: item.api_name,
          call_id: item.call_id,
          duration_ms: item.duration_ms,
          error: item.error,
          selector: item.selector,
          start_time_ms: item.start_time_ms,
        })),
      nearby_console_errors: evidence.console.filter((item) => item.type === "error").length,
      nearby_network_failures: evidence.network.filter(isNetworkFailure).length,
      nearby_slow_requests: evidence.network.filter((item) => (item.duration_ms || 0) >= 1000).length,
      summary: "Failure has no comparable trace timestamp; using global compact evidence.",
      warnings: ["timestamp_missing"],
    };
  }

  const rangeStart = Math.max(0, Math.min(startTime ?? anchorTime, pointTime ?? anchorTime) - windowMs);
  const rangeEnd = Math.max(endTime ?? anchorTime, pointTime ?? anchorTime) + windowMs;
  const nearbyActions = evidence.actions
    .filter((item) => actionOverlaps(item, rangeStart, rangeEnd))
    .sort((a, b) => (a.start_time_ms || a.end_time_ms || 0) - (b.start_time_ms || b.end_time_ms || 0));
  const nearbyConsole = evidence.console.filter((item) => pointInRange(item.time_ms, rangeStart, rangeEnd));
  const nearbyNetwork = evidence.network.filter((item) => {
    if (pointInRange(item.time_ms, rangeStart, rangeEnd) || pointInRange(item.end_time_ms, rangeStart, rangeEnd)) {
      return true;
    }
    return (
      item.time_ms !== undefined &&
      item.end_time_ms !== undefined &&
      item.time_ms <= rangeStart &&
      item.end_time_ms >= rangeEnd
    );
  });
  const nearbyNetworkFailures = nearbyNetwork.filter(isNetworkFailure).length;
  const nearbyConsoleErrors = nearbyConsole.filter((item) => item.type === "error").length;
  const nearbySlowRequests = nearbyNetwork.filter((item) => (item.duration_ms || 0) >= 1000).length;
  const warnings: string[] = [];
  if (nearbyNetworkFailures > 0) {
    warnings.push("network_failure_nearby");
  }
  if (nearbyConsoleErrors > 0) {
    warnings.push("console_error_nearby");
  }
  if (nearbySlowRequests > 0) {
    warnings.push("slow_request_nearby");
  }

  return {
    anchor_kind: String(failureRecord.kind || "unknown"),
    anchor_time_ms: anchorTime,
    nearby_actions: nearbyActions.slice(0, 6).map((item) => ({
      api_name: item.api_name,
      call_id: item.call_id,
      duration_ms: item.duration_ms,
      error: item.error,
      selector: item.selector,
      start_time_ms: item.start_time_ms,
    })),
    nearby_console_errors: nearbyConsoleErrors,
    nearby_network_failures: nearbyNetworkFailures,
    nearby_slow_requests: nearbySlowRequests,
    range_end_ms: rangeEnd,
    range_start_ms: rangeStart,
    summary: `Around failure: actions=${nearbyActions.length}, console_errors=${nearbyConsoleErrors}, network_failures=${nearbyNetworkFailures}, slow_requests=${nearbySlowRequests}.`,
    warnings,
  };
}

function compactMarkdown(payload: {
  console: ReturnType<typeof summarizeConsoleEvidence>;
  failure: ReturnType<typeof extractFailure>;
  failure_window: FailureWindow | null;
  network: ReturnType<typeof summarizeNetworkEvidence>;
  screenshots_count: number;
  source_kind: string;
}) {
  const lines = [
    "# Playwright trace summary",
    "",
    `Source: ${payload.source_kind}`,
    `Failure: ${payload.failure ? payload.failure.kind : "none"}`,
    `Console errors: ${payload.console.errors}`,
    `Console warnings: ${payload.console.warnings}`,
    `Network failures: ${payload.network.failures}`,
    `Screenshots: ${payload.screenshots_count}`,
  ];
  if (payload.failure) {
    lines.push("");
    lines.push(`Primary failure: ${JSON.stringify(payload.failure)}`);
  }
  if (payload.failure_window) {
    lines.push(`Failure window: ${payload.failure_window.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

function withStats(rawChars: number, compact: string) {
  const rawTokens = estimateTokens("x".repeat(rawChars));
  const compactTokens = estimateTokens(compact);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

export async function prepareTrace(config: PlaywrightTraceConfig, input: TraceInput) {
  const evidence = await parseEvidence(config, input);
  const consoleSummary = summarizeConsoleEvidence(evidence);
  const networkSummary = summarizeNetworkEvidence(evidence);
  const failure = extractFailure(evidence);
  const failureWindow = summarizeFailureWindow(evidence, failure);
  const compact = compactMarkdown({
    console: consoleSummary,
    failure,
    failure_window: failureWindow,
    network: networkSummary,
    screenshots_count: evidence.screenshot_entries.length + (input.screenshot_paths?.length || 0),
    source_kind: evidence.source_kind,
  });
  const hash = stableHash(`${evidence.raw_chars}:${compact}`);
  const summary = {
    schema_version: PLAYWRIGHT_TRACE_SCHEMA_VERSION,
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    tool_kind: "trace",
    status: failure ? "failed" : evidence.raw_chars > 0 ? "passed" : "empty",
    source_kind: evidence.source_kind,
    zip_entries_count: evidence.zip_entries_count,
    actions_count: evidence.actions.length,
    screenshots_count: evidence.screenshot_entries.length + (input.screenshot_paths?.length || 0),
    console: consoleSummary,
    network: networkSummary,
    failure,
    failure_window: failureWindow,
    handoff: {
      context_prep_recommended: evidence.raw_chars > 20_000 || consoleSummary.errors + networkSummary.failures > 5,
      vision_recommended: evidence.screenshot_entries.length + (input.screenshot_paths?.length || 0) > 0,
      scraper_followup_recommended: networkSummary.failures > 0,
      preferred_next_tools: [
        evidence.raw_chars > 20_000 ? "context-prep-mcp.prep_text" : "",
        evidence.screenshot_entries.length + (input.screenshot_paths?.length || 0) > 0 ? "vision-mcp.prepare_screenshot" : "",
        networkSummary.failures > 0 ? "scraper-mcp.fetch_or_interact" : "",
      ].filter(Boolean),
    },
    compact_markdown: compact,
    input_stats: withStats(evidence.raw_chars, compact),
  };
  const summaryArtifact = await writeArtifact(config, `trace-${hash}-summary.json`, JSON.stringify(summary, null, 2));
  const compactArtifact = await writeArtifact(config, `trace-${hash}-compact.md`, compact);
  return {
    ...summary,
    artifacts: {
      summary_file: summaryArtifact.file,
      summary_url: summaryArtifact.url,
      compact_file: compactArtifact.file,
      compact_url: compactArtifact.url,
    },
  };
}

export async function summarizeConsole(config: PlaywrightTraceConfig, input: TraceInput) {
  const evidence = await parseEvidence(config, input);
  const summary = summarizeConsoleEvidence(evidence);
  const compact = `# Playwright console summary\n\nErrors: ${summary.errors}\nWarnings: ${summary.warnings}\nTotal: ${summary.total}\n`;
  return {
    schema_version: PLAYWRIGHT_TRACE_SCHEMA_VERSION,
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    tool_kind: "console",
    status: summary.errors > 0 ? "failed" : "passed",
    console: summary,
    compact_markdown: compact,
    input_stats: withStats(evidence.raw_chars, compact),
  };
}

export async function summarizeNetwork(config: PlaywrightTraceConfig, input: TraceInput) {
  const evidence = await parseEvidence(config, input);
  const summary = summarizeNetworkEvidence(evidence);
  const compact = `# Playwright network summary\n\nFailures: ${summary.failures}\n4xx: ${summary.status_4xx}\n5xx: ${summary.status_5xx}\nTotal: ${summary.total}\n`;
  return {
    schema_version: PLAYWRIGHT_TRACE_SCHEMA_VERSION,
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    tool_kind: "network",
    status: summary.failures > 0 ? "failed" : "passed",
    network: summary,
    compact_markdown: compact,
    input_stats: withStats(evidence.raw_chars, compact),
  };
}

export async function extractFailureStep(config: PlaywrightTraceConfig, input: TraceInput) {
  const evidence = await parseEvidence(config, input);
  const failure = extractFailure(evidence);
  const failureWindow = summarizeFailureWindow(evidence, failure);
  const compact = `# Playwright failure step\n\nFailure: ${failure ? JSON.stringify(failure) : "none"}\nFailure window: ${failureWindow?.summary || "none"}\n`;
  return {
    schema_version: PLAYWRIGHT_TRACE_SCHEMA_VERSION,
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    tool_kind: "failure_step",
    status: failure ? "failed" : "passed",
    failure,
    failure_window: failureWindow,
    compact_markdown: compact,
    input_stats: withStats(evidence.raw_chars, compact),
  };
}

export async function prepareTraceScreenshots(config: PlaywrightTraceConfig, input: TraceInput) {
  const max = input.max_screenshots || 6;
  const artifacts: Array<{ file: string; url: string; source_name: string }> = [];
  if (input.trace_zip_path) {
    const entries = (await listZipEntries(input.trace_zip_path)).filter(isScreenshotEntry).slice(0, max);
    for (const entry of entries) {
      const buffer = await readZipEntry(input.trace_zip_path, entry, config.maxArtifactChars);
      const artifact = await writeArtifact(config, `screenshot-${stableHash(entry)}-${path.basename(entry)}`, buffer);
      artifacts.push({ ...artifact, source_name: path.basename(entry) });
    }
  }
  if (input.screenshot_paths) {
    for (const screenshotPath of input.screenshot_paths.slice(0, Math.max(0, max - artifacts.length))) {
      const buffer = await import("node:fs/promises").then((fs) => fs.readFile(screenshotPath));
      const artifact = await writeArtifact(config, `screenshot-${stableHash(screenshotPath)}-${path.basename(screenshotPath)}`, buffer);
      artifacts.push({ ...artifact, source_name: path.basename(screenshotPath) });
    }
  }
  const compact = `# Playwright trace screenshots\n\nImages prepared: ${artifacts.length}\n`;
  return {
    schema_version: PLAYWRIGHT_TRACE_SCHEMA_VERSION,
    pipeline_version: PLAYWRIGHT_TRACE_PIPELINE_VERSION,
    tool_kind: "screenshots",
    status: artifacts.length > 0 ? "prepared" : "empty",
    image_count: artifacts.length,
    image_urls_for_model: artifacts.map((item) => item.url),
    screenshot_artifacts: artifacts,
    handoff: {
      vision_recommended: artifacts.length > 0,
      preferred_next_tools: artifacts.length > 0 ? ["vision-mcp.prepare_screenshot"] : [],
    },
    compact_markdown: compact,
    input_stats: withStats((input.screenshot_paths?.length || 0) * 5_000, compact),
  };
}
