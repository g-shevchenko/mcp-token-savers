import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RETRIEVAL_PIPELINE_VERSION, RetrievalConfig } from "./config.js";

export type FeedbackOutcome =
  | "helpful"
  | "partial"
  | "miss"
  | "wrong_context"
  | "manual_search_needed";

export interface RetrievalFeedbackInput {
  call_id?: string;
  corrected_query?: string;
  expected_paths?: string[];
  frontier_had_to_search?: boolean;
  metadata?: Record<string, unknown>;
  missing_paths?: string[];
  notes?: string;
  opened_paths?: string[];
  outcome: FeedbackOutcome;
  query?: string;
  retrieved_paths?: string[];
  root_path?: string;
}

export interface MeasurementReportOptions {
  date?: string;
  include_samples?: boolean;
  since_iso?: string;
  until_iso?: string;
}

type TrafficClass = "production_like" | "proof" | "benchmark" | "unknown";

interface RequestLogLine {
  duration_ms?: number;
  input?: Record<string, unknown>;
  ok?: boolean;
  output?: Record<string, unknown>;
  tool?: string;
  transport?: string;
  ts?: string;
}

interface FeedbackLogLine extends RetrievalFeedbackInput {
  feedback_id?: string;
  service?: string;
  ts?: string;
}

function cleanString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanStringArray(value: unknown, maxItems = 30, maxChars = 260): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\\/g, "/").slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const allowed = ["owner", "project", "surface", "repo", "branch", "commit_sha", "session_id", "source"];
  const cleaned: Record<string, unknown> = {};
  for (const key of allowed) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string" && item.trim()) {
      cleaned[key] = item.trim().slice(0, 180);
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function isFeedbackOutcome(value: unknown): value is FeedbackOutcome {
  return (
    value === "helpful" ||
    value === "partial" ||
    value === "miss" ||
    value === "wrong_context" ||
    value === "manual_search_needed"
  );
}

function feedbackId(): string {
  return `feedback-${new Date().toISOString().replace(/[:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

async function appendJsonl(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
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
  } catch {
    return [];
  }
}

function suggestedUpgradePlan(input: RetrievalFeedbackInput): string[] {
  const plan: string[] = [];
  const expected = cleanStringArray(input.expected_paths);
  const missing = cleanStringArray(input.missing_paths);

  if (input.outcome !== "helpful") {
    plan.push("Promote this query to a golden benchmark candidate before changing ranking.");
  }
  if (expected.length > 0 || missing.length > 0) {
    plan.push("Add expected_paths/missing_paths to the benchmark so future ranking changes are measurable.");
  }
  if (input.corrected_query) {
    plan.push("Inspect corrected_query for synonym/query-expansion rules.");
  }
  if (input.frontier_had_to_search) {
    plan.push("Compare frontier-discovered files with ranked_files and adjust scoring only if the benchmark fails reproducibly.");
  }
  if (input.outcome === "wrong_context") {
    plan.push("Check path policy, generated-file filtering, and over-boosted context_hints for false positives.");
  }
  if (plan.length === 0) {
    plan.push("Keep as positive trace; no retrieval upgrade needed.");
  }
  return plan;
}

export async function recordRetrievalFeedback(
  config: RetrievalConfig,
  rawInput: Record<string, unknown>,
) {
  const outcome = rawInput.outcome;
  if (!isFeedbackOutcome(outcome)) {
    throw new Error("outcome must be one of helpful, partial, miss, wrong_context, manual_search_needed");
  }

  const input: RetrievalFeedbackInput = {
    call_id: cleanString(rawInput.call_id, 120),
    corrected_query: cleanString(rawInput.corrected_query, 1000),
    expected_paths: cleanStringArray(rawInput.expected_paths),
    frontier_had_to_search: rawInput.frontier_had_to_search === true,
    metadata: cleanMetadata(rawInput.metadata),
    missing_paths: cleanStringArray(rawInput.missing_paths),
    notes: cleanString(rawInput.notes, 1200),
    opened_paths: cleanStringArray(rawInput.opened_paths),
    outcome,
    query: cleanString(rawInput.query, 1200),
    retrieved_paths: cleanStringArray(rawInput.retrieved_paths),
    root_path: cleanString(rawInput.root_path, 500),
  };
  const plan = suggestedUpgradePlan(input);
  const benchmarkCandidate = outcome !== "helpful" || input.frontier_had_to_search === true;
  const event = {
    ts: new Date().toISOString(),
    service: "retrieval-mcp",
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    feedback_id: feedbackId(),
    benchmark_candidate: benchmarkCandidate,
    suggested_upgrade_plan: plan,
    ...input,
  };

  await appendJsonl(config.feedbackLogPath, event);

  return {
    schema_version: "retrieval-feedback.v1",
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    feedback_id: event.feedback_id,
    stored: true,
    benchmark_candidate: benchmarkCandidate,
    suggested_upgrade_plan: plan,
    feedback_log_path: config.feedbackLogPath,
    pantheon_safe: {
      call_id: input.call_id,
      outcome,
      frontier_had_to_search: input.frontier_had_to_search,
      expected_paths_count: input.expected_paths?.length || 0,
      missing_paths_count: input.missing_paths?.length || 0,
    },
  };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateRange(options: MeasurementReportOptions): { date: string; since: Date; until: Date } {
  const date = cleanString(options.date, 20) || new Date().toISOString().slice(0, 10);
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

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cleanLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function inferSurfaceFromSource(source: string | undefined): string | undefined {
  const normalized = (source || "").toLowerCase();
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("codex")) {
    return "codex";
  }
  if (normalized.includes("cursor")) {
    return "cursor";
  }
  if (normalized.includes("windsurf")) {
    return "windsurf";
  }
  return undefined;
}

function classifyTraffic(source: string | undefined, surface: string | undefined, tool?: string): TrafficClass {
  const haystack = `${source || ""} ${surface || ""} ${tool || ""}`.toLowerCase();
  if (
    haystack.includes("golden") ||
    haystack.includes("benchmark") ||
    haystack.includes("bench") ||
    haystack.includes("from-traces") ||
    haystack.includes("trace-candidates") ||
    haystack.includes("dataset-runner") ||
    haystack.includes("regression")
  ) {
    return "benchmark";
  }
  if (
    haystack.includes("smoke") ||
    haystack.includes("e2e") ||
    haystack.includes("proof") ||
    haystack.includes("test") ||
    haystack.includes("fixture")
  ) {
    return "proof";
  }
  if (/\b(claude|codex|cursor|windsurf|agent)\b/.test(haystack)) {
    return "production_like";
  }
  return "unknown";
}

function requestSource(line: RequestLogLine): string {
  return cleanLabel(line.input?.metadata_source) || "unknown";
}

function requestSurface(line: RequestLogLine): string {
  const source = requestSource(line);
  return cleanLabel(line.input?.metadata_surface) || inferSurfaceFromSource(source) || "unknown";
}

function requestTrafficClass(line: RequestLogLine): TrafficClass {
  const explicit = cleanLabel(line.input?.traffic_class);
  if (
    explicit === "production_like" ||
    explicit === "proof" ||
    explicit === "benchmark" ||
    explicit === "unknown"
  ) {
    return explicit;
  }
  return classifyTraffic(requestSource(line), requestSurface(line), line.tool);
}

function feedbackSource(line: FeedbackLogLine): string {
  return cleanLabel(line.metadata?.source) || "unknown";
}

function feedbackSurface(line: FeedbackLogLine): string {
  const source = feedbackSource(line);
  return cleanLabel(line.metadata?.surface) || inferSurfaceFromSource(source) || "unknown";
}

function feedbackTrafficClass(line: FeedbackLogLine): TrafficClass {
  return classifyTraffic(feedbackSource(line), feedbackSurface(line));
}

function classMetrics(requests: RequestLogLine[], feedback: FeedbackLogLine[]) {
  const okRequests = requests.filter((line) => line.ok !== false);
  const rawTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.raw_tokens_estimate), 0);
  const compactTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.compact_tokens_estimate), 0);
  const savedTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.saved_tokens_estimate), 0);
  const badFeedback = feedback.filter((line) => line.outcome && line.outcome !== "helpful");
  return {
    calls: requests.length,
    ok_calls: okRequests.length,
    failed_calls: requests.length - okRequests.length,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round(((rawTokens - compactTokens) / rawTokens) * 100, 1) : 0,
    feedback_count: feedback.length,
    feedback_coverage_pct: requests.length > 0 ? round((feedback.length / requests.length) * 100, 1) : 0,
    miss_or_partial_count: badFeedback.length,
    frontier_search_count: feedback.filter((line) => line.frontier_had_to_search).length,
  };
}

function recommendationSummary(args: {
  calls: number;
  feedback: FeedbackLogLine[];
  p95LatencyMs: number;
  productionLikeCalls: number;
  productionLikeFeedbackCount: number;
  savingsPct: number;
}): string[] {
  const recommendations: string[] = [];
  const badFeedback = args.feedback.filter((item) => item.outcome && item.outcome !== "helpful");
  if (badFeedback.length > 0) {
    recommendations.push("Convert bad feedback traces into golden benchmark cases before ranking changes.");
  }
  if (args.productionLikeCalls > 0 && args.productionLikeFeedbackCount / args.productionLikeCalls < 0.1) {
    recommendations.push("Production-like feedback coverage is low; record feedback after misses, partials, wrong-context, or manual-search fallbacks. Do not add filler helpful feedback.");
  }
  if (args.p95LatencyMs > 1000) {
    recommendations.push("Investigate p95 latency before adding heavier semantic retrieval.");
  }
  if (args.savingsPct < 20 && args.calls > 3) {
    recommendations.push("Review snippet budgets; savings are low for today's workload.");
  }
  if (recommendations.length === 0) {
    recommendations.push("No action needed; keep collecting traces.");
  }
  return recommendations;
}

export async function buildMeasurementReport(
  config: RetrievalConfig,
  options: MeasurementReportOptions = {},
) {
  const { date, since, until } = dateRange(options);
  const [requestLines, feedbackLines] = await Promise.all([
    readJsonl<RequestLogLine>(config.requestLogPath),
    readJsonl<FeedbackLogLine>(config.feedbackLogPath),
  ]);
  const requests = requestLines.filter((line) => inRange(line.ts, since, until));
  const feedback = feedbackLines.filter((line) => inRange(line.ts, since, until));
  const okRequests = requests.filter((line) => line.ok !== false);
  const latencies = requests.map((line) => toNumber(line.duration_ms)).filter((value) => value > 0);
  const tools = requests.map((line) => line.tool || "unknown");
  const transports = requests.map((line) => line.transport || "unknown");
  const sources = requests.map(requestSource);
  const surfaces = requests.map(requestSurface);
  const requestClasses = requests.map(requestTrafficClass);
  const requestTrafficByCallId = new Map<string, TrafficClass>();
  for (const request of requests) {
    const callId = cleanLabel(request.output?.call_id);
    if (callId) {
      requestTrafficByCallId.set(callId, requestTrafficClass(request));
    }
  }
  const classifyFeedback = (line: FeedbackLogLine): TrafficClass => {
    const direct = feedbackTrafficClass(line);
    if (direct !== "unknown") {
      return direct;
    }
    const callId = cleanLabel(line.call_id);
    return (callId && requestTrafficByCallId.get(callId)) || direct;
  };
  const feedbackClasses = feedback.map(classifyFeedback);
  const requestsByClass: Record<TrafficClass, RequestLogLine[]> = {
    production_like: [],
    proof: [],
    benchmark: [],
    unknown: [],
  };
  for (const request of requests) {
    requestsByClass[requestTrafficClass(request)].push(request);
  }
  const feedbackByClass: Record<TrafficClass, FeedbackLogLine[]> = {
    production_like: [],
    proof: [],
    benchmark: [],
    unknown: [],
  };
  for (const item of feedback) {
    feedbackByClass[classifyFeedback(item)].push(item);
  }
  const rawTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.raw_tokens_estimate), 0);
  const compactTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.compact_tokens_estimate), 0);
  const savedTokens = okRequests.reduce((sum, line) => sum + toNumber(line.output?.saved_tokens_estimate), 0);
  const savingsPct = rawTokens > 0 ? round(((rawTokens - compactTokens) / rawTokens) * 100, 1) : 0;
  const outcomeCounts = countBy(
    feedback
      .map((line) => line.outcome)
      .filter((outcome): outcome is FeedbackOutcome => isFeedbackOutcome(outcome)),
  );
  const badFeedback = feedback.filter((line) => line.outcome && line.outcome !== "helpful");
  const productionLikeFeedback = feedbackByClass.production_like;
  const frontierSearchCount = feedback.filter((line) => line.frontier_had_to_search).length;
  const estimatedUsdSaved = round((savedTokens / 1_000_000) * config.measurementUsdPer1MTokens, 4);
  const p95LatencyMs = percentile(latencies, 95);
  const traffic = {
    by_class: countBy(requestClasses),
    production_like: classMetrics(requestsByClass.production_like, feedbackByClass.production_like),
    proof: classMetrics(requestsByClass.proof, feedbackByClass.proof),
    benchmark: classMetrics(requestsByClass.benchmark, feedbackByClass.benchmark),
    unknown: classMetrics(requestsByClass.unknown, feedbackByClass.unknown),
  };
  const improvementCandidates = badFeedback.slice(0, 20).map((line) => ({
    feedback_id: line.feedback_id,
    call_id: line.call_id,
    outcome: line.outcome,
    frontier_had_to_search: line.frontier_had_to_search === true,
    expected_paths: cleanStringArray(line.expected_paths),
    missing_paths: cleanStringArray(line.missing_paths),
    corrected_query: options.include_samples ? line.corrected_query : undefined,
    notes: options.include_samples ? line.notes : undefined,
    suggested_action: "Add/refresh a benchmark case before changing retrieval ranking.",
  }));

  return {
    schema_version: "retrieval-measurement.v1",
    pipeline_version: RETRIEVAL_PIPELINE_VERSION,
    date,
    time_basis: "UTC",
    window: {
      since_iso: since.toISOString(),
      until_iso: until.toISOString(),
    },
    paths: {
      request_log_path: config.requestLogPath,
      feedback_log_path: config.feedbackLogPath,
    },
    usage: {
      calls: requests.length,
      ok_calls: okRequests.length,
      failed_calls: requests.length - okRequests.length,
      by_tool: countBy(tools),
      by_transport: countBy(transports),
      by_metadata_source: countBy(sources),
      by_surface: countBy(surfaces),
      by_traffic_class: traffic.by_class,
      production_like_calls: requestsByClass.production_like.length,
      proof_calls: requestsByClass.proof.length,
      benchmark_calls: requestsByClass.benchmark.length,
      unknown_calls: requestsByClass.unknown.length,
      latency_ms: {
        p50: percentile(latencies, 50),
        p95: p95LatencyMs,
        max: latencies.length ? Math.max(...latencies) : 0,
      },
    },
    traffic,
    token_savings: {
      raw_tokens_estimate: rawTokens,
      compact_tokens_estimate: compactTokens,
      saved_tokens_estimate: savedTokens,
      savings_pct: savingsPct,
      estimated_usd_saved: estimatedUsdSaved,
      usd_per_1m_tokens: config.measurementUsdPer1MTokens,
      usd_note:
        "Counterfactual input-token estimate for planning/Pantheon. Subscription limits are not direct invoices.",
    },
    quality: {
      feedback_count: feedback.length,
      outcome_counts: outcomeCounts,
      miss_or_partial_count: badFeedback.length,
      miss_or_partial_rate: feedback.length > 0 ? round((badFeedback.length / feedback.length) * 100, 1) : 0,
      frontier_search_count: frontierSearchCount,
      feedback_coverage_pct: requests.length > 0 ? round((feedback.length / requests.length) * 100, 1) : 0,
      feedback_by_traffic_class: countBy(feedbackClasses),
      production_like_feedback_count: productionLikeFeedback.length,
      production_like_feedback_coverage_pct:
        requestsByClass.production_like.length > 0
          ? round((productionLikeFeedback.length / requestsByClass.production_like.length) * 100, 1)
          : 0,
      feedback_discipline: {
        expected_after: ["partial", "miss", "wrong_context", "manual_search_needed"],
        production_like_calls: requestsByClass.production_like.length,
        production_like_feedback_count: productionLikeFeedback.length,
        low_coverage:
          requestsByClass.production_like.length > 0 &&
          productionLikeFeedback.length / requestsByClass.production_like.length < 0.1,
        note:
          "Record feedback only after real misses/partials/wrong-context/manual-search fallbacks; do not invent helpful filler feedback.",
      },
      improvement_candidates: improvementCandidates,
    },
    pantheon_export: {
      service: "retrieval-mcp",
      date,
      calls: requests.length,
      ok_calls: okRequests.length,
      by_traffic_class: traffic.by_class,
      production_like_calls: requestsByClass.production_like.length,
      proof_calls: requestsByClass.proof.length,
      benchmark_calls: requestsByClass.benchmark.length,
      unknown_calls: requestsByClass.unknown.length,
      saved_tokens_estimate: savedTokens,
      production_like_saved_tokens_estimate: traffic.production_like.saved_tokens_estimate,
      estimated_usd_saved: estimatedUsdSaved,
      feedback_count: feedback.length,
      production_like_feedback_count: productionLikeFeedback.length,
      production_like_feedback_coverage_pct:
        requestsByClass.production_like.length > 0
          ? round((productionLikeFeedback.length / requestsByClass.production_like.length) * 100, 1)
          : 0,
      miss_or_partial_count: badFeedback.length,
      frontier_search_count: frontierSearchCount,
      p95_latency_ms: p95LatencyMs,
    },
    recommendations: recommendationSummary({
      calls: requests.length,
      feedback,
      p95LatencyMs,
      productionLikeCalls: requestsByClass.production_like.length,
      productionLikeFeedbackCount: productionLikeFeedback.length,
      savingsPct,
    }),
  };
}
