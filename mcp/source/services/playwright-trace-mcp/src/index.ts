#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getPlaywrightTraceConfig } from "./config.js";
import { buildMeasurementReport } from "./measurement.js";
import {
  extractFailureStep,
  prepareTrace,
  prepareTraceScreenshots,
  summarizeConsole,
  summarizeNetwork,
  TraceInput,
} from "./parsers.js";
import { appendRequestLog } from "./request-log.js";
import { clampText } from "./text-utils.js";

const config = getPlaywrightTraceConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata for attribution. Recommended: source, task_id, surface, repo, branch, session_id. Do not include raw trace contents, URLs, secrets, file bodies, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    session_id: { type: "string" },
  },
};

const TRACE_INPUT_PROPS = {
  trace_zip_path: { type: "string", description: "Local Playwright trace.zip path. Raw path is not written to request logs." },
  trace_json: { type: "string", description: "Inline Playwright trace JSON or JSONL. Local-only; not exported to Pantheon." },
  trace_text: { type: "string", description: "Inline trace/test text. Local-only; not exported to Pantheon." },
  console_json: { type: "string", description: "Inline console JSON or JSONL." },
  console_text: { type: "string", description: "Inline console text." },
  network_json: { type: "string", description: "Inline network JSON or JSONL." },
  har_json: { type: "string", description: "Inline HAR JSON." },
  screenshot_paths: { type: "array", items: { type: "string" }, description: "Optional local screenshots to copy into local artifacts." },
  max_events: { type: "number", description: "Maximum parsed events returned. Default 100." },
  max_screenshots: { type: "number", description: "Maximum screenshots to prepare. Default 6." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "prepare_trace",
    description:
      "Parse a Playwright trace.zip, JSONL, HAR, console, or network artifact into compact browser-debug evidence and parser-stack handoff hints.",
    inputSchema: { type: "object", properties: TRACE_INPUT_PROPS },
  },
  {
    name: "summarize_console",
    description: "Summarize Playwright/browser console errors and warnings without dumping raw console logs.",
    inputSchema: { type: "object", properties: TRACE_INPUT_PROPS },
  },
  {
    name: "summarize_network",
    description: "Summarize Playwright/HAR/network failures, 4xx/5xx counts, and redacted URL previews/hashes.",
    inputSchema: { type: "object", properties: TRACE_INPUT_PROPS },
  },
  {
    name: "extract_failure_step",
    description: "Extract the primary failing action, console error, or network failure from Playwright trace evidence.",
    inputSchema: { type: "object", properties: TRACE_INPUT_PROPS },
  },
  {
    name: "prepare_trace_screenshots",
    description: "Extract or copy trace screenshots into local artifacts and return vision-mcp handoff hints.",
    inputSchema: { type: "object", properties: TRACE_INPUT_PROPS },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by playwright-trace-mcp.",
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
    description: "Return local playwright-trace usage, quality, token-savings, and Pantheon-safe aggregate export.",
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

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function asArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function asTraceInput(args: Record<string, unknown>): TraceInput {
  return {
    console_json: asText(args.console_json) || undefined,
    console_text: asText(args.console_text) || undefined,
    har_json: asText(args.har_json) || undefined,
    max_events: asNumber(args.max_events),
    max_screenshots: asNumber(args.max_screenshots),
    network_json: asText(args.network_json) || undefined,
    screenshot_paths: asStringArray(args.screenshot_paths),
    trace_json: asText(args.trace_json) || undefined,
    trace_text: asText(args.trace_text) || undefined,
    trace_zip_path: asText(args.trace_zip_path) || undefined,
  };
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
  return {
    trace_zip_path_provided: typeof args.trace_zip_path === "string",
    trace_json_chars: typeof args.trace_json === "string" ? args.trace_json.length : 0,
    trace_text_chars: typeof args.trace_text === "string" ? args.trace_text.length : 0,
    console_json_chars: typeof args.console_json === "string" ? args.console_json.length : 0,
    console_text_chars: typeof args.console_text === "string" ? args.console_text.length : 0,
    network_json_chars: typeof args.network_json === "string" ? args.network_json.length : 0,
    har_json_chars: typeof args.har_json === "string" ? args.har_json.length : 0,
    screenshot_paths_count: Array.isArray(args.screenshot_paths) ? args.screenshot_paths.length : 0,
    max_events: args.max_events,
    max_screenshots: args.max_screenshots,
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
    console_errors: result?.console?.errors,
    console_warnings: result?.console?.warnings,
    network_failures: result?.network?.failures,
    failure_found: Boolean(result?.failure),
    failure_window_present: Boolean(result?.failure_window),
    failure_window_console_errors: result?.failure_window?.nearby_console_errors,
    failure_window_network_failures: result?.failure_window?.nearby_network_failures,
    failure_window_slow_requests: result?.failure_window?.nearby_slow_requests,
    failure_window_warnings_count: Array.isArray(result?.failure_window?.warnings)
      ? result.failure_window.warnings.length
      : undefined,
    screenshots_prepared: result?.image_count || result?.screenshots_count,
    context_prep_recommended: result?.handoff?.context_prep_recommended === true,
    vision_recommended: result?.handoff?.vision_recommended === true,
    scraper_followup_recommended: result?.handoff?.scraper_followup_recommended === true,
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

function createPlaywrightTraceServer(): Server {
  const server = new Server(
    { name: "hwai-playwright-trace-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use playwright-trace tools to parse local Playwright trace/HAR/console/network artifacts into compact evidence. Raw trace contents stay local; Pantheon export is aggregate-only. Use context-prep for long text, vision for screenshots, and scraper stack only as a follow-up when failed requests need verification.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = asArgs(rawArgs);

    try {
      if (name === "prepare_trace") {
        const result = await audited(name, args, async () => prepareTrace(config, asTraceInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_console") {
        const result = await audited(name, args, async () => summarizeConsole(config, asTraceInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_network") {
        const result = await audited(name, args, async () => summarizeNetwork(config, asTraceInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "extract_failure_step") {
        const result = await audited(name, args, async () => extractFailureStep(config, asTraceInput(args)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "prepare_trace_screenshots") {
        const result = await audited(name, args, async () => prepareTraceScreenshots(config, asTraceInput(args)));
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

const server = createPlaywrightTraceServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HWAI Playwright Trace MCP Server running on stdio");
