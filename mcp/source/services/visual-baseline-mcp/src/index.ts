#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getVisualBaselineConfig } from "./config.js";
import { appendRequestLog } from "./request-log.js";
import { buildMeasurementReport } from "./measurement.js";
import { approveBaseline, compareScreenshot, createBaseline, saveMaskPreset } from "./image-compare.js";
import { clampText, stableHash } from "./text-utils.js";

const config = getVisualBaselineConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata for attribution. Recommended: source, task_id, surface, repo, branch, session_id. Do not include raw images, image URLs, screenshots, secrets, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    session_id: { type: "string" },
  },
};

const IMAGE_PROPS = {
  baseline_name: { type: "string", description: "Stable local baseline name. Stored under the local cache only." },
  image_path: { type: "string", description: "Local screenshot/image path. Raw path is not written to request logs." },
  metadata: METADATA_SCHEMA,
};

const REGION_SCHEMA = {
  type: "array",
  description: "Optional changed-pixel ignore masks for dynamic regions. Coordinates are local pixel rectangles.",
  items: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      label: { type: "string" },
    },
    required: ["x", "y", "width", "height"],
  },
};

const APPROVAL_PROPS = {
  baseline_name: { type: "string", description: "Stable local baseline name. Stored under the local cache only." },
  reviewer: {
    type: "string",
    description: "Optional local reviewer label. Request logs store only whether it was provided.",
  },
  reason: {
    type: "string",
    description: "Optional local approval rationale. Request logs store only whether it was provided.",
  },
  metadata: METADATA_SCHEMA,
};

const MASK_PRESET_PROPS = {
  preset_name: { type: "string", description: "Stable local mask preset name. Request logs store only counts." },
  route: { type: "string", description: "Optional local route/surface scope. Request logs store only field counts." },
  component: { type: "string", description: "Optional local component scope. Request logs store only field counts." },
  viewport: { type: "string", description: "Optional local viewport scope. Request logs store only field counts." },
  tags: {
    type: "array",
    description: "Optional local tags. Request logs store only tag counts.",
    items: { type: "string" },
  },
  regions: REGION_SCHEMA,
  metadata: METADATA_SCHEMA,
};

const MASK_PRESET_QUERY_SCHEMA = {
  type: "object",
  description:
    "Optional route/component/viewport/tag scope to apply matching local mask presets. Request logs store only field counts.",
  properties: {
    route: { type: "string" },
    component: { type: "string" },
    viewport: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
};

const TOOLS: Tool[] = [
  {
    name: "create_baseline",
    description: "Store a local screenshot/image as a named baseline. Raw image paths stay local.",
    inputSchema: {
      type: "object",
      properties: IMAGE_PROPS,
      required: ["baseline_name", "image_path"],
    },
  },
  {
    name: "approve_baseline",
    description:
      "Mark the current local screenshot baseline as approved by writing a local approval manifest. Raw image paths stay local.",
    inputSchema: {
      type: "object",
      properties: APPROVAL_PROPS,
      required: ["baseline_name"],
    },
  },
  {
    name: "save_mask_preset",
    description:
      "Save reusable local rectangle ignore masks for dynamic screenshot regions. Raw image paths are not involved.",
    inputSchema: {
      type: "object",
      properties: MASK_PRESET_PROPS,
      required: ["preset_name", "regions"],
    },
  },
  {
    name: "compare_screenshot",
    description:
      "Compare a local screenshot/image against a named baseline and return changed-pixel budget plus local diff artifact.",
    inputSchema: {
      type: "object",
      properties: {
        ...IMAGE_PROPS,
        diff_threshold: { type: "number", description: "Per-channel threshold. Default 16." },
        ignore_regions: REGION_SCHEMA,
        mask_preset_names: {
          type: "array",
          description: "Optional local mask preset names to apply before explicit ignore_regions.",
          items: { type: "string" },
        },
        mask_preset_query: MASK_PRESET_QUERY_SCHEMA,
        max_changed_pct: { type: "number", description: "Allowed changed pixel percent. Default 0.1." },
      },
      required: ["baseline_name", "image_path"],
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by visual-baseline-mcp.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_url_or_file: { type: "string" },
        max_chars: { type: "number", description: "Maximum returned characters. Default 20000." },
      },
      required: ["artifact_url_or_file"],
    },
  },
  {
    name: "get_measurement_report",
    description: "Return local visual-baseline usage, visual diff quality, token-savings, and Pantheon-safe aggregate export.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "UTC date YYYY-MM-DD. Defaults to today." },
        since_iso: { type: "string" },
        until_iso: { type: "string" },
        metadata: METADATA_SCHEMA,
      },
    },
  },
];

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function metadataSource(args: Record<string, unknown> | undefined): string | undefined {
  const metadata = args?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const source = (metadata as Record<string, unknown>).source;
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : undefined;
}

function summarizeInput(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }
  if (tool === "get_artifact") {
    return {
      artifact_file:
        typeof args.artifact_url_or_file === "string"
          ? artifactFileName(args.artifact_url_or_file)
          : undefined,
      max_chars: args.max_chars,
    };
  }
  if (tool === "get_measurement_report") {
    return {
      date: args.date,
      since_iso: args.since_iso,
      until_iso: args.until_iso,
      metadata_source: metadataSource(args),
    };
  }
  if (tool === "approve_baseline") {
    return {
      baseline_name_hash: typeof args.baseline_name === "string" ? stableHash(args.baseline_name) : undefined,
      reviewer_provided: typeof args.reviewer === "string" && args.reviewer.trim().length > 0,
      reason_provided: typeof args.reason === "string" && args.reason.trim().length > 0,
      metadata_source: metadataSource(args),
    };
  }
  if (tool === "save_mask_preset") {
    return {
      preset_name_provided: typeof args.preset_name === "string" && args.preset_name.trim().length > 0,
      regions_count: Array.isArray(args.regions) ? args.regions.length : 0,
      scope_fields_count: scopeFieldsCount(args),
      tags_count: Array.isArray(args.tags) ? args.tags.length : 0,
      metadata_source: metadataSource(args),
    };
  }
  return {
    baseline_name_hash: typeof args.baseline_name === "string" ? stableHash(args.baseline_name) : undefined,
    image_path_provided: typeof args.image_path === "string",
    diff_threshold: args.diff_threshold,
    ignore_regions_count: Array.isArray(args.ignore_regions) ? args.ignore_regions.length : 0,
    mask_preset_count: Array.isArray(args.mask_preset_names) ? args.mask_preset_names.length : 0,
    mask_preset_query_fields_count:
      args.mask_preset_query && typeof args.mask_preset_query === "object" && !Array.isArray(args.mask_preset_query)
        ? scopeFieldsCount(args.mask_preset_query as Record<string, unknown>)
        : 0,
    max_changed_pct: args.max_changed_pct,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status,
    tool_kind: result?.tool_kind,
    raw_tokens_estimate: result?.input_stats?.raw_tokens_estimate,
    compact_tokens_estimate: result?.input_stats?.compact_tokens_estimate,
    saved_tokens_estimate: result?.input_stats?.saved_tokens_estimate,
    savings_pct: result?.input_stats?.savings_pct,
    changed_pixels: result?.changed_pixels,
    changed_pct: result?.changed_pct,
    dimension_mismatch: result?.dimension_mismatch === true,
    ignored_changed_pixels: result?.ignored_changed_pixels,
    ignore_regions_count: result?.ignore_regions_count,
    mask_preset_regions_count: result?.mask_preset_regions_count,
    mask_presets_applied: result?.mask_presets_applied,
    mask_preset_query_matched: result?.mask_preset_query_matched,
    mask_preset_query_used: result?.mask_preset_query_used,
    mask_preset_saved: result?.tool_kind === "mask_preset" && result?.status === "mask_preset_saved",
    mask_preset_applied: result?.tool_kind === "compare" && Number(result?.mask_presets_applied || 0) > 0,
    approval_status: result?.approval_status,
    approval_recorded: result?.tool_kind === "approval" && result?.approval_status === "approved",
    approved_compare: result?.tool_kind === "compare" && result?.approval_status === "approved",
    unapproved_compare: result?.tool_kind === "compare" && result?.approval_status === "unapproved",
    stale_approval_compare: result?.tool_kind === "compare" && result?.approval_status === "stale",
    baseline_approved: result?.approval_status === "approved",
    baseline_approval_stale: result?.approval_status === "stale",
    baseline_created: result?.status === "baseline_created",
  };
}

function asBaselineInput(args: Record<string, unknown>) {
  return {
    baseline_name: asText(args.baseline_name),
    image_path: asText(args.image_path),
    metadata: args.metadata,
  };
}

function scopeFieldsCount(args: Record<string, unknown>): number {
  return [
    typeof args.route === "string" && args.route.trim() ? "route" : undefined,
    typeof args.component === "string" && args.component.trim() ? "component" : undefined,
    typeof args.viewport === "string" && args.viewport.trim() ? "viewport" : undefined,
    Array.isArray(args.tags) && args.tags.length > 0 ? "tags" : undefined,
  ].filter(Boolean).length;
}

function asCompareInput(args: Record<string, unknown>) {
  return {
    ...asBaselineInput(args),
    diff_threshold: asNumber(args.diff_threshold),
    ignore_regions: Array.isArray(args.ignore_regions) ? args.ignore_regions : undefined,
    mask_preset_names: Array.isArray(args.mask_preset_names)
      ? args.mask_preset_names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
      : undefined,
    mask_preset_query:
      args.mask_preset_query && typeof args.mask_preset_query === "object" && !Array.isArray(args.mask_preset_query)
        ? args.mask_preset_query
        : undefined,
    max_changed_pct: asNumber(args.max_changed_pct),
  };
}

function asMaskPresetInput(args: Record<string, unknown>) {
  return {
    component: asText(args.component) || undefined,
    preset_name: asText(args.preset_name),
    regions: Array.isArray(args.regions) ? args.regions : undefined,
    route: asText(args.route) || undefined,
    tags: Array.isArray(args.tags) ? args.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()) : undefined,
    viewport: asText(args.viewport) || undefined,
    metadata: args.metadata,
  };
}

function asApprovalInput(args: Record<string, unknown>) {
  return {
    baseline_name: asText(args.baseline_name),
    reviewer: asText(args.reviewer) || undefined,
    reason: asText(args.reason) || undefined,
    metadata: args.metadata,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function stringifyResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

async function audited<T>(
  tool: string,
  args: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    await appendRequestLog(config, {
      tool,
      transport: "mcp",
      ok: true,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      output: summarizeOutput(result),
    });
    return result;
  } catch (error) {
    await appendRequestLog(config, {
      tool,
      transport: "mcp",
      ok: false,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createVisualBaselineServer(): Server {
  const server = new Server(
    { name: "hwai-visual-baseline-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use visual-baseline tools for local screenshot baseline creation and changed-pixel comparison before frontier vision reasoning. Raw images and image paths stay local; Pantheon export is aggregate-only.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = asArgs(rawArgs);

    try {
      if (name === "create_baseline") {
        const result = await audited(name, args, async () => createBaseline(config, asBaselineInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "approve_baseline") {
        const result = await audited(name, args, async () => approveBaseline(config, asApprovalInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "save_mask_preset") {
        const result = await audited(name, args, async () => saveMaskPreset(config, asMaskPresetInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "compare_screenshot") {
        const result = await audited(name, args, async () => compareScreenshot(config, asCompareInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "get_artifact") {
        const raw = asText(args.artifact_url_or_file);
        if (!raw) {
          return toolError("Error: artifact_url_or_file is required");
        }
        const maxChars = (args.max_chars as number) || 20_000;
        const artifact = await audited(name, args, async () => readArtifact(config, artifactFileName(raw)));
        if (!artifact) {
          return toolError("Error: artifact not found");
        }
        return { content: [{ type: "text" as const, text: clampText(artifact.toString("utf8"), maxChars) }] };
      }
      if (name === "get_measurement_report") {
        const result = await audited(name, args, async () =>
          buildMeasurementReport(config, {
            date: asText(args.date) || undefined,
            since_iso: asText(args.since_iso) || undefined,
            until_iso: asText(args.until_iso) || undefined,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      return toolError(`Unknown tool: ${name}`);
    } catch (error) {
      return toolError(`Error running ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return server;
}

const server = createVisualBaselineServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HWAI Visual Baseline MCP Server running on stdio");
