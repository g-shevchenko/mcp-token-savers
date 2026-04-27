#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getAgentTraceConfig } from "./config.js";
import { appendRequestLog } from "./request-log.js";
import { buildMeasurementReport } from "./measurement.js";
import {
  compareSessions,
  exportPantheonSafe,
  recordStep,
  recordToolResult,
  startTrace,
  summarizeSession,
} from "./trace.js";
import { clampText } from "./text-utils.js";

const config = getAgentTraceConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch, session_id. Do not include raw prompts, code, secrets, file bodies, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    session_id: { type: "string" },
  },
};

const TOOLS: Tool[] = [
  {
    name: "start_trace",
    description: "Start or label a local agent trace session. Stores metadata-only trace state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional stable session id. Generated when omitted." },
        task_id: { type: "string" },
        surface: { type: "string", description: "Agent/client surface, for example codex, claude-code, cursor, automation." },
        source: { type: "string", description: "Trace source label, for example proof_loop, roadmap, user_task." },
        title: { type: "string", description: "Short local-only title. Hashed and previewed; never exported to Pantheon." },
        summary: { type: "string", description: "Short local-only summary. Do not include raw prompts, code, or secrets." },
        tags: { type: "array", items: { type: "string" } },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "record_step",
    description: "Record a compact metadata-only agent step in a local trace session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task_id: { type: "string" },
        surface: { type: "string" },
        source: { type: "string" },
        step_type: { type: "string", description: "planning, edit, proof_loop, notion_update, research, etc." },
        status: { type: "string", description: "ok, failed, skipped, blocked." },
        summary: { type: "string", description: "Short local-only summary. Do not include raw prompts, code, or secrets." },
        duration_ms: { type: "number" },
        raw_tokens_estimate: { type: "number" },
        compact_tokens_estimate: { type: "number" },
        saved_tokens_estimate: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        metadata: METADATA_SCHEMA,
      },
      required: ["session_id"],
    },
  },
  {
    name: "record_tool_result",
    description: "Record a compact utility MCP/tool result in a local trace session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        task_id: { type: "string" },
        surface: { type: "string" },
        source: { type: "string" },
        utility_mcp: { type: "string" },
        tool_name: { type: "string" },
        status: { type: "string", description: "ok, failed, skipped, blocked." },
        duration_ms: { type: "number" },
        raw_tokens_estimate: { type: "number" },
        compact_tokens_estimate: { type: "number" },
        saved_tokens_estimate: { type: "number" },
        uncertainty: { type: "number" },
        metadata: METADATA_SCHEMA,
      },
      required: ["session_id", "utility_mcp", "tool_name"],
    },
  },
  {
    name: "summarize_session",
    description: "Summarize one local agent trace session into compact counts and local artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        metadata: METADATA_SCHEMA,
      },
      required: ["session_id"],
    },
  },
  {
    name: "compare_sessions",
    description:
      "Compare two local session rollups and return aggregate-only deltas for autonomous-loop regression review.",
    inputSchema: {
      type: "object",
      properties: {
        baseline_session_id: { type: "string" },
        candidate_session_id: { type: "string" },
        from_session_id: { type: "string", description: "Alias for baseline_session_id." },
        to_session_id: { type: "string", description: "Alias for candidate_session_id." },
        metadata: METADATA_SCHEMA,
      },
      required: ["baseline_session_id", "candidate_session_id"],
    },
  },
  {
    name: "export_pantheon_safe",
    description: "Return aggregate-only agent trace telemetry for Pantheon. No raw prompts, code, paths, summaries, or artifact URLs.",
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
  {
    name: "get_artifact",
    description: "Read a local artifact produced by agent-trace-mcp.",
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
    description: "Return local agent-trace usage, quality, token-savings, and Pantheon-safe aggregate export.",
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

function asArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function metadataSource(args: Record<string, unknown> | undefined): string | undefined {
  const explicit = asText(args?.source).trim();
  if (explicit) {
    return explicit.slice(0, 80);
  }
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
  return {
    session_id_provided: typeof args.session_id === "string",
    baseline_session_id_provided: typeof args.baseline_session_id === "string" || typeof args.from_session_id === "string",
    candidate_session_id_provided: typeof args.candidate_session_id === "string" || typeof args.to_session_id === "string",
    task_id_provided: typeof args.task_id === "string",
    surface: typeof args.surface === "string" ? args.surface : undefined,
    metadata_source: metadataSource(args),
    utility_mcp: typeof args.utility_mcp === "string" ? args.utility_mcp : undefined,
    tool_name: typeof args.tool_name === "string" ? args.tool_name : undefined,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    raw_tokens_estimate: args.raw_tokens_estimate,
    compact_tokens_estimate: args.compact_tokens_estimate,
    saved_tokens_estimate: args.saved_tokens_estimate,
  };
}

function summarizeOutput(tool: string, result: any): Record<string, unknown> {
  const output: Record<string, unknown> = {
    status: result?.status,
    session_id: result?.session_id,
    events_count: result?.events || result?.summary?.events,
    candidate_events_count: result?.candidate?.events,
    failed_events_delta: result?.delta?.failed_events,
    unknown_source_delta: result?.delta?.unknown_source_count,
    sessions_count: result?.summary?.sessions,
    unknown_source_count: result?.summary?.unknown_source_count || result?.quality?.unknown_source_count,
    high_uncertainty_count: result?.high_uncertainty_count || result?.summary?.high_uncertainty_count,
    safe_for_pantheon: result?.safe_for_pantheon || result?.pantheon_export?.safe_for_pantheon,
  };
  if (tool === "record_step" || tool === "record_tool_result") {
    output.raw_tokens_estimate = result?.raw_tokens_estimate || 0;
    output.compact_tokens_estimate = result?.compact_tokens_estimate || 0;
    output.saved_tokens_estimate = result?.saved_tokens_estimate || 0;
    output.savings_pct =
      output.raw_tokens_estimate && typeof output.raw_tokens_estimate === "number"
        ? Math.round(((output.saved_tokens_estimate as number) / output.raw_tokens_estimate) * 1000) / 10
        : 0;
  }
  return output;
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
      output: summarizeOutput(tool, result),
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

function createAgentTraceServer(): Server {
  const server = new Server(
    { name: "hwai-agent-trace-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use agent-trace tools to group autonomous agent work into local metadata-only session graphs. Pantheon export is aggregate-only. Do not record raw prompts, code, secrets, file bodies, or long notes.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = asArgs(rawArgs);

    try {
      if (name === "start_trace") {
        const result = await audited(name, args, async () => startTrace(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "record_step") {
        const result = await audited(name, args, async () => recordStep(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "record_tool_result") {
        const result = await audited(name, args, async () => recordToolResult(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_session") {
        const result = await audited(name, args, async () => summarizeSession(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "compare_sessions") {
        const result = await audited(name, args, async () => compareSessions(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "export_pantheon_safe") {
        const result = await audited(name, args, async () =>
          exportPantheonSafe(config, {
            date: asText(args.date) || undefined,
            since_iso: asText(args.since_iso) || undefined,
            until_iso: asText(args.until_iso) || undefined,
          }),
        );
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

const server = createAgentTraceServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HWAI Agent Trace MCP Server running on stdio");
