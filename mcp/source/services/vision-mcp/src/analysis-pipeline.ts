import sharp from "sharp";
import fetch from "node-fetch";
import { optimizeForVLM } from "./image-optimizer.js";
import { detectAnnotationRegions, BoundingBox, DetectedAnnotationRegion } from "./annotation-detector.js";
import { detectChangedRegions, DetectedChangedRegion } from "./diff-detector.js";
import {
  SCREENSHOT_ANALYSIS_PROMPT_VERSION,
  CROP_PIPELINE_VERSION,
  OPTIMIZATION_PIPELINE_VERSION,
  VisionRuntimeConfig,
} from "./config.js";
import {
  ensureCacheDir,
  getBinaryCache,
  getJsonCache,
  setBinaryCache,
  setJsonCache,
  sha256Hex,
} from "./cache.js";
import { assertAllowedImageUrl } from "./url-policy.js";
import { estimateImageTokens, ImageTokenEstimate } from "./token-estimates.js";
import {
  persistArtifactBuffer,
  persistArtifactJson,
} from "./artifact-store.js";
import { runTesseractOcr, OcrResult } from "./ocr.js";
import { AnnotationRegionType } from "./annotation-detector.js";
import { expandIgnorePresets, IgnorePresetName } from "./ignore-presets.js";
import { DiffReviewProfileName, resolveDiffReviewProfile } from "./diff-review-profiles.js";
import {
  ScreenshotTaskIntentName,
  resolveScreenshotTaskIntent,
} from "./screenshot-task-intents.js";

const USER_AGENT = "HWAI-Vision-MCP/3.0";
const AUTOPILOT_CLARIFICATION_UNCERTAINTY_THRESHOLD = 0.03;
const FULL_FRAME_MAX_DIMENSION = 1600;
const ANNOTATION_CROP_MAX_DIMENSION = 1200;
const CONTEXT_CROP_MAX_DIMENSION = 1400;
const DIFF_CROP_MAX_DIMENSION = 1200;
const DIFF_CONTEXT_CROP_MAX_DIMENSION = 1400;

export interface PreparedImageArtifact {
  url: string;
  width: number;
  height: number;
  format: "jpeg";
  size_bytes: number;
  estimated_tokens: ImageTokenEstimate;
}

export interface PreparedAnnotationRegion {
  id: number;
  region: BoundingBox;
  review_order: number;
  region_type: AnnotationRegionType;
  region_type_confidence: number;
  priority_score: number;
  include_by_default: boolean;
  red_pixel_ratio: number;
  red_pixel_count: number;
  coverage_ratio: number;
  annotation_crop: PreparedImageArtifact;
  context_crop: PreparedImageArtifact;
  ocr: OcrResult | null;
}

export interface PreparedChangedRegion {
  id: number;
  region: BoundingBox;
  review_order: number;
  priority_score: number;
  include_by_default: boolean;
  changed_pixel_count: number;
  changed_pixel_ratio: number;
  coverage_ratio: number;
  mean_abs_diff: number;
  before_crop: PreparedImageArtifact;
  after_crop: PreparedImageArtifact;
  before_context_crop: PreparedImageArtifact;
  after_context_crop: PreparedImageArtifact;
}

export interface ArtifactProfile {
  profile: "anthropic_fast" | "anthropic_full" | "openai_low_detail" | "openai_high_detail";
  recommended_for: "anthropic" | "openai";
  recommended_max_regions: number;
  selected_region_ids: number[];
  image_urls: string[];
  estimated_tokens: {
    anthropic_approx: number;
    openai_low_detail: number;
    openai_high_detail_approx: number;
  };
}

export interface ScreenshotMetadata {
  page_url?: string;
  page_title?: string;
  browser?: string;
  os?: string;
  environment?: string;
  timestamp?: string;
  session_id?: string;
  report_id?: string;
  build_id?: string;
  branch?: string;
  commit_sha?: string;
  captured_by?: string;
  device_pixel_ratio?: number;
  reporter_comment?: string;
  feature_flags?: string[];
  labels?: string[];
  console_errors?: string[];
  network_notes?: string[];
  viewport?: {
    width?: number;
    height?: number;
  };
}

export interface IgnoreRegionInput {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinate_space: "pixels" | "normalized";
  applies_to: "before" | "after" | "both";
  reason?: string;
}

export interface CompactAnalysisResult {
  schema_version: "vision-mcp.v3";
  prep_mode: "screenshot-prep";
  task_intent: {
    applied: ScreenshotTaskIntentName;
    recommended_artifact_profile: ArtifactProfile["profile"];
    guidance: string;
  };
  source_url: string;
  prepared_for: "native_frontier_vision";
  analysis_scope: "full_frame_plus_annotation_regions";
  input_metadata: ScreenshotMetadata | null;
  artifacts: {
    full_frame: PreparedImageArtifact;
    manifest_url: string;
  };
  image_urls_for_model: string[];
  recommended_profile: ArtifactProfile["profile"];
  artifact_profiles: ArtifactProfile[];
  annotation_regions: PreparedAnnotationRegion[];
  detection_summary: {
    red_regions_detected: number;
    ready_for_frontier_vision: boolean;
    task_intent_applied: ScreenshotTaskIntentName;
    crop_pipeline_version: string;
    optimization_pipeline_version: string;
  };
  prompt_scaffold: string;
  confidence: {
    overall: number;
    uncertainty: number;
    clarification_threshold: number;
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "use_native_frontier_vision" | "ask_user_to_confirm_missing_annotations";
    reason: "ready_for_frontier_vision" | "no_red_regions_detected";
  };
  needs_review: boolean;
  next_questions: string[];
  notes: string[];
}

export interface DiffArtifactProfile {
  profile: "anthropic_fast" | "anthropic_full" | "openai_low_detail" | "openai_high_detail";
  recommended_for: "anthropic" | "openai";
  recommended_max_regions: number;
  selected_region_ids: number[];
  image_urls: string[];
  estimated_tokens: {
    anthropic_approx: number;
    openai_low_detail: number;
    openai_high_detail_approx: number;
  };
}

export interface CompactDiffResult {
  schema_version: "vision-mcp.v3.diff";
  prep_mode: "screenshot-diff-prep";
  review_profile: {
    applied: DiffReviewProfileName;
    recommended_artifact_profile: DiffArtifactProfile["profile"];
    guidance: string;
  };
  source_urls: {
    before: string;
    after: string;
  };
  prepared_for: "native_frontier_vision";
  analysis_scope: "aligned_before_after_plus_changed_regions";
  input_metadata: ScreenshotMetadata | null;
  artifacts: {
    before_full_frame: PreparedImageArtifact;
    after_full_frame: PreparedImageArtifact;
    manifest_url: string;
  };
  image_urls_for_model: string[];
  recommended_profile: DiffArtifactProfile["profile"];
  artifact_profiles: DiffArtifactProfile[];
  changed_regions: PreparedChangedRegion[];
  detection_summary: {
    changed_regions_detected: number;
    compare_dimensions: {
      width: number;
      height: number;
    };
    ignored_regions_applied: number;
    ignore_presets_applied: IgnorePresetName[];
    review_profile_applied: DiffReviewProfileName;
    diff_pipeline_version: string;
    optimization_pipeline_version: string;
  };
  prompt_scaffold: string;
  confidence: {
    overall: number;
    uncertainty: number;
    clarification_threshold: number;
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "use_native_frontier_vision";
    reason: "changed_regions_detected" | "no_changed_regions_detected";
  };
  needs_review: boolean;
  next_questions: string[];
  notes: string[];
}

export interface VerboseAnalysisDetails {
  cache_hit: boolean;
  analysis_cache_key: string;
  image_cache_key: string;
  artifact_keys: string[];
  etag?: string | null;
  last_modified?: string | null;
  content_type?: string | null;
  content_length?: number | null;
  optimized_size_bytes?: number;
  original_size_bytes?: number;
  original_dimensions?: { width: number; height: number };
  prepared_dimensions?: { width: number; height: number };
  prompt_version: string;
}

export interface AnalyzeUrlResult {
  compact: CompactAnalysisResult;
  verbose: VerboseAnalysisDetails;
}

export interface AnalyzeDiffResult {
  compact: CompactDiffResult;
  verbose: VerboseAnalysisDetails;
}

interface HeadMetadata {
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

interface DownloadedImage extends HeadMetadata {
  buffer: Buffer;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function contentLengthFromHeader(raw: string | null): number | null {
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function headImage(url: string): Promise<HeadMetadata> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
    });

    if (!response.ok) {
      return {
        contentLength: null,
        contentType: null,
        etag: null,
        lastModified: null,
      };
    }

    return {
      contentLength: contentLengthFromHeader(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } catch {
    return {
      contentLength: null,
      contentType: null,
      etag: null,
      lastModified: null,
    };
  }
}

async function downloadImage(url: string, maxImageSizeBytes: number): Promise<DownloadedImage> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));

  if (buffer.length > maxImageSizeBytes) {
    throw new Error(
      `Image size ${buffer.length} bytes exceeds limit ${maxImageSizeBytes} bytes`,
    );
  }

  return {
    buffer,
    contentLength: contentLengthFromHeader(response.headers.get("content-length")) ?? buffer.length,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function imageCacheKey(url: string, meta: HeadMetadata): string {
  return sha256Hex(
    JSON.stringify({
      url,
      etag: meta.etag || "",
      lastModified: meta.lastModified || "",
      optimizationVersion: OPTIMIZATION_PIPELINE_VERSION,
    }),
  );
}

function normalizeMetadata(metadata: unknown): ScreenshotMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const source = metadata as Record<string, unknown>;
  const readString = (key: string): string | undefined => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const readStringArray = (key: string): string[] | undefined => {
    const value = source[key];
    if (!Array.isArray(value)) {
      return undefined;
    }
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return items.length ? items : undefined;
  };
  const viewportSource =
    source.viewport && typeof source.viewport === "object" && !Array.isArray(source.viewport)
      ? (source.viewport as Record<string, unknown>)
      : null;
  const readPositiveNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const readFiniteNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const normalized: ScreenshotMetadata = {
    page_url: readString("page_url"),
    page_title: readString("page_title"),
    browser: readString("browser"),
    os: readString("os"),
    environment: readString("environment"),
    timestamp: readString("timestamp"),
    session_id: readString("session_id"),
    report_id: readString("report_id"),
    build_id: readString("build_id"),
    branch: readString("branch"),
    commit_sha: readString("commit_sha"),
    captured_by: readString("captured_by"),
    device_pixel_ratio: readFiniteNumber(source.device_pixel_ratio),
    reporter_comment: readString("reporter_comment"),
    feature_flags: readStringArray("feature_flags"),
    labels: readStringArray("labels"),
    console_errors: readStringArray("console_errors"),
    network_notes: readStringArray("network_notes"),
  };

  if (viewportSource) {
    const width = readPositiveNumber(viewportSource.width);
    const height = readPositiveNumber(viewportSource.height);
    if (width || height) {
      normalized.viewport = { width, height };
    }
  }

  const hasValues = Object.values(normalized).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  );

  return hasValues ? normalized : null;
}

function normalizeIgnoreRegions(input: unknown): IgnoreRegionInput[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: IgnoreRegionInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const source = item as Record<string, unknown>;
    const x = typeof source.x === "number" && Number.isFinite(source.x) ? source.x : null;
    const y = typeof source.y === "number" && Number.isFinite(source.y) ? source.y : null;
    const width = typeof source.width === "number" && Number.isFinite(source.width) ? source.width : null;
    const height = typeof source.height === "number" && Number.isFinite(source.height) ? source.height : null;

    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
      continue;
    }

    const coordinateSpace =
      source.coordinate_space === "pixels" || source.coordinate_space === "normalized"
        ? source.coordinate_space
        : "pixels";
    const appliesTo =
      source.applies_to === "before" || source.applies_to === "after" || source.applies_to === "both"
        ? source.applies_to
        : "both";
    const reason =
      typeof source.reason === "string" && source.reason.trim() ? source.reason.trim() : undefined;

    normalized.push({
      x,
      y,
      width,
      height,
      coordinate_space: coordinateSpace,
      applies_to: appliesTo,
      reason,
    });
  }

  return normalized;
}

function prepCacheKey(
  url: string,
  meta: HeadMetadata,
  context: string,
  metadata: ScreenshotMetadata | null,
  taskIntentName: ScreenshotTaskIntentName,
): string {
  return sha256Hex(
    JSON.stringify({
      url,
      etag: meta.etag || "",
      lastModified: meta.lastModified || "",
      context,
      metadata: metadata || null,
      taskIntentName,
      cropPipelineVersion: CROP_PIPELINE_VERSION,
      promptVersion: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
      optimizationVersion: OPTIMIZATION_PIPELINE_VERSION,
    }),
  );
}

function buildArtifactKey(url: string, suffix: string, meta: HeadMetadata): string {
  return sha256Hex(
    JSON.stringify({
      url,
      suffix,
      etag: meta.etag || "",
      lastModified: meta.lastModified || "",
      cropPipelineVersion: CROP_PIPELINE_VERSION,
      optimizationVersion: OPTIMIZATION_PIPELINE_VERSION,
    }),
  );
}

function buildCombinedArtifactKey(
  beforeUrl: string,
  afterUrl: string,
  suffix: string,
  beforeMeta: HeadMetadata,
  afterMeta: HeadMetadata,
): string {
  return sha256Hex(
    JSON.stringify({
      beforeUrl,
      afterUrl,
      suffix,
      beforeEtag: beforeMeta.etag || "",
      afterEtag: afterMeta.etag || "",
      beforeLastModified: beforeMeta.lastModified || "",
      afterLastModified: afterMeta.lastModified || "",
      cropPipelineVersion: CROP_PIPELINE_VERSION,
      optimizationVersion: OPTIMIZATION_PIPELINE_VERSION,
      mode: "diff",
    }),
  );
}

async function jpegBufferFromExtract(
  imageBuffer: Buffer,
  extract: BoundingBox,
  maxDimension: number,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const optimized = await optimizeForVLM(
    await sharp(imageBuffer)
      .extract({
        left: extract.x,
        top: extract.y,
        width: extract.width,
        height: extract.height,
      })
      .jpeg({ quality: 88, progressive: true, mozjpeg: true })
      .toBuffer(),
    {
      maxWidth: maxDimension,
      maxHeight: maxDimension,
      quality: 86,
      format: "jpeg",
    },
  );

  return {
    buffer: optimized.buffer,
    width: optimized.finalDimensions.width,
    height: optimized.finalDimensions.height,
  };
}

function clampBox(box: BoundingBox, width: number, height: number): BoundingBox {
  const left = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const top = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  const right = Math.max(left + 1, Math.min(width, Math.round(box.x + box.width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.round(box.y + box.height)));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function expandBox(
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  options: { paddingX: number; paddingY: number; minWidth: number; minHeight: number },
): BoundingBox {
  const targetWidth = Math.max(options.minWidth, box.width + options.paddingX * 2);
  const targetHeight = Math.max(options.minHeight, box.height + options.paddingY * 2);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  return clampBox(
    {
      x: centerX - targetWidth / 2,
      y: centerY - targetHeight / 2,
      width: targetWidth,
      height: targetHeight,
    },
    imageWidth,
    imageHeight,
  );
}

function appendMetadataLines(lines: string[], metadata: ScreenshotMetadata | null): void {
  if (!metadata) {
    return;
  }

  lines.push("Input metadata:");
  if (metadata.page_url) {
    lines.push(`- Page URL: ${metadata.page_url}`);
  }
  if (metadata.page_title) {
    lines.push(`- Page title: ${metadata.page_title}`);
  }
  if (metadata.viewport?.width || metadata.viewport?.height) {
    lines.push(`- Viewport: ${metadata.viewport?.width || "?"}x${metadata.viewport?.height || "?"}`);
  }
  if (metadata.browser || metadata.os) {
    lines.push(`- Runtime: ${metadata.browser || "unknown browser"} on ${metadata.os || "unknown OS"}`);
  }
  if (metadata.environment) {
    lines.push(`- Environment: ${metadata.environment}`);
  }
  if (metadata.timestamp) {
    lines.push(`- Captured at: ${metadata.timestamp}`);
  }
  if (metadata.captured_by) {
    lines.push(`- Captured by: ${metadata.captured_by}`);
  }
  if (metadata.session_id) {
    lines.push(`- Session ID: ${metadata.session_id}`);
  }
  if (metadata.report_id) {
    lines.push(`- Report ID: ${metadata.report_id}`);
  }
  if (metadata.build_id) {
    lines.push(`- Build ID: ${metadata.build_id}`);
  }
  if (metadata.branch || metadata.commit_sha) {
    lines.push(`- Revision: ${metadata.branch || "unknown branch"} @ ${metadata.commit_sha || "unknown commit"}`);
  }
  if (metadata.device_pixel_ratio) {
    lines.push(`- Device pixel ratio: ${metadata.device_pixel_ratio}`);
  }
  if (metadata.feature_flags?.length) {
    lines.push(`- Feature flags: ${metadata.feature_flags.join(", ")}`);
  }
  if (metadata.labels?.length) {
    lines.push(`- Labels: ${metadata.labels.join(", ")}`);
  }
  if (metadata.console_errors?.length) {
    lines.push(`- Console errors: ${metadata.console_errors.join(" | ")}`);
  }
  if (metadata.network_notes?.length) {
    lines.push(`- Network notes: ${metadata.network_notes.join(" | ")}`);
  }
  if (metadata.reporter_comment) {
    lines.push(`- Reporter comment: ${metadata.reporter_comment}`);
  }
}

function normalizeIgnoreRegionBox(
  region: IgnoreRegionInput,
  width: number,
  height: number,
): BoundingBox {
  if (region.coordinate_space === "normalized") {
    return clampBox(
      {
        x: region.x * width,
        y: region.y * height,
        width: region.width * width,
        height: region.height * height,
      },
      width,
      height,
    );
  }

  return clampBox(region, width, height);
}

function applyIgnoreRegionsToRaw(
  buffer: Buffer,
  width: number,
  height: number,
  channels: number,
  regions: IgnoreRegionInput[],
  surface: "before" | "after",
): number {
  let applied = 0;
  for (const region of regions) {
    if (region.applies_to !== "both" && region.applies_to !== surface) {
      continue;
    }

    const box = normalizeIgnoreRegionBox(region, width, height);
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const offset = (y * width + x) * channels;
        for (let c = 0; c < channels; c += 1) {
          buffer[offset + c] = 0;
        }
      }
    }
    applied += 1;
  }

  return applied;
}

function buildPromptScaffold(
  sourceUrl: string,
  fullFrameUrl: string,
  regions: PreparedAnnotationRegion[],
  metadata: ScreenshotMetadata | null,
  taskIntentName: ScreenshotTaskIntentName,
  taskIntentGuidance: string,
  recommendedProfile: ArtifactProfile["profile"],
): string {
  const ranked = [...regions]
    .sort((a, b) => {
      if (b.priority_score !== a.priority_score) {
        return b.priority_score - a.priority_score;
      }
      return a.review_order - b.review_order;
    })
    .slice(0, 2)
    .map((region) => region.id);

  const lines = [
    "Use native frontier vision on these prepared screenshot artifacts.",
    `Source screenshot: ${sourceUrl}`,
    `1. Review the prepared full frame first: ${fullFrameUrl}`,
    "2. Then inspect each annotation crop together with its wider context crop in review order.",
    "3. Distinguish reviewer markup from the underlying interface.",
    "4. Extract the exact comment text from each annotation crop and map it to the UI target visible in the context crop.",
    "5. Preserve numbered order when present.",
    `6. Start with the recommended artifact profile \`${recommendedProfile}\`; only expand if ambiguity remains.`,
    "7. If uncertainty is above 3%, ask one focused clarification question before editing code.",
  ];

  appendMetadataLines(lines, metadata);
  lines.push(`- Task intent: ${taskIntentName}`);
  lines.push(`- Task guidance: ${taskIntentGuidance}`);

  if (regions.length > 0) {
    lines.push("Prepared annotation regions:");
    for (const region of regions) {
      const details = [
        `- Region ${region.id} [${region.region_type}]`,
        `annotation ${region.annotation_crop.url}`,
        `context ${region.context_crop.url}`,
        `priority ${region.priority_score}`,
      ];
      if (ranked.includes(region.id)) {
        details.push("fast-profile");
      }
      if (shouldIncludeOcrHint(region.ocr)) {
        details.push(`ocr "${region.ocr!.text}"`);
      }
      lines.push(details.join(" | "));
    }
  } else {
    lines.push("No red annotation regions were auto-detected. Review the full frame manually before deciding whether clarification is needed.");
  }

  return lines.join("\n");
}

function shouldIncludeOcrHint(ocr: OcrResult | null): boolean {
  if (!ocr?.text) {
    return false;
  }

  const hasEnoughText = ocr.text.length >= 3;
  const confidence = ocr.confidence ?? 0;
  return hasEnoughText && confidence >= 0.45;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function typePriorityWeight(regionType: AnnotationRegionType): number {
  switch (regionType) {
    case "comment_box":
      return 0.95;
    case "outline":
      return 0.82;
    case "arrow":
      return 0.78;
    case "underline":
      return 0.72;
    case "marker_dot":
      return 0.66;
    default:
      return 0.56;
  }
}

function computeRegionPriority(
  region: Pick<
    PreparedAnnotationRegion,
    "region_type" | "coverage_ratio" | "red_pixel_ratio" | "region" | "ocr"
  >,
): number {
  const area = Math.max(1, region.region.width * region.region.height);
  const typeWeight = typePriorityWeight(region.region_type);
  const areaScore = clamp01(Math.sqrt(area / 60000));
  const coverageScore = clamp01(region.coverage_ratio * 28);
  const redScore = clamp01(region.red_pixel_ratio * 3.5);
  const ocrScore = clamp01(region.ocr?.confidence ?? 0);

  return round(
    typeWeight * 0.45 +
      areaScore * 0.2 +
      coverageScore * 0.2 +
      redScore * 0.05 +
      ocrScore * 0.1,
  );
}

function totalTokenEstimate(images: PreparedImageArtifact[]): ArtifactProfile["estimated_tokens"] {
  return images.reduce(
    (sum, image) => ({
      anthropic_approx: sum.anthropic_approx + image.estimated_tokens.anthropic_approx,
      openai_low_detail: sum.openai_low_detail + image.estimated_tokens.openai_low_detail,
      openai_high_detail_approx:
        sum.openai_high_detail_approx + image.estimated_tokens.openai_high_detail_approx,
    }),
    {
      anthropic_approx: 0,
      openai_low_detail: 0,
      openai_high_detail_approx: 0,
    },
  );
}

function buildArtifactProfiles(
  fullFrame: PreparedImageArtifact,
  annotationRegions: PreparedAnnotationRegion[],
  recommendedProfileOverride?: ArtifactProfile["profile"],
  fastMaxRegions: number = 2,
  openaiHighDetailMaxRegions: number = 3,
): { recommendedProfile: ArtifactProfile["profile"]; profiles: ArtifactProfile[] } {
  const ranked = [...annotationRegions]
    .sort((a, b) => {
      if (b.priority_score !== a.priority_score) {
        return b.priority_score - a.priority_score;
      }
      return a.review_order - b.review_order;
    });

  const selectRegions = (maxRegions: number): PreparedAnnotationRegion[] => {
    const selected = ranked.filter((region) => region.include_by_default).slice(0, maxRegions);
    if (selected.length > 0) {
      return selected;
    }
    return ranked.slice(0, maxRegions);
  };

  const toProfile = (
    profile: ArtifactProfile["profile"],
    recommendedFor: ArtifactProfile["recommended_for"],
    maxRegions: number,
    forceAll: boolean = false,
  ): ArtifactProfile => {
    const selectedRegions = forceAll ? ranked : selectRegions(maxRegions);
    const images = [
      fullFrame,
      ...selectedRegions.flatMap((region) => [region.annotation_crop, region.context_crop]),
    ];

    return {
      profile,
      recommended_for: recommendedFor,
      recommended_max_regions: maxRegions,
      selected_region_ids: selectedRegions.map((region) => region.id),
      image_urls: images.map((image) => image.url),
      estimated_tokens: totalTokenEstimate(images),
    };
  };

  const profiles: ArtifactProfile[] = [
    toProfile("anthropic_fast", "anthropic", fastMaxRegions),
    toProfile("anthropic_full", "anthropic", ranked.length || 1, true),
    toProfile("openai_low_detail", "openai", fastMaxRegions),
    toProfile("openai_high_detail", "openai", openaiHighDetailMaxRegions),
  ];

  return {
    recommendedProfile: recommendedProfileOverride || "anthropic_fast",
    profiles,
  };
}

function diffPrepCacheKey(
  beforeUrl: string,
  afterUrl: string,
  beforeMeta: HeadMetadata,
  afterMeta: HeadMetadata,
  context: string,
  metadata: ScreenshotMetadata | null,
  ignoreRegions: IgnoreRegionInput[],
  ignorePresetNames: IgnorePresetName[],
  reviewProfileName: DiffReviewProfileName,
): string {
  return sha256Hex(
    JSON.stringify({
      beforeUrl,
      afterUrl,
      beforeEtag: beforeMeta.etag || "",
      afterEtag: afterMeta.etag || "",
      beforeLastModified: beforeMeta.lastModified || "",
      afterLastModified: afterMeta.lastModified || "",
      context,
      metadata: metadata || null,
      ignoreRegions,
      ignorePresetNames,
      reviewProfileName,
      cropPipelineVersion: CROP_PIPELINE_VERSION,
      promptVersion: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
      optimizationVersion: OPTIMIZATION_PIPELINE_VERSION,
      mode: "diff",
    }),
  );
}

async function resizeJpegToDimensions(
  imageBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(imageBuffer)
    .resize({
      width,
      height,
      fit: "fill",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toBuffer();
}

function computeChangedRegionPriority(region: Pick<
  PreparedChangedRegion,
  "region" | "coverage_ratio" | "changed_pixel_ratio" | "mean_abs_diff"
>): number {
  const area = Math.max(1, region.region.width * region.region.height);
  const areaScore = clamp01(Math.sqrt(area / 90000));
  const coverageScore = clamp01(region.coverage_ratio * 36);
  const densityScore = clamp01(region.changed_pixel_ratio * 1.8);
  const strengthScore = clamp01(region.mean_abs_diff / 220);

  return round(
    areaScore * 0.4 +
      coverageScore * 0.25 +
      densityScore * 0.2 +
      strengthScore * 0.15,
  );
}

function buildDiffPromptScaffold(
  beforeUrl: string,
  afterUrl: string,
  beforeFullFrameUrl: string,
  afterFullFrameUrl: string,
  regions: PreparedChangedRegion[],
  metadata: ScreenshotMetadata | null,
  ignoreRegionsApplied: number,
  ignorePresetNames: IgnorePresetName[],
  reviewProfileName: DiffReviewProfileName,
  reviewProfileGuidance: string,
): string {
  const ranked = [...regions]
    .sort((a, b) => {
      if (b.priority_score !== a.priority_score) {
        return b.priority_score - a.priority_score;
      }
      return a.review_order - b.review_order;
    })
    .slice(0, 2)
    .map((region) => region.id);

  const lines = [
    "Use native frontier vision on this prepared before/after screenshot diff.",
    `Before screenshot: ${beforeUrl}`,
    `After screenshot: ${afterUrl}`,
    `1. Review the aligned before full frame first: ${beforeFullFrameUrl}`,
    `2. Review the aligned after full frame second: ${afterFullFrameUrl}`,
    "3. Use changed-region context crops to understand the surrounding UI before looking at tight crops.",
    "4. Distinguish meaningful UI changes from browser chrome, scrollbars, or capture noise.",
    "5. Describe what changed, why it matters, and whether the change matches the intended review goal.",
    "6. Prefer the `anthropic_fast` artifact profile first; only expand to fuller profiles if ambiguity remains.",
    "7. If uncertainty is above 3%, ask one focused clarification question before editing code.",
  ];

  appendMetadataLines(lines, metadata);
  lines.push(`- Review profile: ${reviewProfileName}`);
  lines.push(`- Review guidance: ${reviewProfileGuidance}`);
  if (ignorePresetNames.length > 0) {
    lines.push(`- Ignore presets applied: ${ignorePresetNames.join(", ")}`);
  }
  if (ignoreRegionsApplied > 0) {
    lines.push(`- Ignore masks applied before diff detection: ${ignoreRegionsApplied}`);
  }

  if (regions.length > 0) {
    lines.push("Prepared changed regions:");
    for (const region of regions) {
      const details = [
        `- Region ${region.id}`,
        `before-context ${region.before_context_crop.url}`,
        `after-context ${region.after_context_crop.url}`,
        `before-crop ${region.before_crop.url}`,
        `after-crop ${region.after_crop.url}`,
        `priority ${region.priority_score}`,
      ];
      if (ranked.includes(region.id)) {
        details.push("fast-profile");
      }
      lines.push(details.join(" | "));
    }
  } else {
    lines.push("No meaningful changed regions were auto-detected. Compare the full frames directly before concluding that nothing changed.");
  }

  return lines.join("\n");
}

function buildDiffArtifactProfiles(
  beforeFullFrame: PreparedImageArtifact,
  afterFullFrame: PreparedImageArtifact,
  changedRegions: PreparedChangedRegion[],
  recommendedProfileOverride?: DiffArtifactProfile["profile"],
): { recommendedProfile: DiffArtifactProfile["profile"]; profiles: DiffArtifactProfile[] } {
  const ranked = [...changedRegions]
    .sort((a, b) => {
      if (b.priority_score !== a.priority_score) {
        return b.priority_score - a.priority_score;
      }
      return a.review_order - b.review_order;
    });

  const selectRegions = (maxRegions: number): PreparedChangedRegion[] => {
    const selected = ranked.filter((region) => region.include_by_default).slice(0, maxRegions);
    if (selected.length > 0) {
      return selected;
    }
    return ranked.slice(0, maxRegions);
  };

  const toFastImages = (regions: PreparedChangedRegion[]): PreparedImageArtifact[] => [
    beforeFullFrame,
    afterFullFrame,
    ...regions.flatMap((region) => [region.before_context_crop, region.after_context_crop]),
  ];

  const toFullImages = (regions: PreparedChangedRegion[]): PreparedImageArtifact[] => [
    beforeFullFrame,
    afterFullFrame,
    ...regions.flatMap((region) => [
      region.before_context_crop,
      region.after_context_crop,
      region.before_crop,
      region.after_crop,
    ]),
  ];

  const toProfile = (
    profile: DiffArtifactProfile["profile"],
    recommendedFor: DiffArtifactProfile["recommended_for"],
    maxRegions: number,
    forceAll: boolean,
    includeTightCrops: boolean,
  ): DiffArtifactProfile => {
    const selectedRegions = forceAll ? ranked : selectRegions(maxRegions);
    const images = includeTightCrops ? toFullImages(selectedRegions) : toFastImages(selectedRegions);
    return {
      profile,
      recommended_for: recommendedFor,
      recommended_max_regions: maxRegions,
      selected_region_ids: selectedRegions.map((region) => region.id),
      image_urls: images.map((image) => image.url),
      estimated_tokens: totalTokenEstimate(images),
    };
  };

  const profiles: DiffArtifactProfile[] = [
    toProfile("anthropic_fast", "anthropic", 2, false, false),
    toProfile("anthropic_full", "anthropic", ranked.length || 1, true, true),
    toProfile("openai_low_detail", "openai", 2, false, false),
    toProfile("openai_high_detail", "openai", 3, false, true),
  ];

  return {
    recommendedProfile: recommendedProfileOverride || "anthropic_fast",
    profiles,
  };
}

function buildCompactDiffResult(
  beforeUrl: string,
  afterUrl: string,
  beforeFullFrame: PreparedImageArtifact,
  afterFullFrame: PreparedImageArtifact,
  manifestUrl: string,
  changedRegions: PreparedChangedRegion[],
  compareWidth: number,
  compareHeight: number,
  metadata: ScreenshotMetadata | null,
  ignoredRegionsApplied: number,
  ignorePresetNames: IgnorePresetName[],
  reviewProfileName: DiffReviewProfileName,
  reviewProfileGuidance: string,
  recommendedProfileOverride?: DiffArtifactProfile["profile"],
): CompactDiffResult {
  const uncertainty = changedRegions.length > 0 ? 0.02 : 0.08;
  const artifactProfiles = buildDiffArtifactProfiles(
    beforeFullFrame,
    afterFullFrame,
    changedRegions,
    recommendedProfileOverride,
  );

  return {
    schema_version: "vision-mcp.v3.diff",
    prep_mode: "screenshot-diff-prep",
    review_profile: {
      applied: reviewProfileName,
      recommended_artifact_profile: artifactProfiles.recommendedProfile,
      guidance: reviewProfileGuidance,
    },
    source_urls: {
      before: beforeUrl,
      after: afterUrl,
    },
    prepared_for: "native_frontier_vision",
    analysis_scope: "aligned_before_after_plus_changed_regions",
    input_metadata: metadata,
    artifacts: {
      before_full_frame: beforeFullFrame,
      after_full_frame: afterFullFrame,
      manifest_url: manifestUrl,
    },
    image_urls_for_model: artifactProfiles.profiles.find(
      (profile) => profile.profile === artifactProfiles.recommendedProfile,
    )!.image_urls,
    recommended_profile: artifactProfiles.recommendedProfile,
    artifact_profiles: artifactProfiles.profiles,
    changed_regions: changedRegions,
    detection_summary: {
      changed_regions_detected: changedRegions.length,
      compare_dimensions: {
        width: compareWidth,
        height: compareHeight,
      },
      ignored_regions_applied: ignoredRegionsApplied,
      ignore_presets_applied: ignorePresetNames,
      review_profile_applied: reviewProfileName,
      diff_pipeline_version: `${CROP_PIPELINE_VERSION}.diff-v1`,
      optimization_pipeline_version: OPTIMIZATION_PIPELINE_VERSION,
    },
    prompt_scaffold: buildDiffPromptScaffold(
      beforeUrl,
      afterUrl,
      beforeFullFrame.url,
      afterFullFrame.url,
      changedRegions,
      metadata,
      ignoredRegionsApplied,
      ignorePresetNames,
      reviewProfileName,
      reviewProfileGuidance,
    ),
    confidence: {
      overall: round(1 - uncertainty),
      uncertainty: round(uncertainty),
      clarification_threshold: AUTOPILOT_CLARIFICATION_UNCERTAINTY_THRESHOLD,
    },
    autopilot: {
      requires_clarification: false,
      suggested_action: "use_native_frontier_vision",
      reason: changedRegions.length > 0 ? "changed_regions_detected" : "no_changed_regions_detected",
    },
    needs_review: false,
    next_questions: [],
    notes: [
      "Diff prep mode aligns before/after screenshots and extracts changed-region crops without running Ollama.",
      "Use the aligned full frames first, then inspect changed-region context crops before tight crops.",
      "Token savings come from aligned resize plus region packaging, not from file-size compression alone.",
    ],
  };
}

function buildCompactResult(
  sourceUrl: string,
  fullFrame: PreparedImageArtifact,
  manifestUrl: string,
  annotationRegions: PreparedAnnotationRegion[],
  metadata: ScreenshotMetadata | null,
  taskIntentName: ScreenshotTaskIntentName,
  taskIntentGuidance: string,
  recommendedProfileOverride?: ArtifactProfile["profile"],
  fastMaxRegions: number = 2,
  openaiHighDetailMaxRegions: number = 3,
): CompactAnalysisResult {
  const ready = annotationRegions.length > 0;
  const uncertainty = ready ? 0.02 : 0.6;
  const artifactProfiles = buildArtifactProfiles(
    fullFrame,
    annotationRegions,
    recommendedProfileOverride,
    fastMaxRegions,
    openaiHighDetailMaxRegions,
  );
  const promptScaffold = buildPromptScaffold(
    sourceUrl,
    fullFrame.url,
    annotationRegions,
    metadata,
    taskIntentName,
    taskIntentGuidance,
    artifactProfiles.recommendedProfile,
  );

  return {
    schema_version: "vision-mcp.v3",
    prep_mode: "screenshot-prep",
    task_intent: {
      applied: taskIntentName,
      recommended_artifact_profile: artifactProfiles.recommendedProfile,
      guidance: taskIntentGuidance,
    },
    source_url: sourceUrl,
    prepared_for: "native_frontier_vision",
    analysis_scope: "full_frame_plus_annotation_regions",
    input_metadata: metadata,
    artifacts: {
      full_frame: fullFrame,
      manifest_url: manifestUrl,
    },
    image_urls_for_model: artifactProfiles.profiles.find(
      (profile) => profile.profile === artifactProfiles.recommendedProfile,
    )!.image_urls,
    recommended_profile: artifactProfiles.recommendedProfile,
    artifact_profiles: artifactProfiles.profiles,
    annotation_regions: annotationRegions,
    detection_summary: {
      red_regions_detected: annotationRegions.length,
      ready_for_frontier_vision: ready,
      task_intent_applied: taskIntentName,
      crop_pipeline_version: CROP_PIPELINE_VERSION,
      optimization_pipeline_version: OPTIMIZATION_PIPELINE_VERSION,
    },
    prompt_scaffold: promptScaffold,
    confidence: {
      overall: round(1 - uncertainty),
      uncertainty: round(uncertainty),
      clarification_threshold: AUTOPILOT_CLARIFICATION_UNCERTAINTY_THRESHOLD,
    },
    autopilot: ready
      ? {
          requires_clarification: false,
          suggested_action: "use_native_frontier_vision",
          reason: "ready_for_frontier_vision",
        }
      : {
          requires_clarification: true,
          suggested_action: "ask_user_to_confirm_missing_annotations",
          reason: "no_red_regions_detected",
        },
    needs_review: !ready,
    next_questions: ready
      ? []
      : [
          "No red annotation regions were auto-detected. Confirm whether this screenshot should contain visible red markup before implementation.",
        ],
    notes: [
      "Prep-first mode does not run Ollama or OCR by default.",
      "OCR now runs only on annotation crops when available; missing OCR is non-fatal.",
      "Use the prepared full-frame and crop URLs with the client's native frontier vision path.",
      "JPEG/WebP file size reduction alone does not drive token savings; resized image dimensions do.",
    ],
  };
}

async function makePreparedArtifact(
  config: VisionRuntimeConfig,
  key: string,
  buffer: Buffer,
  width: number,
  height: number,
): Promise<PreparedImageArtifact> {
  const stored = await persistArtifactBuffer(config, key, "jpg", buffer);
  return {
    url: stored.url,
    width,
    height,
    format: "jpeg",
    size_bytes: buffer.length,
    estimated_tokens: estimateImageTokens(width, height),
  };
}

export async function analyzeScreenshotUrl(
  rawUrl: string,
  context: string,
  config: VisionRuntimeConfig,
  metadataInput?: unknown,
  taskIntentInput?: unknown,
): Promise<AnalyzeUrlResult> {
  const url = assertAllowedImageUrl(rawUrl, config.allowedHosts, config.allowAnyImageUrl).toString();
  const normalizedMetadata = normalizeMetadata(metadataInput);
  const taskIntent = resolveScreenshotTaskIntent(taskIntentInput);

  await ensureCacheDir(config.cacheDir);

  const headMeta = await headImage(url);
  const binaryKey = imageCacheKey(url, headMeta);
  const analysisKey = prepCacheKey(url, headMeta, context, normalizedMetadata, taskIntent.name);

  const cached = await getJsonCache<AnalyzeUrlResult>(config.cacheDir, analysisKey, config.cacheTtlMs);
  if (cached) {
    return {
      compact: cached.compact,
      verbose: {
        ...cached.verbose,
        cache_hit: true,
      },
    };
  }

  let downloaded = await getBinaryCache(config.cacheDir, binaryKey, config.cacheTtlMs);
  let effectiveMeta = headMeta;

  if (!downloaded) {
    const fetched = await downloadImage(url, config.maxImageSizeBytes);
    downloaded = fetched.buffer;
    effectiveMeta = fetched;
    await setBinaryCache(config.cacheDir, binaryKey, downloaded);
  }

  const originalMetadata = await sharp(downloaded).metadata();
  const originalWidth = originalMetadata.width || 0;
  const originalHeight = originalMetadata.height || 0;

  const fullFrameOptimization = await optimizeForVLM(downloaded, {
    maxWidth: FULL_FRAME_MAX_DIMENSION,
    maxHeight: FULL_FRAME_MAX_DIMENSION,
    quality: 82,
    format: "jpeg",
  });

  const preparedBuffer = fullFrameOptimization.buffer;
  const preparedWidth = fullFrameOptimization.finalDimensions.width;
  const preparedHeight = fullFrameOptimization.finalDimensions.height;

  const fullFrameKey = buildArtifactKey(url, "full-frame", effectiveMeta);
  const fullFrameArtifact = await makePreparedArtifact(
    config,
    fullFrameKey,
    preparedBuffer,
    preparedWidth,
    preparedHeight,
  );

  const detectedRegions = await detectAnnotationRegions(preparedBuffer);
  const annotationRegions: PreparedAnnotationRegion[] = [];
  const artifactKeys: string[] = [fullFrameKey];

  for (const region of detectedRegions) {
    const annotationBox = expandBox(region, preparedWidth, preparedHeight, {
      paddingX: 24,
      paddingY: 24,
      minWidth: 220,
      minHeight: 140,
    });
    const contextBox = expandBox(region, preparedWidth, preparedHeight, {
      paddingX: Math.max(90, Math.round(region.width * 1.25)),
      paddingY: Math.max(70, Math.round(region.height * 1.25)),
      minWidth: 420,
      minHeight: 260,
    });

    const annotationKey = buildArtifactKey(url, `annotation-${region.id}`, effectiveMeta);
    const contextKey = buildArtifactKey(url, `context-${region.id}`, effectiveMeta);

    artifactKeys.push(annotationKey, contextKey);

    const annotationPrepared = await jpegBufferFromExtract(
      preparedBuffer,
      annotationBox,
      ANNOTATION_CROP_MAX_DIMENSION,
    );
    const contextPrepared = await jpegBufferFromExtract(
      preparedBuffer,
      contextBox,
      CONTEXT_CROP_MAX_DIMENSION,
    );

    const annotationArtifact = await makePreparedArtifact(
      config,
      annotationKey,
      annotationPrepared.buffer,
      annotationPrepared.width,
      annotationPrepared.height,
    );
    const contextArtifact = await makePreparedArtifact(
      config,
      contextKey,
      contextPrepared.buffer,
      contextPrepared.width,
      contextPrepared.height,
    );

    const ocr =
      config.ocrEnabled
        ? await runTesseractOcr(annotationPrepared.buffer, {
            timeoutMs: config.ocrTimeoutMs,
            lang: config.ocrLang,
          })
        : null;

    const priorityScore = computeRegionPriority({
      region_type: region.region_type,
      coverage_ratio: region.coverage_ratio,
      red_pixel_ratio: region.red_pixel_ratio,
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
      ocr,
    });

    annotationRegions.push({
      id: region.id,
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
      review_order: region.id,
      region_type: region.region_type,
      region_type_confidence: region.region_type_confidence,
      priority_score: priorityScore,
      include_by_default: priorityScore >= 0.62,
      red_pixel_ratio: region.red_pixel_ratio,
      red_pixel_count: region.red_pixel_count,
      coverage_ratio: region.coverage_ratio,
      annotation_crop: annotationArtifact,
      context_crop: contextArtifact,
      ocr,
    });
  }

  const artifactProfiles = buildArtifactProfiles(
    fullFrameArtifact,
    annotationRegions,
    taskIntent.recommendedArtifactProfile,
    taskIntent.fastMaxRegions,
    taskIntent.openaiHighDetailMaxRegions,
  );

  const manifestPayload = {
    schema_version: "vision-mcp.v3.manifest",
    source_url: url,
    prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
    input_metadata: normalizedMetadata,
    task_intent: taskIntent.name,
    task_intent_guidance: taskIntent.guidance,
    prepared_full_frame: fullFrameArtifact,
    annotation_regions: annotationRegions,
    recommended_profile: artifactProfiles.recommendedProfile,
    artifact_profiles: artifactProfiles.profiles,
    detection_summary: {
      red_regions_detected: annotationRegions.length,
      task_intent_applied: taskIntent.name,
      crop_pipeline_version: CROP_PIPELINE_VERSION,
      optimization_pipeline_version: OPTIMIZATION_PIPELINE_VERSION,
    },
    context,
  };
  const manifestKey = buildArtifactKey(
    url,
    `manifest-${sha256Hex(JSON.stringify({ metadata: normalizedMetadata || null, taskIntent: taskIntent.name }))}`,
    effectiveMeta,
  );
  artifactKeys.push(manifestKey);
  const manifestArtifact = await persistArtifactJson(config, manifestKey, manifestPayload);

  const compact = buildCompactResult(
    url,
    fullFrameArtifact,
    manifestArtifact.url,
    annotationRegions,
    normalizedMetadata,
    taskIntent.name,
    taskIntent.guidance,
    taskIntent.recommendedArtifactProfile,
    taskIntent.fastMaxRegions,
    taskIntent.openaiHighDetailMaxRegions,
  );
  const result: AnalyzeUrlResult = {
    compact,
    verbose: {
      cache_hit: false,
      analysis_cache_key: analysisKey,
      image_cache_key: binaryKey,
      artifact_keys: artifactKeys,
      etag: effectiveMeta.etag,
      last_modified: effectiveMeta.lastModified,
      content_type: effectiveMeta.contentType,
      content_length: effectiveMeta.contentLength,
      original_size_bytes: downloaded.length,
      optimized_size_bytes: preparedBuffer.length,
      original_dimensions: { width: originalWidth, height: originalHeight },
      prepared_dimensions: { width: preparedWidth, height: preparedHeight },
      prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
    },
  };

  await setJsonCache(config.cacheDir, analysisKey, result);
  return result;
}

export async function analyzeScreenshotDiff(
  rawBeforeUrl: string,
  rawAfterUrl: string,
  context: string,
  config: VisionRuntimeConfig,
  metadataInput?: unknown,
  ignoreRegionsInput?: unknown,
  ignorePresetsInput?: unknown,
  reviewProfileInput?: unknown,
): Promise<AnalyzeDiffResult> {
  const beforeUrl = assertAllowedImageUrl(
    rawBeforeUrl,
    config.allowedHosts,
    config.allowAnyImageUrl,
  ).toString();
  const afterUrl = assertAllowedImageUrl(
    rawAfterUrl,
    config.allowedHosts,
    config.allowAnyImageUrl,
  ).toString();
  const normalizedMetadata = normalizeMetadata(metadataInput);
  const reviewProfile = resolveDiffReviewProfile(reviewProfileInput);
  const { presetNames: ignorePresetNames, regions: presetRegions } = expandIgnorePresets(
    [...reviewProfile.ignorePresets, ...(Array.isArray(ignorePresetsInput) ? ignorePresetsInput : [])],
  );
  const ignoreRegions = [
    ...presetRegions,
    ...normalizeIgnoreRegions(ignoreRegionsInput),
  ];

  await ensureCacheDir(config.cacheDir);

  const beforeHeadMeta = await headImage(beforeUrl);
  const afterHeadMeta = await headImage(afterUrl);
  const beforeBinaryKey = imageCacheKey(beforeUrl, beforeHeadMeta);
  const afterBinaryKey = imageCacheKey(afterUrl, afterHeadMeta);
  const analysisKey = diffPrepCacheKey(
    beforeUrl,
    afterUrl,
    beforeHeadMeta,
    afterHeadMeta,
    context,
    normalizedMetadata,
    ignoreRegions,
    ignorePresetNames,
    reviewProfile.name,
  );
  const ignoreHash = ignoreRegions.length
    ? sha256Hex(JSON.stringify(ignoreRegions)).slice(0, 12)
    : "no-ignore";

  const cached = await getJsonCache<AnalyzeDiffResult>(config.cacheDir, analysisKey, config.cacheTtlMs);
  if (cached) {
    return {
      compact: cached.compact,
      verbose: {
        ...cached.verbose,
        cache_hit: true,
      },
    };
  }

  let beforeDownloaded = await getBinaryCache(config.cacheDir, beforeBinaryKey, config.cacheTtlMs);
  let afterDownloaded = await getBinaryCache(config.cacheDir, afterBinaryKey, config.cacheTtlMs);
  let effectiveBeforeMeta = beforeHeadMeta;
  let effectiveAfterMeta = afterHeadMeta;

  if (!beforeDownloaded) {
    const fetched = await downloadImage(beforeUrl, config.maxImageSizeBytes);
    beforeDownloaded = fetched.buffer;
    effectiveBeforeMeta = fetched;
    await setBinaryCache(config.cacheDir, beforeBinaryKey, beforeDownloaded);
  }

  if (!afterDownloaded) {
    const fetched = await downloadImage(afterUrl, config.maxImageSizeBytes);
    afterDownloaded = fetched.buffer;
    effectiveAfterMeta = fetched;
    await setBinaryCache(config.cacheDir, afterBinaryKey, afterDownloaded);
  }

  const beforeOriginalMetadata = await sharp(beforeDownloaded).metadata();
  const afterOriginalMetadata = await sharp(afterDownloaded).metadata();

  const beforeOptimization = await optimizeForVLM(beforeDownloaded, {
    maxWidth: FULL_FRAME_MAX_DIMENSION,
    maxHeight: FULL_FRAME_MAX_DIMENSION,
    quality: 82,
    format: "jpeg",
  });
  const afterOptimization = await optimizeForVLM(afterDownloaded, {
    maxWidth: FULL_FRAME_MAX_DIMENSION,
    maxHeight: FULL_FRAME_MAX_DIMENSION,
    quality: 82,
    format: "jpeg",
  });

  const compareWidth = Math.max(
    1,
    Math.min(beforeOptimization.finalDimensions.width, afterOptimization.finalDimensions.width),
  );
  const compareHeight = Math.max(
    1,
    Math.min(beforeOptimization.finalDimensions.height, afterOptimization.finalDimensions.height),
  );

  const beforeAlignedBuffer =
    beforeOptimization.finalDimensions.width === compareWidth &&
    beforeOptimization.finalDimensions.height === compareHeight
      ? beforeOptimization.buffer
      : await resizeJpegToDimensions(beforeOptimization.buffer, compareWidth, compareHeight);
  const afterAlignedBuffer =
    afterOptimization.finalDimensions.width === compareWidth &&
    afterOptimization.finalDimensions.height === compareHeight
      ? afterOptimization.buffer
      : await resizeJpegToDimensions(afterOptimization.buffer, compareWidth, compareHeight);

  const beforeFullKey = buildCombinedArtifactKey(
    beforeUrl,
    afterUrl,
    `before-full-frame-${ignoreHash}`,
    effectiveBeforeMeta,
    effectiveAfterMeta,
  );
  const afterFullKey = buildCombinedArtifactKey(
    beforeUrl,
    afterUrl,
    `after-full-frame-${ignoreHash}`,
    effectiveBeforeMeta,
    effectiveAfterMeta,
  );
  const artifactKeys: string[] = [beforeFullKey, afterFullKey];

  const beforeFullArtifact = await makePreparedArtifact(
    config,
    beforeFullKey,
    beforeAlignedBuffer,
    compareWidth,
    compareHeight,
  );
  const afterFullArtifact = await makePreparedArtifact(
    config,
    afterFullKey,
    afterAlignedBuffer,
    compareWidth,
    compareHeight,
  );

  const beforeRaw = await sharp(beforeAlignedBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const afterRaw = await sharp(afterAlignedBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sharedChannels = Math.min(beforeRaw.info.channels, afterRaw.info.channels);
  const ignoredOnBefore = applyIgnoreRegionsToRaw(
    beforeRaw.data,
    beforeRaw.info.width,
    beforeRaw.info.height,
    sharedChannels,
    ignoreRegions,
    "before",
  );
  const ignoredOnAfter = applyIgnoreRegionsToRaw(
    afterRaw.data,
    afterRaw.info.width,
    afterRaw.info.height,
    sharedChannels,
    ignoreRegions,
    "after",
  );
  const ignoredRegionsApplied = Math.max(ignoredOnBefore, ignoredOnAfter);

  const changedDetected = await detectChangedRegions(
    beforeRaw.data,
    afterRaw.data,
    beforeRaw.info.width,
    beforeRaw.info.height,
    sharedChannels,
  );

  const changedRegions: PreparedChangedRegion[] = [];

  for (const region of changedDetected) {
    const cropBox = expandBox(region, compareWidth, compareHeight, {
      paddingX: 24,
      paddingY: 24,
      minWidth: 220,
      minHeight: 160,
    });
    const contextBox = expandBox(region, compareWidth, compareHeight, {
      paddingX: Math.max(96, Math.round(region.width * 1.15)),
      paddingY: Math.max(72, Math.round(region.height * 1.15)),
      minWidth: 420,
      minHeight: 280,
    });

    const beforeCropKey = buildCombinedArtifactKey(
      beforeUrl,
      afterUrl,
      `before-crop-${region.id}-${ignoreHash}`,
      effectiveBeforeMeta,
      effectiveAfterMeta,
    );
    const afterCropKey = buildCombinedArtifactKey(
      beforeUrl,
      afterUrl,
      `after-crop-${region.id}-${ignoreHash}`,
      effectiveBeforeMeta,
      effectiveAfterMeta,
    );
    const beforeContextKey = buildCombinedArtifactKey(
      beforeUrl,
      afterUrl,
      `before-context-${region.id}-${ignoreHash}`,
      effectiveBeforeMeta,
      effectiveAfterMeta,
    );
    const afterContextKey = buildCombinedArtifactKey(
      beforeUrl,
      afterUrl,
      `after-context-${region.id}-${ignoreHash}`,
      effectiveBeforeMeta,
      effectiveAfterMeta,
    );

    artifactKeys.push(beforeCropKey, afterCropKey, beforeContextKey, afterContextKey);

    const beforeCropPrepared = await jpegBufferFromExtract(
      beforeAlignedBuffer,
      cropBox,
      DIFF_CROP_MAX_DIMENSION,
    );
    const afterCropPrepared = await jpegBufferFromExtract(
      afterAlignedBuffer,
      cropBox,
      DIFF_CROP_MAX_DIMENSION,
    );
    const beforeContextPrepared = await jpegBufferFromExtract(
      beforeAlignedBuffer,
      contextBox,
      DIFF_CONTEXT_CROP_MAX_DIMENSION,
    );
    const afterContextPrepared = await jpegBufferFromExtract(
      afterAlignedBuffer,
      contextBox,
      DIFF_CONTEXT_CROP_MAX_DIMENSION,
    );

    const beforeCropArtifact = await makePreparedArtifact(
      config,
      beforeCropKey,
      beforeCropPrepared.buffer,
      beforeCropPrepared.width,
      beforeCropPrepared.height,
    );
    const afterCropArtifact = await makePreparedArtifact(
      config,
      afterCropKey,
      afterCropPrepared.buffer,
      afterCropPrepared.width,
      afterCropPrepared.height,
    );
    const beforeContextArtifact = await makePreparedArtifact(
      config,
      beforeContextKey,
      beforeContextPrepared.buffer,
      beforeContextPrepared.width,
      beforeContextPrepared.height,
    );
    const afterContextArtifact = await makePreparedArtifact(
      config,
      afterContextKey,
      afterContextPrepared.buffer,
      afterContextPrepared.width,
      afterContextPrepared.height,
    );

    const priorityScore = computeChangedRegionPriority({
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
      coverage_ratio: region.coverage_ratio,
      changed_pixel_ratio: region.changed_pixel_ratio,
      mean_abs_diff: region.mean_abs_diff,
    });

    changedRegions.push({
      id: region.id,
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
      review_order: region.id,
      priority_score: priorityScore,
      include_by_default: priorityScore >= 0.58,
      changed_pixel_count: region.changed_pixel_count,
      changed_pixel_ratio: region.changed_pixel_ratio,
      coverage_ratio: region.coverage_ratio,
      mean_abs_diff: region.mean_abs_diff,
      before_crop: beforeCropArtifact,
      after_crop: afterCropArtifact,
      before_context_crop: beforeContextArtifact,
      after_context_crop: afterContextArtifact,
    });
  }

  const artifactProfiles = buildDiffArtifactProfiles(
    beforeFullArtifact,
    afterFullArtifact,
    changedRegions,
  );
  const manifestPayload = {
    schema_version: "vision-mcp.v3.diff.manifest",
    source_urls: {
      before: beforeUrl,
      after: afterUrl,
    },
    prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
    input_metadata: normalizedMetadata,
    ignore_regions: ignoreRegions,
    ignore_presets: ignorePresetNames,
    review_profile: reviewProfile.name,
    review_profile_guidance: reviewProfile.guidance,
    aligned_full_frames: {
      before: beforeFullArtifact,
      after: afterFullArtifact,
    },
    changed_regions: changedRegions,
    recommended_profile: artifactProfiles.recommendedProfile,
    artifact_profiles: artifactProfiles.profiles,
    detection_summary: {
      changed_regions_detected: changedRegions.length,
      compare_dimensions: {
        width: compareWidth,
        height: compareHeight,
      },
      ignored_regions_applied: ignoredRegionsApplied,
      ignore_presets_applied: ignorePresetNames,
      review_profile_applied: reviewProfile.name,
      diff_pipeline_version: `${CROP_PIPELINE_VERSION}.diff-v1`,
      optimization_pipeline_version: OPTIMIZATION_PIPELINE_VERSION,
    },
    context,
  };
  const manifestKey = buildCombinedArtifactKey(
    beforeUrl,
    afterUrl,
    `diff-manifest-${sha256Hex(JSON.stringify({ metadata: normalizedMetadata || null, ignoreRegions, ignorePresetNames, reviewProfile: reviewProfile.name }))}`,
    effectiveBeforeMeta,
    effectiveAfterMeta,
  );
  artifactKeys.push(manifestKey);
  const manifestArtifact = await persistArtifactJson(config, manifestKey, manifestPayload);

  const compact = buildCompactDiffResult(
    beforeUrl,
    afterUrl,
    beforeFullArtifact,
    afterFullArtifact,
    manifestArtifact.url,
    changedRegions,
    compareWidth,
    compareHeight,
    normalizedMetadata,
    ignoredRegionsApplied,
    ignorePresetNames,
    reviewProfile.name,
    reviewProfile.guidance,
    reviewProfile.recommendedArtifactProfile,
  );
  const result: AnalyzeDiffResult = {
    compact,
    verbose: {
      cache_hit: false,
      analysis_cache_key: analysisKey,
      image_cache_key: `${beforeBinaryKey}:${afterBinaryKey}`,
      artifact_keys: artifactKeys,
      etag: [effectiveBeforeMeta.etag, effectiveAfterMeta.etag].filter(Boolean).join(" | ") || null,
      last_modified:
        [effectiveBeforeMeta.lastModified, effectiveAfterMeta.lastModified].filter(Boolean).join(" | ") ||
        null,
      content_type:
        [effectiveBeforeMeta.contentType, effectiveAfterMeta.contentType].filter(Boolean).join(" | ") ||
        null,
      content_length:
        (effectiveBeforeMeta.contentLength ?? beforeDownloaded.length) +
        (effectiveAfterMeta.contentLength ?? afterDownloaded.length),
      original_size_bytes: beforeDownloaded.length + afterDownloaded.length,
      optimized_size_bytes: beforeAlignedBuffer.length + afterAlignedBuffer.length,
      original_dimensions: {
        width: beforeOriginalMetadata.width || 0,
        height: beforeOriginalMetadata.height || 0,
      },
      prepared_dimensions: {
        width: compareWidth,
        height: compareHeight,
      },
      prompt_version: SCREENSHOT_ANALYSIS_PROMPT_VERSION,
    },
  };

  await setJsonCache(config.cacheDir, analysisKey, result);
  return result;
}
