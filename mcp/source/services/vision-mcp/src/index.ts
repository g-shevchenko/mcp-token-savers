#!/usr/bin/env node

import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import {
  analyzeScreenshotDiff,
  analyzeScreenshotUrl,
  AnalyzeDiffResult,
  AnalyzeUrlResult,
} from "./analysis-pipeline.js";
import {
  CROP_PIPELINE_VERSION,
  getVisionConfig,
  SCREENSHOT_ANALYSIS_PROMPT_VERSION,
} from "./config.js";
import { listIgnorePresetNames } from "./ignore-presets.js";
import { listDiffReviewProfileNames } from "./diff-review-profiles.js";
import { listScreenshotTaskIntentNames } from "./screenshot-task-intents.js";
import { assertAllowedImageUrl } from "./url-policy.js";
import { readArtifact } from "./artifact-store.js";
import { appendRequestLog } from "./request-log.js";

const config = getVisionConfig();
const USER_AGENT = "HWAI-Vision-MCP/3.0";
const IGNORE_PRESET_NAMES = listIgnorePresetNames();
const REVIEW_PROFILE_NAMES = listDiffReviewProfileNames();
const TASK_INTENT_NAMES = listScreenshotTaskIntentNames();

const SCREENSHOT_METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata captured at report time. Use this to preserve page/browser context without sending extra free-form prompt text.",
  properties: {
    source: { type: "string" },
    surface: {
      type: "string",
      description: "Agent/client surface label for measurement only, for example claude, codex, cursor, or windsurf.",
    },
    client_surface: {
      type: "string",
      description: "Backward-compatible alias for surface.",
    },
    traffic_class: {
      type: "string",
      description: "Optional traffic attribution for measurement. Use production_like for real workflows and proof/benchmark/smoke for eval traffic.",
    },
    page_url: { type: "string" },
    page_route: { type: "string" },
    page_title: { type: "string" },
    browser: { type: "string" },
    os: { type: "string" },
    environment: { type: "string" },
    timestamp: { type: "string" },
    session_id: { type: "string" },
    report_id: { type: "string" },
    build_id: { type: "string" },
    branch: { type: "string" },
    commit_sha: { type: "string" },
    captured_by: { type: "string" },
    device_pixel_ratio: { type: "number" },
    reporter_comment: { type: "string" },
    user_role: { type: "string" },
    tenant: { type: "string" },
    locale: { type: "string" },
    feature_flags: {
      type: "array",
      items: { type: "string" },
    },
    active_experiments: {
      type: "array",
      items: { type: "string" },
    },
    labels: {
      type: "array",
      items: { type: "string" },
    },
    console_errors: {
      type: "array",
      items: { type: "string" },
    },
    network_errors: {
      type: "array",
      items: { type: "string" },
    },
    network_notes: {
      type: "array",
      items: { type: "string" },
    },
    viewport: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  },
};

const IGNORE_REGIONS_SCHEMA = {
  type: "array",
  description:
    "Optional rectangles to ignore during screenshot diff detection. Use this to suppress known noisy zones like browser chrome, sticky banners, or dynamic widgets.",
  items: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      coordinate_space: {
        type: "string",
        enum: ["pixels", "normalized"],
        description: "pixels = aligned image pixels; normalized = 0..1 fractions of aligned width/height",
      },
      applies_to: {
        type: "string",
        enum: ["before", "after", "both"],
      },
      reason: { type: "string" },
    },
    required: ["x", "y", "width", "height"],
  },
};

const REGION_POLICIES_SCHEMA = {
  type: "array",
  description:
    "Optional Applitools-style region policy rectangles. `ignore` regions are suppressed before diff detection; `strict`, `layout`, and `content` regions are carried into artifacts/prompt scaffolds for downstream review policy.",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      policy: {
        type: "string",
        enum: ["ignore", "strict", "layout", "content"],
      },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      coordinate_space: {
        type: "string",
        enum: ["pixels", "normalized"],
      },
      applies_to: {
        type: "string",
        enum: ["before", "after", "both"],
      },
      reason: { type: "string" },
    },
    required: ["policy", "x", "y", "width", "height"],
  },
};

const IGNORE_PRESETS_SCHEMA = {
  type: "array",
  description:
    "Optional reusable ignore-mask presets for common noisy zones. These expand into ignore_regions before diff detection.",
  items: {
    type: "string",
    enum: IGNORE_PRESET_NAMES,
  },
};

const DIFF_REVIEW_PROFILE_SCHEMA = {
  type: "string",
  description:
    "Optional reusable review profile that bundles ignore presets and packaging guidance for common before/after workflows.",
  enum: REVIEW_PROFILE_NAMES,
};

const TASK_INTENT_SCHEMA = {
  type: "string",
  description:
    "Optional reusable task-intent profile for common single-screenshot workflows. This sets packaging guidance and the recommended artifact profile.",
  enum: TASK_INTENT_NAMES,
};

const RUNTIME_DIAGNOSTICS_TOOL: Tool = {
  name: "get_runtime_diagnostics",
  description:
    "Return metadata-only runtime diagnostics for vision-mcp configuration. " +
    "Use when screenshot/image URL prep fails because of URL allowlist, size, timeout, or env drift.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Tool definitions
const FETCH_IMAGE_TOOL: Tool = {
  name: "fetch_image",
  description:
    "Fetches an image from a URL and returns it as base64-encoded data. " +
    "Supports PNG, JPEG, GIF, WebP. " +
    "Debug/fallback tool only: prefer analyze_screenshot for annotated screenshot workflows.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of the image to fetch (e.g., https://your-screenshot-cdn.example/screenshots/...)",
      },
      maxSize: {
        type: "number",
        description: "Maximum image size in bytes (default: 5MB)",
        default: 5 * 1024 * 1024,
      },
    },
    required: ["url"],
  },
};

const ANALYZE_SCREENSHOT_TOOL: Tool = {
  name: "analyze_screenshot",
  description:
    "Prepares a UI screenshot for native frontier vision instead of running a local VLM by default. " +
    "Fetches the screenshot, creates a token-aware full-frame image, detects red annotation regions, generates annotation and context crops, " +
    "adds region typing plus crop-only OCR when available, supports task-intent profiles for common review goals, and returns compact JSON with artifact URLs plus a prompt scaffold for Claude Code, Codex, Cursor, or Windsurf. " +
    "Best for: design review screenshots, UI feedback with red markers, annotated mockups, fast screenshot-prep workflows.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Screenshot URL (e.g., https://your-screenshot-cdn.example/screenshots/...)",
      },
      context: {
        type: "string",
        description: "Optional context about what to look for",
        default: "UI annotations and design issues",
      },
      metadata: SCREENSHOT_METADATA_SCHEMA,
      task_intent: TASK_INTENT_SCHEMA,
      verbose: {
        type: "boolean",
        description: "Include raw response and cache/debug metadata",
        default: false,
      },
    },
    required: ["url"],
  },
};

const PREPARE_SCREENSHOT_TOOL: Tool = {
  name: "prepare_screenshot",
  description:
    "Alias of analyze_screenshot for prep-first workflows. " +
    "Use when you explicitly want prepared screenshot artifacts for native frontier vision.",
  inputSchema: ANALYZE_SCREENSHOT_TOOL.inputSchema,
};

const BATCH_ANALYZE_TOOL: Tool = {
  name: "batch_analyze_screenshots",
  description:
    "Prepares multiple UI screenshots in sequence for native frontier vision. " +
    "Each result includes a prepared full-frame image, annotation/context crops, optional crop-only OCR, prompt scaffold, and artifact URLs. " +
    "Best for: multiple design review screenshots, batch prep before frontier reasoning. " +
    "Accepts the same optional task-intent profile for all screenshots in the batch.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Array of screenshot URLs to analyze",
      },
      context: {
        type: "string",
        description: "Optional context for all screenshots",
        default: "UI annotations batch analysis",
      },
      metadata: SCREENSHOT_METADATA_SCHEMA,
      task_intent: TASK_INTENT_SCHEMA,
      verbose: {
        type: "boolean",
        description: "Include per-screenshot debug metadata and raw VLM responses",
        default: false,
      },
    },
    required: ["urls"],
  },
};

const BATCH_PREPARE_TOOL: Tool = {
  name: "batch_prepare_screenshots",
  description:
    "Alias of batch_analyze_screenshots for prep-first workflows.",
  inputSchema: BATCH_ANALYZE_TOOL.inputSchema,
};

const ANALYZE_SCREENSHOT_DIFF_TOOL: Tool = {
  name: "analyze_screenshot_diff",
  description:
    "Prepares a before/after screenshot comparison for native frontier vision. " +
    "Fetches both screenshots, aligns full frames, detects meaningful changed regions with lightweight CV, " +
    "generates paired before/after crops plus wider context crops, accepts optional ignore regions for noisy UI bands, and returns compact JSON with artifact URLs and a diff-focused prompt scaffold. " +
    "Best for: visual regressions, design before/after review, UI implementation checks without local VLM inference.",
  inputSchema: {
    type: "object",
    properties: {
      before_url: {
        type: "string",
        description: "The before screenshot URL",
      },
      after_url: {
        type: "string",
        description: "The after screenshot URL",
      },
      context: {
        type: "string",
        description: "Optional context about what changed or what to compare",
        default: "UI before/after diff",
      },
      metadata: SCREENSHOT_METADATA_SCHEMA,
      ignore_regions: IGNORE_REGIONS_SCHEMA,
      ignore_presets: IGNORE_PRESETS_SCHEMA,
      region_policies: REGION_POLICIES_SCHEMA,
      review_profile: DIFF_REVIEW_PROFILE_SCHEMA,
      verbose: {
        type: "boolean",
        description: "Include cache/debug metadata",
        default: false,
      },
    },
    required: ["before_url", "after_url"],
  },
};

const PREPARE_SCREENSHOT_DIFF_TOOL: Tool = {
  name: "prepare_screenshot_diff",
  description:
    "Alias of analyze_screenshot_diff for prep-first before/after workflows.",
  inputSchema: ANALYZE_SCREENSHOT_DIFF_TOOL.inputSchema,
};

const IMAGE_TO_TEXT_TOOL: Tool = {
  name: "image_url_to_text",
  description:
    "Fetches an image from URL and provides a structured text representation. " +
    "Useful for screenshots with annotations, task lists, or UI mockups. " +
    "Returns description of visual elements, text content, and annotated tasks. " +
    "NOTE: For screenshot prep and artifact generation, prefer 'analyze_screenshot' tool.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of the image to analyze",
      },
      context: {
        type: "string",
        description: "Optional context about what to look for (e.g., 'task annotations', 'UI elements')",
        default: "general analysis",
      },
    },
    required: ["url"],
  },
};

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function stringifyResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function safeUrlSummary(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = new URL(raw);
    return {
      url_host: parsed.host,
      url_ext: path.extname(parsed.pathname).toLowerCase() || undefined,
    };
  } catch {
    return {};
  }
}

function cleanMetadataLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 80);
}

function metadataRecord(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return metadata as Record<string, unknown>;
}

function metadataSource(args: Record<string, unknown>): string | undefined {
  const metadata = metadataRecord(args);
  if (!metadata) {
    return undefined;
  }

  return cleanMetadataLabel(metadata.source);
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

function metadataSurface(args: Record<string, unknown>): string | undefined {
  const metadata = metadataRecord(args);
  const source = metadataSource(args);
  return (
    cleanMetadataLabel(metadata?.surface) ||
    cleanMetadataLabel(metadata?.client_surface) ||
    cleanMetadataLabel(args.metadata_surface) ||
    cleanMetadataLabel(args.surface) ||
    inferSurfaceFromSource(source)
  );
}

function metadataTrafficClass(args: Record<string, unknown>): string | undefined {
  const metadata = metadataRecord(args);
  return cleanMetadataLabel(metadata?.traffic_class) || cleanMetadataLabel(args.traffic_class);
}

function trafficClass(args: Record<string, unknown>, source: string | undefined, surface: string | undefined, tool: string): string {
  const explicit = metadataTrafficClass(args);
  if (explicit && ["production_like", "proof", "benchmark", "smoke", "e2e", "unknown"].includes(explicit)) {
    return explicit === "smoke" || explicit === "e2e" ? "proof" : explicit;
  }
  const haystack = `${source || ""} ${surface || ""} ${tool || ""}`.toLowerCase();
  if (
    haystack.includes("golden") ||
    haystack.includes("benchmark") ||
    haystack.includes("bench") ||
    haystack.includes("dataset") ||
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

function summarizeInput(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }

  if (tool === "analyze_screenshot" || tool === "prepare_screenshot") {
    const source = metadataSource(args);
    const surface = metadataSurface(args);
    return {
      ...safeUrlSummary(args.url),
      context_chars: typeof args.context === "string" ? args.context.length : 0,
      task_intent: args.task_intent,
      verbose: Boolean(args.verbose),
      metadata_source: source,
      metadata_surface: surface,
      traffic_class: trafficClass(args, source, surface, tool),
      metadata_keys: args.metadata && typeof args.metadata === "object" ? Object.keys(args.metadata).slice(0, 20) : [],
    };
  }

  if (tool === "batch_analyze_screenshots" || tool === "batch_prepare_screenshots") {
    const source = metadataSource(args);
    const surface = metadataSurface(args);
    return {
      urls_count: Array.isArray(args.urls) ? args.urls.length : 0,
      context_chars: typeof args.context === "string" ? args.context.length : 0,
      task_intent: args.task_intent,
      verbose: Boolean(args.verbose),
      metadata_source: source,
      metadata_surface: surface,
      traffic_class: trafficClass(args, source, surface, tool),
      metadata_keys: args.metadata && typeof args.metadata === "object" ? Object.keys(args.metadata).slice(0, 20) : [],
    };
  }

  if (tool === "analyze_screenshot_diff" || tool === "prepare_screenshot_diff") {
    const source = metadataSource(args);
    const surface = metadataSurface(args);
    return {
      before: safeUrlSummary(args.before_url),
      after: safeUrlSummary(args.after_url),
      context_chars: typeof args.context === "string" ? args.context.length : 0,
      ignore_regions_count: Array.isArray(args.ignore_regions) ? args.ignore_regions.length : 0,
      ignore_presets: Array.isArray(args.ignore_presets) ? args.ignore_presets.slice(0, 12) : [],
      region_policies_count: Array.isArray(args.region_policies) ? args.region_policies.length : 0,
      review_profile: args.review_profile,
      verbose: Boolean(args.verbose),
      metadata_source: source,
      metadata_surface: surface,
      traffic_class: trafficClass(args, source, surface, tool),
      metadata_keys: args.metadata && typeof args.metadata === "object" ? Object.keys(args.metadata).slice(0, 20) : [],
    };
  }

  if (tool === "fetch_image" || tool === "image_url_to_text") {
    return {
      ...safeUrlSummary(args.url),
      context_chars: typeof args.context === "string" ? args.context.length : 0,
      max_size: args.maxSize,
    };
  }

  return {};
}

function tokenBudgetForCompact(record: any): {
  compact_tokens_estimate?: number;
  full_tokens_estimate?: number;
  saved_tokens_estimate?: number;
  savings_pct?: number;
} {
  const profiles = Array.isArray(record?.artifact_profiles) ? record.artifact_profiles : [];
  const recommended = profiles.find((profile: any) => profile.profile === record?.recommended_profile);
  const full = profiles.find((profile: any) => profile.profile === "anthropic_full");
  const compactTokens = Number(recommended?.estimated_tokens?.anthropic_approx || 0);
  const fullTokens = Number(full?.estimated_tokens?.anthropic_approx || 0);
  const savedTokens = Math.max(0, fullTokens - compactTokens);

  if (!compactTokens && !fullTokens) {
    return {};
  }

  return {
    compact_tokens_estimate: compactTokens,
    full_tokens_estimate: fullTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: fullTokens > 0 ? Number(((savedTokens / fullTokens) * 100).toFixed(1)) : 0,
  };
}

function summarizeCompactOutput(record: any): Record<string, unknown> {
  const tokenBudget = tokenBudgetForCompact(record);
  return {
    analysis_id: record?.analysis_id,
    status: record?.status,
    prep_mode: record?.prep_mode,
    recommended_profile: record?.recommended_profile,
    image_urls_for_model_count: Array.isArray(record?.image_urls_for_model) ? record.image_urls_for_model.length : 0,
    annotation_regions_count: Array.isArray(record?.annotation_regions) ? record.annotation_regions.length : undefined,
    changed_regions_count: Array.isArray(record?.changed_regions) ? record.changed_regions.length : undefined,
    annotation_nav_count: Array.isArray(record?.annotation_nav) ? record.annotation_nav.length : undefined,
    review_nav_count: Array.isArray(record?.review_nav) ? record.review_nav.length : undefined,
    region_policies_count: Array.isArray(record?.region_policies) ? record.region_policies.length : undefined,
    context_quality_rating: record?.context_quality?.rating,
    context_quality_score: record?.context_quality?.score,
    error_code: record?.error_code,
    uncertainty: record?.confidence?.uncertainty,
    requires_clarification: record?.autopilot?.requires_clarification,
    ...tokenBudget,
  };
}

function summarizeOutput(result: unknown): Record<string, unknown> {
  const record = result as any;
  if (!record || typeof record !== "object") {
    return {};
  }

  if (record.compact && record.verbose) {
    return summarizeCompactOutput(record.compact);
  }

  if (record.compact && Array.isArray(record.compact.results)) {
    const summaries = record.compact.results.map((item: unknown) => summarizeCompactOutput(item));
    return {
      schema_version: record.compact.schema_version,
      batch_id: record.compact.batch_id,
      status: record.compact.status,
      total_images: record.compact.total_images,
      ok_images: record.compact.ok_images,
      failed_images: record.compact.failed_images,
      total_annotation_regions: record.compact.total_annotation_regions,
      total_time_ms: record.compact.total_time_ms,
      compact_tokens_estimate: summaries.reduce((sum: number, item: any) => sum + Number(item.compact_tokens_estimate || 0), 0),
      full_tokens_estimate: summaries.reduce((sum: number, item: any) => sum + Number(item.full_tokens_estimate || 0), 0),
      saved_tokens_estimate: summaries.reduce((sum: number, item: any) => sum + Number(item.saved_tokens_estimate || 0), 0),
      max_uncertainty: summaries.reduce((max: number, item: any) => Math.max(max, Number(item.uncertainty || 0)), 0),
    };
  }

  if (record.image) {
    return {
      image_size_bytes: record.image.size,
      content_type: record.image.contentType,
    };
  }

  return summarizeCompactOutput(record);
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
    return "fetch_timeout";
  }
  if (lower.includes("not allowed") || lower.includes("allowed hosts")) {
    return "url_not_allowed";
  }
  if (lower.includes("econnrefused") || lower.includes("connect refused")) {
    return "connection_refused";
  }
  if (lower.includes("exceeds maximum") || lower.includes("image size")) {
    return "image_too_large";
  }
  if (lower.includes("http error") || /status:\s*[45]\d\d/.test(lower)) {
    return "remote_http_error";
  }
  if (lower.includes("unsupported") || lower.includes("invalid")) {
    return "invalid_input";
  }
  return "unknown_error";
}

function runtimeDiagnostics(): Record<string, unknown> {
  const normalizedHosts = config.allowedHosts.map((host) => host.toLowerCase());
  const onlyPlaceholderHostAllowed =
    normalizedHosts.length > 0 && normalizedHosts.every((host) => host === "example.com");
  const warnings: string[] = [];
  const recommendedActions: string[] = [];

  if (!config.allowAnyImageUrl && onlyPlaceholderHostAllowed) {
    warnings.push("no_real_image_host_allowlisted");
    recommendedActions.push(
      "Set VISION_ALLOWED_HOSTS to your screenshot host(s), or set ALLOW_ANY_IMAGE_URL=1, so the server can fetch real screenshot URLs.",
    );
  }

  if (config.allowAnyImageUrl) {
    warnings.push("allow_any_image_url_enabled");
    recommendedActions.push("Prefer a narrow VISION_ALLOWED_HOSTS allowlist for routine agent workflows.");
  }

  return {
    schema_version: "vision-runtime-diagnostics.v1",
    service: "vision-mcp",
    ok: warnings.length === 0,
    url_policy: {
      allow_any_image_url: config.allowAnyImageUrl,
      allowed_hosts: config.allowedHosts,
      only_placeholder_host_allowed: onlyPlaceholderHostAllowed,
    },
    limits: {
      max_image_size_bytes: config.maxImageSizeBytes,
      image_fetch_timeout_ms: config.imageFetchTimeoutMs,
      batch_max_images: config.batchMaxImages,
      batch_concurrency: config.batchConcurrency,
    },
    warnings,
    recommended_actions: recommendedActions,
    data_policy: {
      includes_secret_values: false,
      includes_raw_image_urls: false,
      includes_artifact_urls: false,
    },
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

function buildBatchErrorCompact(url: string, errorMessage: string, errorCode: string): Record<string, unknown> {
  return {
    schema_version: "vision-mcp.v3.error",
    analysis_id: `ve_${randomUUID()}`,
    status: "error",
    error_code: errorCode,
    prep_mode: "screenshot-prep-error",
    source_url: url,
    prepared_for: "native_frontier_vision",
    analysis_scope: "error",
    image_urls_for_model: [],
    recommended_profile: "anthropic_fast",
    artifact_profiles: [],
    annotation_regions: [],
    detection_summary: {
      red_regions_detected: 0,
      ready_for_frontier_vision: false,
      crop_pipeline_version: CROP_PIPELINE_VERSION,
    },
    confidence: {
      overall: 0,
      uncertainty: 1,
      clarification_threshold: 0.03,
    },
    autopilot: {
      requires_clarification: true,
      suggested_action: "ask_user_to_confirm_missing_annotations",
      reason: "batch_item_error",
    },
    needs_review: true,
    next_questions: [
      "This screenshot could not be prepared. Retry this URL separately after checking URL reachability.",
    ],
    notes: [
      `Batch item failed without aborting the whole batch: ${errorMessage}`,
    ],
  };
}

async function audited<T>(
  tool: string,
  transport: "mcp" | "http",
  args: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const requestId = randomUUID();
  try {
    const result = await run();
    await appendRequestLog(config, {
      tool,
      transport,
      request_id: requestId,
      ok: true,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      output: summarizeOutput(result),
    });
    return result;
  } catch (error) {
    await appendRequestLog(config, {
      tool,
      transport,
      request_id: requestId,
      ok: false,
      error_code: classifyError(error),
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function fetchImageBuffer(url: string, maxSize: number): Promise<{
  base64: string;
  contentType: string;
  size: number;
}> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.imageFetchTimeoutMs);

  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out after ${config.imageFetchTimeoutMs}ms while fetching ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "image/png";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));

  if (buffer.length > maxSize) {
    throw new Error(`Image size (${buffer.length} bytes) exceeds maximum allowed (${maxSize} bytes)`);
  }

  return {
    base64: buffer.toString("base64"),
    contentType,
    size: buffer.length,
  };
}

function buildVerboseContent(result: AnalyzeUrlResult): { type: "text"; text: string } {
  return {
    type: "text",
    text: stringifyResult({
      verbose: result.verbose,
    }),
  };
}

function createVisionServer(): Server {
  const server = new Server(
    {
      name: "hwai-vision-mcp",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        FETCH_IMAGE_TOOL,
        IMAGE_TO_TEXT_TOOL,
        ANALYZE_SCREENSHOT_TOOL,
        PREPARE_SCREENSHOT_TOOL,
        BATCH_ANALYZE_TOOL,
        BATCH_PREPARE_TOOL,
        ANALYZE_SCREENSHOT_DIFF_TOOL,
        PREPARE_SCREENSHOT_DIFF_TOOL,
        RUNTIME_DIAGNOSTICS_TOOL,
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "get_runtime_diagnostics") {
      const result = await audited(name, "mcp", args as Record<string, unknown> | undefined, async () =>
        runtimeDiagnostics(),
      );
      return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
    }

    if (name === "analyze_screenshot" || name === "prepare_screenshot") {
      const url = args?.url as string;
      const context = (args?.context as string) || "UI annotations";
      const metadata = args?.metadata;
      const taskIntent = args?.task_intent;
      const verbose = Boolean(args?.verbose);
      const recordArgs = args as Record<string, unknown> | undefined;

      if (!url) {
        return toolError("Error: URL is required");
      }

      try {
        const result = await audited(name, "mcp", recordArgs, async () =>
          analyzeScreenshotUrl(url, context, config, metadata, taskIntent),
        );
        const content = [
          {
            type: "text" as const,
            text: stringifyResult(result.compact),
          },
        ];

        if (verbose) {
          content.push(buildVerboseContent(result));
        }

        return { content };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error analyzing screenshot: ${errorMessage}`);
      }
    }

    if (name === "batch_analyze_screenshots" || name === "batch_prepare_screenshots") {
      const urls = (args?.urls as string[]) || [];
      const context = (args?.context as string) || "batch analysis";
      const metadata = args?.metadata;
      const taskIntent = args?.task_intent;
      const verbose = Boolean(args?.verbose);
      const recordArgs = args as Record<string, unknown> | undefined;

      if (!urls.length) {
        return toolError("Error: No URLs provided");
      }

      if (urls.length > config.batchMaxImages) {
        return toolError(
          `Error: batch contains ${urls.length} images, but this vision-mcp instance allows ${config.batchMaxImages}. ` +
            "Split large screenshot sets into smaller batches so the MCP client does not hit its transport timeout.",
        );
      }

      try {
        const { compact, results } = await audited(name, "mcp", recordArgs, async () => {
          const start = Date.now();
          const batchId = `vb_${randomUUID()}`;
          const batchResults = await mapWithConcurrency(
            urls,
            config.batchConcurrency,
            async (url) => {
              try {
                return await analyzeScreenshotUrl(url, context, config, metadata, taskIntent);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  compact: buildBatchErrorCompact(url, message, classifyError(error)),
                  verbose: {
                    cache_hit: false,
                    analysis_cache_key: "",
                    image_cache_key: "",
                    artifact_keys: [],
                    prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
                    error: message,
                  },
                };
              }
            },
          );

          const failedImages = batchResults.filter(
            (item) => (item.compact as any).schema_version === "vision-mcp.v3.error",
          ).length;
          return {
            results: batchResults,
            compact: {
              schema_version: "vision-mcp.v3.batch",
              batch_id: batchId,
              status: failedImages > 0 ? "partial_error" : "ok",
              total_images: batchResults.length,
              ok_images: batchResults.length - failedImages,
              total_annotation_regions: batchResults.reduce(
                (sum, item) =>
                  sum + (Array.isArray((item.compact as any).annotation_regions)
                    ? (item.compact as any).annotation_regions.length
                    : 0),
                0,
              ),
              failed_images: failedImages,
              batch_concurrency: config.batchConcurrency,
              batch_max_images: config.batchMaxImages,
              total_time_ms: Date.now() - start,
              results: batchResults.map((item) => item.compact),
            },
          };
        });

        const content = [
          {
            type: "text" as const,
            text: stringifyResult(compact),
          },
        ];

        if (verbose) {
          content.push({
            type: "text" as const,
            text: stringifyResult({
              results: results.map((item) => item.verbose),
            }),
          });
        }

        return { content };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Batch analysis error: ${errorMessage}`);
      }
    }

    if (name === "analyze_screenshot_diff" || name === "prepare_screenshot_diff") {
      const beforeUrl = args?.before_url as string;
      const afterUrl = args?.after_url as string;
      const context = (args?.context as string) || "UI before/after diff";
      const metadata = args?.metadata;
      const ignoreRegions = args?.ignore_regions;
      const ignorePresets = args?.ignore_presets;
      const regionPolicies = args?.region_policies;
      const reviewProfile = args?.review_profile;
      const verbose = Boolean(args?.verbose);
      const recordArgs = args as Record<string, unknown> | undefined;

      if (!beforeUrl || !afterUrl) {
        return toolError("Error: before_url and after_url are required");
      }

      try {
        const result = await audited(name, "mcp", recordArgs, async () =>
          analyzeScreenshotDiff(
            beforeUrl,
            afterUrl,
            context,
            config,
            metadata,
            ignoreRegions,
            ignorePresets,
            reviewProfile,
            regionPolicies,
          ),
        );
        const content = [
          {
            type: "text" as const,
            text: stringifyResult(result.compact),
          },
        ];

        if (verbose) {
          content.push({
            type: "text" as const,
            text: stringifyResult({
              verbose: result.verbose,
            }),
          });
        }

        return { content };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error preparing screenshot diff: ${errorMessage}`);
      }
    }

    if (name === "fetch_image") {
      const url = args?.url as string;
      const maxSize = (args?.maxSize as number) || 5 * 1024 * 1024;
      const recordArgs = args as Record<string, unknown> | undefined;

      if (!url) {
        return toolError("Error: URL is required");
      }

      try {
        const { parsed, image } = await audited(name, "mcp", recordArgs, async () => {
          const parsedUrl = assertAllowedImageUrl(url, config.allowedHosts, config.allowAnyImageUrl);
          const fetchedImage = await fetchImageBuffer(parsedUrl.toString(), maxSize);
          return { parsed: parsedUrl, image: fetchedImage };
        });
        return {
          content: [
            {
              type: "image",
              data: image.base64,
              mimeType: image.contentType,
            },
            {
              type: "text",
              text:
                `Image fetched successfully from ${parsed.toString()}\n` +
                `Size: ${image.size} bytes\n` +
                `Type: ${image.contentType}\n` +
                `Note: fetch_image is a debug/fallback path. Prefer analyze_screenshot for prep-first screenshot review.`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error fetching image: ${errorMessage}`);
      }
    }

    if (name === "image_url_to_text") {
      const url = args?.url as string;
      const context = (args?.context as string) || "general analysis";
      const recordArgs = args as Record<string, unknown> | undefined;

      if (!url) {
        return toolError("Error: URL is required");
      }

      try {
        const { parsed, image } = await audited(name, "mcp", recordArgs, async () => {
          const parsedUrl = assertAllowedImageUrl(url, config.allowedHosts, config.allowAnyImageUrl);
          const fetchedImage = await fetchImageBuffer(parsedUrl.toString(), config.maxImageSizeBytes);
          return { parsed: parsedUrl, image: fetchedImage };
        });

        return {
          content: [
            {
              type: "image",
              data: image.base64,
              mimeType: image.contentType,
            },
            {
              type: "text",
              text:
                `Screenshot/image loaded from: ${parsed.toString()}\n\n` +
                `Context: ${context}\n\n` +
                `Please analyze this image and identify:\n` +
                `1. Any numbered tasks or annotations\n` +
                `2. UI elements, buttons, or forms shown\n` +
                `3. Text content and its purpose\n` +
                `4. Visual hierarchy and layout\n\n` +
                `If this is a screenshot with task annotations, list each task with its number.`,
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return toolError(`Error processing image: ${errorMessage}`);
      }
    }

    return toolError(`Unknown tool: ${name}`);
  });

  return server;
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
    return;
  }

  const server = createVisionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    const parsedBody = await parseBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error("Error handling HTTP MCP request:", error);
    if (!res.headersSent) {
      respondJson(res, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
    await transport.close();
    await server.close();
  }
}

async function startHttpServer(): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (url.pathname === "/health") {
        respondJson(res, 200, {
          ok: true,
          cache_dir: config.cacheDir,
          artifact_dir: config.artifactDir,
          public_base_url: config.publicBaseUrl,
          allowed_hosts: config.allowedHosts,
          allow_any_image_url: config.allowAnyImageUrl,
          transport_mode: "http",
          prep_mode: "screenshot-prep",
          prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
          diagnostics: runtimeDiagnostics(),
        });
        return;
      }

      if (url.pathname.startsWith("/artifacts/")) {
        const fileName = path.basename(url.pathname.replace("/artifacts/", ""));
        const artifact = await readArtifact(config, fileName);

        if (!artifact) {
          respondJson(res, 404, { error: "Artifact not found" });
          return;
        }

        const ext = path.extname(fileName).toLowerCase();
        const contentType =
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".json"
              ? "application/json"
              : "application/octet-stream";

        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        res.end(artifact);
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcpHttp(req, res);
        return;
      }

      respondJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("HTTP server error:", error);
      if (!res.headersSent) {
        respondJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => resolve());
  });

  console.error(
    `HWAI Vision MCP Server running on HTTP http://${config.httpHost}:${config.httpPort}/mcp`,
  );
}

async function startStdioServer(): Promise<void> {
  const server = createVisionServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HWAI Vision MCP Server running on stdio");
}

async function main() {
  if (config.transportMode === "http") {
    await startHttpServer();
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
