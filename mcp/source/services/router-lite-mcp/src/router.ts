import { ROUTER_LITE_PIPELINE_VERSION, ROUTER_LITE_SCHEMA_VERSION } from "./config.js";
import { cleanLabel, estimateTokens, round, stableHash } from "./text-utils.js";

export interface RouterLiteArgs {
  artifact_kinds?: string[];
  changed_files?: string[];
  input_kind?: string;
  metadata?: unknown;
  selected_paths?: string[];
  text?: string;
  urls?: string[];
}

export interface RouteRecommendation {
  confidence: number;
  mcp: string;
  reason: string;
  tool: string;
}

export interface RouteResult {
  schema_version: string;
  pipeline_version: string;
  tool_kind: "router_lite";
  status: "ok";
  data_policy: string;
  decision: "call_mcp" | "skip_mcp" | "ask_clarification";
  recommended_mcps: string[];
  recommendations: RouteRecommendation[];
  skip_reason?: string;
  clarification_reason?: string;
  requires_frontier_reasoning: boolean;
  cheap_only_allowed: boolean;
  risk_flags: string[];
  confidence: {
    score: number;
    uncertainty: number;
  };
  features: Record<string, number | boolean | string>;
  raw_tokens_estimate: number;
  compact_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
}

const URL_RE = /\bhttps?:\/\/[^\s<>)"']+/gi;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const FILE_PATH_RE = /(^|\s)([\w.-]+\/)+[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|md|mdx|json|yaml|yml|php|sh)(:\d+)?(\s|$)/i;

function textOf(args: RouterLiteArgs): string {
  return typeof args.text === "string" ? args.text : "";
}

function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractUrls(args: RouterLiteArgs): string[] {
  const explicit = arrayOf(args.urls);
  const fromText = textOf(args).match(URL_RE) || [];
  return Array.from(new Set([...explicit, ...fromText].map((item) => item.replace(/[),.;]+$/, ""))));
}

function includesAny(haystack: string, needles: RegExp[]): boolean {
  return needles.some((needle) => needle.test(haystack));
}

function addRecommendation(
  rows: RouteRecommendation[],
  mcp: string,
  tool: string,
  reason: string,
  confidence: number,
): void {
  if (rows.some((row) => row.mcp === mcp && row.tool === tool)) {
    return;
  }
  rows.push({ mcp, tool, reason, confidence: round(confidence, 2) });
}

function highRiskFlags(text: string): string[] {
  const flags: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["architecture_heavy", /\b(architecture|архитектур|design doc|system design|schema migration)\b/i],
    ["security_sensitive", /\b(security|secret|credential|token|auth|permission|ssh|prod|production|deploy|infra)\b/i],
    ["destructive_or_data_risk", /\b(delete|remove all|reset|rollback|migration|truncate|drop|force-push|force push)\b/i],
    ["final_output_sensitive", /\b(final answer|final copy|publish|send to client|legal|medical|financial|contract)\b/i],
    ["ambiguous_task", /^(fix it|do it|сделай|исправь|почини)\s*$/i],
  ];
  for (const [flag, pattern] of checks) {
    if (pattern.test(text)) {
      flags.push(flag);
    }
  }
  return flags;
}

export function classifyInput(args: RouterLiteArgs = {}): RouteResult {
  const text = textOf(args);
  const normalized = text.toLowerCase();
  const urls = extractUrls(args);
  const artifactKinds = arrayOf(args.artifact_kinds).map((item) => item.toLowerCase());
  const changedFiles = arrayOf(args.changed_files);
  const selectedPaths = arrayOf(args.selected_paths);
  const inputKind = cleanLabel(args.input_kind, "unknown");
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  const screenshotUrls = urls.filter((url) => IMAGE_RE.test(url));
  const nonScreenshotUrls = urls.filter((url) => !screenshotUrls.includes(url));
  const hasTrace = artifactKinds.some((item) => ["trace", "trace.zip", "har", "playwright"].includes(item)) ||
    includesAny(normalized, [/\btrace\.zip\b/, /\bhar\b/, /\bplaywright trace\b/, /\bconsole errors?\b/, /\bnetwork failures?\b/]);
  const looksLikeStackTrace = includesAny(text, [/^\s*at\s+.+\(.+:\d+:\d+\)/m, /traceback \(most recent call last\)/i, /\berror:\s.+/i]);
  const looksLikeLongLog = inputKind === "logs" || lineCount >= 150 || text.length >= 8000 || looksLikeStackTrace;
  const looksLikeLongText = !looksLikeLongLog && text.length >= 5000;
  const hasConcreteUrl = urls.length > 0;
  const asksToReadUrl = nonScreenshotUrls.length > 0 && includesAny(normalized, [
    /\b(read|summari[sz]e|compare|extract|parse|review|analy[sz]e)\b/,
    /\b(прочитай|суммируй|разбери|сравни|извлеки|проанализируй)\b/,
  ]);
  const asksDeepWeb = includesAny(normalized, [/\bserp\b/, /\bcrawl\b/, /\bdeep research\b/, /\bextract structured\b/, /\binteract\b/]);
  const exactFilesVisible = FILE_PATH_RE.test(text) || selectedPaths.length > 0;
  const broadRepoTask = includesAny(normalized, [
    /\b(where|which files|implemented|spans|codebase|repo|bug fix|refactor|review this branch)\b/,
    /\b(где|какие файлы|кодовой базе|репо|баг|рефактор|ветк)\b/,
  ]);
  const staticAnalysisTask = includesAny(normalized, [/\b(run|check)\s+(tests?|build|tsc|eslint|lint|typecheck)\b/, /\bproof loop\b/]);
  const dependencyTask = includesAny(normalized, [/\b(npm audit|osv|license|dependency|lockfile|supply chain|vulnerabilit)\b/]);
  const docsTask = includesAny(normalized, [/\b(broken links?|stale refs?|frontmatter|docs hygiene|orphan docs?|notion mirror|docs sync)\b/]);
  const cleanupTask = includesAny(normalized, [/\b(unused exports?|unused dependencies?|duplicate code|repo hygiene|cleanup plan)\b/]);
  const qualityGateTask = includesAny(normalized, [/\b(context pressure|quality gate|new code budget|new docs budget|large docs?)\b/]);
  const recommendations: RouteRecommendation[] = [];

  if (screenshotUrls.length > 0 || inputKind === "screenshot") {
    addRecommendation(
      recommendations,
      "vision-mcp",
      screenshotUrls.length > 1 ? "batch_prepare_screenshots" : "prepare_screenshot",
      "Screenshot or image URL present; prepare bounded visual artifacts before frontier vision/review.",
      0.96,
    );
  }
  if (hasTrace) {
    addRecommendation(recommendations, "playwright-trace-mcp", "prepare_trace", "Browser trace/HAR/debug artifacts present.", 0.94);
  }
  if (looksLikeLongLog) {
    addRecommendation(recommendations, "context-prep-mcp", "prep_logs", "Long log or stack trace should be compacted before frontier reasoning.", 0.93);
  } else if (looksLikeLongText) {
    addRecommendation(recommendations, "context-prep-mcp", "prep_text", "Long pasted text/spec should be compacted before frontier reasoning.", 0.9);
  }
  if (asksDeepWeb) {
    addRecommendation(recommendations, "scraper-stack", "direct_scraper_tool", "SERP/crawl/structured/browser task should use scraper-stack directly.", 0.9);
  } else if (asksToReadUrl) {
    addRecommendation(recommendations, "context-prep-mcp", "prep_url", "Concrete URL read/summary/extraction should use parser-first URL prep.", 0.88);
  }
  if (broadRepoTask && !exactFilesVisible && !looksLikeLongLog) {
    addRecommendation(recommendations, "retrieval-mcp", "retrieve_context", "Broad repo task with unclear files should retrieve ranked local context first.", 0.88);
  }
  if (staticAnalysisTask) {
    addRecommendation(recommendations, "static-analysis-mcp", "get_command_policy", "Verification command is requested; resolve/run local proof tools.", 0.86);
  }
  if (dependencyTask) {
    addRecommendation(recommendations, "dependency-risk-mcp", "summarize_supply_chain_risk", "Dependency/license/audit work should use local compact dependency evidence.", 0.88);
  }
  if (docsTask) {
    addRecommendation(recommendations, "docs-hygiene-mcp", "scan_doc_inventory", "Documentation hygiene/sync work should use local doc evidence first.", 0.84);
  }
  if (cleanupTask) {
    addRecommendation(recommendations, "repo-hygiene-mcp", "propose_cleanup_plan", "Repo cleanup work should use advisory hygiene evidence before edits.", 0.84);
  }
  if (qualityGateTask) {
    addRecommendation(recommendations, "repo-quality-gate-mcp", "check_context_budget", "Quality/budget work should use local advisory quality gates.", 0.84);
  }

  const riskFlags = highRiskFlags(text);
  const requiresFrontier = riskFlags.length > 0 || recommendations.length > 0;
  const ambiguousButNoPrep = riskFlags.includes("ambiguous_task") && recommendations.length === 0;
  const decision = ambiguousButNoPrep ? "ask_clarification" : recommendations.length > 0 ? "call_mcp" : "skip_mcp";
  const recommendedMcps = Array.from(new Set(recommendations.map((row) => row.mcp)));
  const bestConfidence = recommendations.reduce((max, row) => Math.max(max, row.confidence), 0.72);
  const score = decision === "skip_mcp" ? (text.length < 1200 && !hasConcreteUrl ? 0.82 : 0.68) : bestConfidence;
  const compactBase = {
    decision,
    recommended_mcps: recommendedMcps,
    recommendations,
    risk_flags: riskFlags,
  };
  const compactTokens = estimateTokens(JSON.stringify(compactBase));
  const rawTokens = estimateTokens(text.length);

  return {
    schema_version: ROUTER_LITE_SCHEMA_VERSION,
    pipeline_version: ROUTER_LITE_PIPELINE_VERSION,
    tool_kind: "router_lite",
    status: "ok",
    data_policy:
      "Deterministic prep trigger policy only. Does not answer user tasks, choose final models, write files, or replace frontier reasoning.",
    decision,
    recommended_mcps: recommendedMcps,
    recommendations,
    skip_reason: decision === "skip_mcp" ? "No utility MCP trigger crossed the deterministic threshold; proceed with normal reasoning/context." : undefined,
    clarification_reason: decision === "ask_clarification" ? "Task is ambiguous and no safe prep tool trigger is available." : undefined,
    requires_frontier_reasoning: requiresFrontier,
    cheap_only_allowed: false,
    risk_flags: riskFlags,
    confidence: {
      score: round(score, 2),
      uncertainty: round(Math.max(0, 1 - score), 2),
    },
    features: {
      input_kind: inputKind,
      text_chars: text.length,
      text_hash: text ? stableHash(text) : "",
      line_count: lineCount,
      url_count: urls.length,
      screenshot_url_count: screenshotUrls.length,
      changed_files_count: changedFiles.length,
      selected_paths_count: selectedPaths.length,
      exact_files_visible: exactFilesVisible,
      long_log: looksLikeLongLog,
      long_text: looksLikeLongText,
      high_risk: riskFlags.length > 0,
    },
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: 0,
    savings_pct: 0,
  };
}
