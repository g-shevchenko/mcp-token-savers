#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getRouterLiteConfig } from "./config.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { RouterLiteArgs, classifyInput } from "./router.js";
import { cleanLabel, stableHash } from "./text-utils.js";

const config = getRouterLiteConfig();

const METADATA_SCHEMA = {
  type: "object",
  description: "Optional safe attribution metadata. Recommended: source, surface, task_id, repo, branch, traffic_class.",
  properties: {
    source: { type: "string" },
    surface: { type: "string" },
    task_id: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    traffic_class: { type: "string" },
  },
};

const ROUTE_PROPS = {
  text: { type: "string", description: "Optional prompt/input text. Logged only as length/hash." },
  input_kind: { type: "string", description: "Optional hint: chat, logs, screenshot, url, repo_task, trace, unknown." },
  urls: { type: "array", items: { type: "string" }, description: "Optional explicit URLs. Logged only as count/hash." },
  artifact_kinds: { type: "array", items: { type: "string" }, description: "Optional artifact hints such as trace.zip or har." },
  changed_files: { type: "array", items: { type: "string" }, description: "Optional changed file hints. Logged only as count." },
  selected_paths: { type: "array", items: { type: "string" }, description: "Optional active/selected path hints. Logged only as count." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "route_task",
    description:
      "Deterministically decide which HWAI utility prep MCP, if any, should run before frontier reasoning. Does not answer the task.",
    inputSchema: { type: "object", properties: ROUTE_PROPS },
  },
  {
    name: "classify_input",
    description: "Alias of route_task for classifying prompt/input shape into prep triggers and skip decisions.",
    inputSchema: { type: "object", properties: ROUTE_PROPS },
  },
  {
    name: "needs_clarification",
    description: "Return whether the task is too ambiguous to route without one clarification question.",
    inputSchema: { type: "object", properties: ROUTE_PROPS },
  },
  {
    name: "get_measurement_report",
    description: "Return local router-lite trigger/skip usage and Pantheon-safe aggregate export.",
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

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function asRouteArgs(args: Record<string, unknown>): RouterLiteArgs {
  return {
    artifact_kinds: asStringArray(args.artifact_kinds),
    changed_files: asStringArray(args.changed_files),
    input_kind: typeof args.input_kind === "string" ? args.input_kind : undefined,
    metadata: args.metadata,
    selected_paths: asStringArray(args.selected_paths),
    text: typeof args.text === "string" ? args.text : undefined,
    urls: asStringArray(args.urls),
  };
}

function metadataValue(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const metadata = args?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}

function summarizeInput(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const text = typeof args?.text === "string" ? args.text : "";
  const urls = asStringArray(args?.urls) || [];
  return {
    text_chars: text.length,
    text_hash: text ? stableHash(text) : undefined,
    input_kind: cleanLabel(args?.input_kind, "unknown"),
    urls_count: urls.length,
    urls_hash: urls.length ? stableHash(urls.join("\n")) : undefined,
    artifact_kinds_count: Array.isArray(args?.artifact_kinds) ? args.artifact_kinds.length : 0,
    changed_files_count: Array.isArray(args?.changed_files) ? args.changed_files.length : 0,
    selected_paths_count: Array.isArray(args?.selected_paths) ? args.selected_paths.length : 0,
    metadata_source: metadataValue(args, "source"),
    metadata_surface: metadataValue(args, "surface"),
    traffic_class: metadataValue(args, "traffic_class"),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  const recommended = Array.isArray(result?.recommended_mcps) ? result.recommended_mcps : [];
  const decision = result?.decision || (result?.needs_clarification === true ? "ask_clarification" : "unknown");
  return {
    decision,
    recommended_mcps: recommended,
    trigger_recommended: decision === "call_mcp" ? 1 : 0,
    skip_recommended: decision === "skip_mcp" ? 1 : 0,
    clarification_recommended: decision === "ask_clarification" ? 1 : 0,
    frontier_required: result?.requires_frontier_reasoning === true ? 1 : 0,
    vision_recommended: recommended.includes("vision-mcp") ? 1 : 0,
    context_prep_recommended: recommended.includes("context-prep-mcp") ? 1 : 0,
    retrieval_recommended: recommended.includes("retrieval-mcp") ? 1 : 0,
    scraper_recommended: recommended.includes("scraper-stack") ? 1 : 0,
    raw_tokens_estimate: result?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || 0,
    savings_pct: result?.savings_pct || 0,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function runTool(name: string, rawArgs: unknown) {
  const args = asRecord(rawArgs);
  const started = Date.now();
  try {
    let result: unknown;
    switch (name) {
      case "route_task":
      case "classify_input":
        result = classifyInput(asRouteArgs(args));
        break;
      case "needs_clarification": {
        const routed = classifyInput(asRouteArgs(args));
        result = {
          schema_version: routed.schema_version,
          pipeline_version: routed.pipeline_version,
          status: "ok",
          needs_clarification: routed.decision === "ask_clarification",
          clarification_reason: routed.clarification_reason,
          confidence: routed.confidence,
          risk_flags: routed.risk_flags,
          cheap_only_allowed: false,
          data_policy: routed.data_policy,
        };
        break;
      }
      case "get_measurement_report":
        result = await buildMeasurementReport(config, {
          date: typeof args.date === "string" ? args.date : undefined,
          since_iso: typeof args.since_iso === "string" ? args.since_iso : undefined,
          until_iso: typeof args.until_iso === "string" ? args.until_iso : undefined,
        });
        break;
      default:
        return toolError(`Unknown tool: ${name}`);
    }
    await appendRequestLog(config, {
      duration_ms: Date.now() - started,
      input: summarizeInput(args),
      ok: true,
      output: summarizeOutput(result),
      tool: name,
      transport: "mcp",
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendRequestLog(config, {
      duration_ms: Date.now() - started,
      error: message,
      input: summarizeInput(args),
      ok: false,
      tool: name,
      transport: "mcp",
    });
    return toolError(message);
  }
}

const server = new Server(
  {
    name: "hwai-router-lite-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use router-lite only for deterministic prep trigger/skip decisions. It must not replace frontier reasoning or final task judgment.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => runTool(request.params.name, request.params.arguments));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HWAI Router Lite MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Router Lite MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
