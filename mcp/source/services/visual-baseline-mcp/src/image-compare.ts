import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { writeArtifact } from "./artifact-store.js";
import { VISUAL_BASELINE_SCHEMA_VERSION, VISUAL_BASELINE_PIPELINE_VERSION, VisualBaselineConfig } from "./config.js";
import { estimateTokens, round, safeName, stableHash } from "./text-utils.js";

export interface BaselineInput {
  baseline_name: string;
  image_path: string;
  metadata?: unknown;
}

export interface CompareInput {
  baseline_name: string;
  diff_threshold?: number;
  ignore_regions?: VisualRegion[];
  image_path: string;
  mask_preset_names?: string[];
  mask_preset_query?: MaskPresetScope;
  max_changed_pct?: number;
  metadata?: unknown;
}

export interface ApprovalInput {
  baseline_name: string;
  metadata?: unknown;
  reason?: string;
  reviewer?: string;
}

export interface MaskPresetInput {
  component?: string;
  metadata?: unknown;
  preset_name: string;
  regions?: VisualRegion[];
  route?: string;
  tags?: string[];
  viewport?: string;
}

interface VisualRegion {
  height: number;
  label?: string;
  width: number;
  x: number;
  y: number;
}

interface BaselineManifest {
  baseline_id: string;
  created_at: string;
  file: string;
  height: number;
  image_hash: string;
  name: string;
  schema_version: string;
  width: number;
}

interface BaselineApprovalManifest {
  approval_id: string;
  approved_at: string;
  baseline_id: string;
  height: number;
  image_hash: string;
  name: string;
  reason_hash?: string;
  reviewer_hash?: string;
  schema_version: string;
  width: number;
}

interface ApprovalStatus {
  approval_id?: string;
  approval_status: "approved" | "stale" | "unapproved";
  approved_at?: string;
  approved_baseline_id?: string;
}

interface MaskPresetManifest {
  created_at: string;
  name: string;
  preset_id: string;
  region_count: number;
  regions: VisualRegion[];
  schema_version: string;
  scope?: MaskPresetScope;
}

interface MaskPresetScope {
  component?: string;
  route?: string;
  tags?: string[];
  viewport?: string;
}

function baselineManifestPath(config: VisualBaselineConfig, baselineName: string): string {
  return path.join(config.baselineDir, `${safeName(baselineName)}.json`);
}

function baselineImagePath(config: VisualBaselineConfig, fileName: string): string {
  return path.join(config.baselineDir, path.basename(fileName));
}

function approvalManifestPath(config: VisualBaselineConfig, baselineName: string): string {
  return path.join(config.baselineDir, "approvals", `${safeName(baselineName)}.approval.json`);
}

function maskPresetManifestPath(config: VisualBaselineConfig, presetName: string): string {
  return path.join(config.baselineDir, "mask-presets", `${safeName(presetName)}.mask-preset.json`);
}

async function imagePngBuffer(filePath: string, maxImagePixels: number): Promise<{ buffer: Buffer; height: number; width: number }> {
  const image = sharp(filePath, { limitInputPixels: maxImagePixels }).ensureAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to read image dimensions");
  }
  if (metadata.width * metadata.height > maxImagePixels) {
    throw new Error(`Image is too large: ${metadata.width}x${metadata.height}`);
  }
  const buffer = await image.png().toBuffer();
  return { buffer, height: metadata.height, width: metadata.width };
}

async function rawRgba(filePath: string, maxImagePixels: number) {
  const image = sharp(filePath, { limitInputPixels: maxImagePixels }).ensureAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to read image dimensions");
  }
  if (metadata.width * metadata.height > maxImagePixels) {
    throw new Error(`Image is too large: ${metadata.width}x${metadata.height}`);
  }
  const data = await image.raw().toBuffer();
  return { data, height: metadata.height, width: metadata.width };
}

async function readManifest(config: VisualBaselineConfig, baselineName: string): Promise<BaselineManifest | null> {
  try {
    return JSON.parse(await fs.readFile(baselineManifestPath(config, baselineName), "utf8")) as BaselineManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readApprovalManifest(
  config: VisualBaselineConfig,
  baselineName: string,
): Promise<BaselineApprovalManifest | null> {
  try {
    return JSON.parse(await fs.readFile(approvalManifestPath(config, baselineName), "utf8")) as BaselineApprovalManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readMaskPresetManifest(
  config: VisualBaselineConfig,
  presetName: string,
): Promise<MaskPresetManifest | null> {
  try {
    return JSON.parse(await fs.readFile(maskPresetManifestPath(config, presetName), "utf8")) as MaskPresetManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readMaskPresetManifests(config: VisualBaselineConfig): Promise<MaskPresetManifest[]> {
  const dir = path.join(config.baselineDir, "mask-presets");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mask-preset.json"))
        .map(async (entry) => {
          try {
            return JSON.parse(await fs.readFile(path.join(dir, entry.name), "utf8")) as MaskPresetManifest;
          } catch {
            return null;
          }
        }),
    );
    return manifests.filter((manifest): manifest is MaskPresetManifest => Boolean(manifest));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function approvalStatus(config: VisualBaselineConfig, manifest: BaselineManifest): Promise<ApprovalStatus> {
  const approval = await readApprovalManifest(config, manifest.name);
  if (!approval) {
    return { approval_status: "unapproved" };
  }
  if (approval.baseline_id !== manifest.baseline_id || approval.image_hash !== manifest.image_hash) {
    return {
      approval_id: approval.approval_id,
      approval_status: "stale",
      approved_at: approval.approved_at,
      approved_baseline_id: approval.baseline_id,
    };
  }
  return {
    approval_id: approval.approval_id,
    approval_status: "approved",
    approved_at: approval.approved_at,
    approved_baseline_id: approval.baseline_id,
  };
}

function compactMarkdown(payload: {
  approval_status?: string;
  baseline_name: string;
  changed_pct?: number;
  height?: number;
  ignored_changed_pixels?: number;
  mask_preset_regions_count?: number;
  mask_presets_applied?: number;
  status: string;
  total_pixels?: number;
  width?: number;
}) {
  const lines = [
    "# Visual baseline summary",
    "",
    `Baseline: ${safeName(payload.baseline_name)}`,
    `Status: ${payload.status}`,
  ];
  if (payload.approval_status) {
    lines.push(`Approval: ${payload.approval_status}`);
  }
  if (payload.width && payload.height) {
    lines.push(`Dimensions: ${payload.width}x${payload.height}`);
  }
  if (payload.changed_pct !== undefined) {
    lines.push(`Changed pixels: ${payload.changed_pct}%`);
  }
  if (payload.ignored_changed_pixels !== undefined && payload.ignored_changed_pixels > 0) {
    lines.push(`Ignored changed pixels: ${payload.ignored_changed_pixels}`);
  }
  if (payload.mask_presets_applied !== undefined && payload.mask_presets_applied > 0) {
    lines.push(`Mask presets applied: ${payload.mask_presets_applied}`);
  }
  if (payload.mask_preset_regions_count !== undefined && payload.mask_preset_regions_count > 0) {
    lines.push(`Mask preset regions: ${payload.mask_preset_regions_count}`);
  }
  return `${lines.join("\n")}\n`;
}

function compactMaskPresetMarkdown(payload: {
  scope_fields_count?: number;
  preset_name: string;
  region_count: number;
  status: string;
}) {
  return [
    "# Visual baseline mask preset",
    "",
    `Preset: ${safeName(payload.preset_name)}`,
    `Status: ${payload.status}`,
    `Regions: ${payload.region_count}`,
    `Scope fields: ${payload.scope_fields_count || 0}`,
    "",
  ].join("\n");
}

function sanitizeScopeValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function sanitizeScopeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags
    .filter((tag) => typeof tag === "string" && tag.trim())
    .map((tag) => tag.trim().slice(0, 80))
    .slice(0, 20);
}

function sanitizeScope(input: MaskPresetScope | undefined): MaskPresetScope | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const tags = sanitizeScopeTags(input.tags);
  const scope: MaskPresetScope = {
    component: sanitizeScopeValue(input.component),
    route: sanitizeScopeValue(input.route),
    tags: tags.length ? tags : undefined,
    viewport: sanitizeScopeValue(input.viewport),
  };
  return Object.values(scope).some(Boolean) ? scope : undefined;
}

function scopeFieldCount(scope: MaskPresetScope | undefined): number {
  if (!scope) {
    return 0;
  }
  return [
    scope.component,
    scope.route,
    scope.viewport,
    scope.tags && scope.tags.length > 0 ? "tags" : undefined,
  ].filter(Boolean).length;
}

function sameScopeValue(left: string | undefined, right: string | undefined): boolean {
  if (!left) {
    return true;
  }
  return right !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function scopeMatches(query: MaskPresetScope | undefined, scope: MaskPresetScope | undefined): boolean {
  if (!query || scopeFieldCount(query) === 0) {
    return false;
  }
  if (!sameScopeValue(query.route, scope?.route)) {
    return false;
  }
  if (!sameScopeValue(query.component, scope?.component)) {
    return false;
  }
  if (!sameScopeValue(query.viewport, scope?.viewport)) {
    return false;
  }
  const queryTags = query.tags || [];
  if (queryTags.length === 0) {
    return true;
  }
  const scopeTags = new Set((scope?.tags || []).map((tag) => tag.toLowerCase()));
  return queryTags.every((tag) => scopeTags.has(tag.toLowerCase()));
}

function sanitizePresetRegions(regions: VisualRegion[] | undefined): VisualRegion[] {
  if (!Array.isArray(regions)) {
    return [];
  }
  return regions.flatMap((region) => {
    const x = Math.max(0, Math.floor(Number(region?.x) || 0));
    const y = Math.max(0, Math.floor(Number(region?.y) || 0));
    const width = Math.max(0, Math.floor(Number(region?.width) || 0));
    const height = Math.max(0, Math.floor(Number(region?.height) || 0));
    if (width <= 0 || height <= 0) {
      return [];
    }
    return [{
      height,
      label: typeof region?.label === "string" ? region.label.slice(0, 80) : undefined,
      width,
      x,
      y,
    }];
  });
}

function normalizeRegions(regions: VisualRegion[] | undefined, width: number, height: number): VisualRegion[] {
  if (!Array.isArray(regions)) {
    return [];
  }
  return regions.flatMap((region) => {
    const x = Math.max(0, Math.floor(Number(region?.x) || 0));
    const y = Math.max(0, Math.floor(Number(region?.y) || 0));
    const regionWidth = Math.max(0, Math.floor(Number(region?.width) || 0));
    const regionHeight = Math.max(0, Math.floor(Number(region?.height) || 0));
    const right = Math.min(width, x + regionWidth);
    const bottom = Math.min(height, y + regionHeight);
    if (right <= x || bottom <= y) {
      return [];
    }
    return [{
      height: bottom - y,
      label: typeof region?.label === "string" ? region.label.slice(0, 80) : undefined,
      width: right - x,
      x,
      y,
    }];
  });
}

function inRegion(x: number, y: number, regions: VisualRegion[]): boolean {
  return regions.some(
    (region) =>
      x >= region.x &&
      x < region.x + region.width &&
      y >= region.y &&
      y < region.y + region.height,
  );
}

function withStats(sourceBytes: number, compact: string) {
  const rawTokens = Math.ceil(sourceBytes / 4);
  const compactTokens = estimateTokens(compact);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

async function presetRegions(
  config: VisualBaselineConfig,
  presetNames: string[] | undefined,
  presetQuery: MaskPresetScope | undefined,
) {
  const names = Array.isArray(presetNames) ? presetNames.filter((name) => typeof name === "string" && name.trim()) : [];
  const manifests = new Map<string, MaskPresetManifest>();
  for (const name of names) {
    const manifest = await readMaskPresetManifest(config, name);
    if (!manifest) {
      throw new Error(`mask preset not found: ${safeName(name)}`);
    }
    manifests.set(manifest.name, manifest);
  }
  const query = sanitizeScope(presetQuery);
  if (query) {
    const matches = (await readMaskPresetManifests(config)).filter((manifest) => scopeMatches(query, manifest.scope));
    for (const manifest of matches) {
      manifests.set(manifest.name, manifest);
    }
  }
  const regions = Array.from(manifests.values()).flatMap((manifest) => sanitizePresetRegions(manifest.regions));
  return {
    applied: manifests.size,
    query_matched: query ? Math.max(0, manifests.size - names.length) : 0,
    query_used: Boolean(query),
    regions,
  };
}

export async function createBaseline(config: VisualBaselineConfig, input: BaselineInput) {
  if (!input.baseline_name?.trim()) {
    throw new Error("baseline_name is required");
  }
  if (!input.image_path?.trim()) {
    throw new Error("image_path is required");
  }

  await fs.mkdir(config.baselineDir, { recursive: true });
  const normalized = await imagePngBuffer(input.image_path, config.maxImagePixels);
  const hash = stableHash(normalized.buffer);
  const name = safeName(input.baseline_name);
  const fileName = `${name}-${hash}.png`;
  await fs.writeFile(baselineImagePath(config, fileName), normalized.buffer);

  const manifest: BaselineManifest = {
    baseline_id: `${name}-${hash}`,
    created_at: new Date().toISOString(),
    file: fileName,
    height: normalized.height,
    image_hash: hash,
    name,
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    width: normalized.width,
  };
  await fs.writeFile(baselineManifestPath(config, name), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const approval = await approvalStatus(config, manifest);

  const compact = compactMarkdown({
    approval_status: approval.approval_status,
    baseline_name: name,
    height: normalized.height,
    status: "baseline_created",
    width: normalized.width,
  });
  const artifact = await writeArtifact(config, `baseline-${manifest.baseline_id}.summary.md`, compact);
  return {
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    pipeline_version: VISUAL_BASELINE_PIPELINE_VERSION,
    tool_kind: "baseline",
    status: "baseline_created",
    baseline_id: manifest.baseline_id,
    baseline_name: name,
    approval,
    approval_status: approval.approval_status,
    dimensions: { width: normalized.width, height: normalized.height },
    image_hash: hash,
    compact_markdown: compact,
    input_stats: withStats(normalized.buffer.length, compact),
    artifacts: {
      compact_file: artifact.file,
      compact_url: artifact.url,
    },
  };
}

export async function saveMaskPreset(config: VisualBaselineConfig, input: MaskPresetInput) {
  if (!input.preset_name?.trim()) {
    throw new Error("preset_name is required");
  }
  const name = safeName(input.preset_name);
  const regions = sanitizePresetRegions(input.regions);
  const scope = sanitizeScope({
    component: input.component,
    route: input.route,
    tags: input.tags,
    viewport: input.viewport,
  });
  if (regions.length === 0) {
    throw new Error("at least one non-empty region is required");
  }

  const manifest: MaskPresetManifest = {
    created_at: new Date().toISOString(),
    name,
    preset_id: `${name}-${stableHash(JSON.stringify(regions))}`,
    region_count: regions.length,
    regions,
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    scope,
  };
  await fs.mkdir(path.dirname(maskPresetManifestPath(config, name)), { recursive: true });
  await fs.writeFile(maskPresetManifestPath(config, name), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const compact = compactMaskPresetMarkdown({
    preset_name: name,
    region_count: regions.length,
    scope_fields_count: scopeFieldCount(scope),
    status: "mask_preset_saved",
  });
  const artifact = await writeArtifact(config, `mask-preset-${manifest.preset_id}.summary.md`, compact);

  return {
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    pipeline_version: VISUAL_BASELINE_PIPELINE_VERSION,
    tool_kind: "mask_preset",
    status: "mask_preset_saved",
    preset_id: manifest.preset_id,
    preset_name: name,
    region_count: regions.length,
    scope_fields_count: scopeFieldCount(scope),
    tags_count: scope?.tags?.length || 0,
    compact_markdown: compact,
    input_stats: withStats(JSON.stringify(manifest).length, compact),
    artifacts: {
      compact_file: artifact.file,
      compact_url: artifact.url,
    },
  };
}

export async function approveBaseline(config: VisualBaselineConfig, input: ApprovalInput) {
  if (!input.baseline_name?.trim()) {
    throw new Error("baseline_name is required");
  }
  const manifest = await readManifest(config, input.baseline_name);
  if (!manifest) {
    throw new Error("baseline not found");
  }

  const approvedAt = new Date().toISOString();
  const reviewer = input.reviewer?.trim();
  const reason = input.reason?.trim();
  const approval: BaselineApprovalManifest = {
    approval_id: `${manifest.baseline_id}-${stableHash(`${approvedAt}:${manifest.image_hash}:${reviewer || ""}:${reason || ""}`)}`,
    approved_at: approvedAt,
    baseline_id: manifest.baseline_id,
    height: manifest.height,
    image_hash: manifest.image_hash,
    name: manifest.name,
    reason_hash: reason ? stableHash(reason) : undefined,
    reviewer_hash: reviewer ? stableHash(reviewer) : undefined,
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    width: manifest.width,
  };

  await fs.mkdir(path.dirname(approvalManifestPath(config, manifest.name)), { recursive: true });
  await fs.writeFile(approvalManifestPath(config, manifest.name), `${JSON.stringify(approval, null, 2)}\n`, "utf8");

  const compact = compactMarkdown({
    approval_status: "approved",
    baseline_name: manifest.name,
    height: manifest.height,
    status: "approved",
    width: manifest.width,
  });
  const artifact = await writeArtifact(config, `approval-${approval.approval_id}.summary.md`, compact);

  return {
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    pipeline_version: VISUAL_BASELINE_PIPELINE_VERSION,
    tool_kind: "approval",
    status: "approved",
    baseline_id: manifest.baseline_id,
    baseline_name: manifest.name,
    approval_id: approval.approval_id,
    approval_status: "approved",
    approved_at: approval.approved_at,
    dimensions: { width: manifest.width, height: manifest.height },
    compact_markdown: compact,
    input_stats: withStats(JSON.stringify(approval).length, compact),
    artifacts: {
      compact_file: artifact.file,
      compact_url: artifact.url,
    },
  };
}

export async function compareScreenshot(config: VisualBaselineConfig, input: CompareInput) {
  if (!input.baseline_name?.trim()) {
    throw new Error("baseline_name is required");
  }
  if (!input.image_path?.trim()) {
    throw new Error("image_path is required");
  }
  const manifest = await readManifest(config, input.baseline_name);
  if (!manifest) {
    throw new Error("baseline not found");
  }

  const baselinePath = baselineImagePath(config, manifest.file);
  const baseline = await rawRgba(baselinePath, config.maxImagePixels);
  const candidate = await rawRgba(input.image_path, config.maxImagePixels);
  const approval = await approvalStatus(config, manifest);
  const maxChangedPct = input.max_changed_pct ?? 0.1;
  const threshold = input.diff_threshold ?? 16;

  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    const compact = compactMarkdown({
      approval_status: approval.approval_status,
      baseline_name: manifest.name,
      status: "changed_dimension_mismatch",
    });
    return {
      schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
      pipeline_version: VISUAL_BASELINE_PIPELINE_VERSION,
      tool_kind: "compare",
      status: "changed",
      baseline_id: manifest.baseline_id,
      approval,
      approval_status: approval.approval_status,
      dimension_mismatch: true,
      baseline_dimensions: { width: baseline.width, height: baseline.height },
      candidate_dimensions: { width: candidate.width, height: candidate.height },
      compact_markdown: compact,
      input_stats: withStats(baseline.data.length + candidate.data.length, compact),
    };
  }

  const totalPixels = baseline.width * baseline.height;
  const fromPresets = await presetRegions(config, input.mask_preset_names, input.mask_preset_query);
  const maskPresetRegionsCount = fromPresets.regions.length;
  const ignoreRegions = normalizeRegions(
    [...fromPresets.regions, ...(input.ignore_regions || [])],
    candidate.width,
    candidate.height,
  );
  const overlay = Buffer.alloc(totalPixels * 4);
  let changedPixels = 0;
  let ignoredChangedPixels = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * 4;
    const dr = Math.abs(baseline.data[offset] - candidate.data[offset]);
    const dg = Math.abs(baseline.data[offset + 1] - candidate.data[offset + 1]);
    const db = Math.abs(baseline.data[offset + 2] - candidate.data[offset + 2]);
    const da = Math.abs(baseline.data[offset + 3] - candidate.data[offset + 3]);
    if (Math.max(dr, dg, db, da) > threshold) {
      const x = i % candidate.width;
      const y = Math.floor(i / candidate.width);
      if (inRegion(x, y, ignoreRegions)) {
        ignoredChangedPixels += 1;
        continue;
      }
      changedPixels += 1;
      overlay[offset] = 255;
      overlay[offset + 1] = 0;
      overlay[offset + 2] = 0;
      overlay[offset + 3] = 180;
    }
  }

  const changedPct = round((changedPixels / totalPixels) * 100, 3);
  const status = changedPct <= maxChangedPct ? "passed" : "changed";
  const candidatePng = await sharp(candidate.data, {
    raw: { width: candidate.width, height: candidate.height, channels: 4 },
  }).png().toBuffer();
  const diffPng = await sharp(candidatePng)
    .composite([{ input: overlay, raw: { width: candidate.width, height: candidate.height, channels: 4 } }])
    .png()
    .toBuffer();
  const diffArtifact = await writeArtifact(config, `diff-${manifest.baseline_id}-${stableHash(diffPng)}.png`, diffPng);
  const compact = compactMarkdown({
    approval_status: approval.approval_status,
    baseline_name: manifest.name,
    changed_pct: changedPct,
    height: candidate.height,
    ignored_changed_pixels: ignoredChangedPixels,
    mask_preset_regions_count: maskPresetRegionsCount,
    mask_presets_applied: fromPresets.applied,
    status,
    total_pixels: totalPixels,
    width: candidate.width,
  });
  const summaryArtifact = await writeArtifact(config, `diff-${manifest.baseline_id}-${stableHash(compact)}.summary.md`, compact);

  return {
    schema_version: VISUAL_BASELINE_SCHEMA_VERSION,
    pipeline_version: VISUAL_BASELINE_PIPELINE_VERSION,
    tool_kind: "compare",
    status,
    baseline_id: manifest.baseline_id,
    baseline_name: manifest.name,
    approval,
    approval_status: approval.approval_status,
    changed_pixels: changedPixels,
    changed_pct: changedPct,
    ignored_changed_pixels: ignoredChangedPixels,
    ignore_regions_count: ignoreRegions.length,
    mask_preset_regions_count: maskPresetRegionsCount,
    mask_presets_applied: fromPresets.applied,
    mask_preset_query_matched: fromPresets.query_matched,
    mask_preset_query_used: fromPresets.query_used,
    max_changed_pct: maxChangedPct,
    threshold,
    dimensions: { width: candidate.width, height: candidate.height },
    compact_markdown: compact,
    input_stats: withStats(baseline.data.length + candidate.data.length, compact),
    artifacts: {
      diff_file: diffArtifact.file,
      diff_url: diffArtifact.url,
      compact_file: summaryArtifact.file,
      compact_url: summaryArtifact.url,
    },
  };
}
