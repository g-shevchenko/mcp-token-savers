#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readArtifact } from "./artifact-store.js";
import {
  getRetrievalConfig,
  RETRIEVAL_PIPELINE_VERSION,
  RETRIEVAL_SCHEMA_VERSION,
} from "./config.js";
import { appendRequestLog } from "./request-log.js";
import { buildMeasurementReport, recordRetrievalFeedback } from "./measurement.js";
import { artifactNameFromInput, findFiles, retrieveContext, TaskIntent } from "./retrieval.js";
import { buildRepoMap } from "./repo-map.js";
import { clampText } from "./text-utils.js";

const config = getRetrievalConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata for attribution. Recommended fields: owner, project, surface, repo, branch, commit_sha, session_id.",
  properties: {
    owner: { type: "string" },
    project: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    commit_sha: { type: "string" },
    session_id: { type: "string" },
    source: { type: "string" },
  },
};

const CONTEXT_HINTS_SCHEMA = {
  type: "object",
  description:
    "Optional metadata-only client hints. Paths may boost ranking but never bypass path policy or exact file reads.",
  properties: {
    open_files: { type: "array", items: { type: "string" } },
    selected_paths: { type: "array", items: { type: "string" } },
    recent_files: { type: "array", items: { type: "string" } },
    diagnostic_files: { type: "array", items: { type: "string" } },
    changed_files_override: { type: "array", items: { type: "string" } },
  },
};

const RETRIEVE_CONTEXT_TOOL: Tool = {
  name: "retrieve_context",
  description:
    "Find the most relevant local code/docs snippets for a task before spending frontier-model tokens. " +
    "Uses deterministic local ripgrep/path scoring, returns ranked files, line-anchored snippets, related files, confidence, and raw artifact. " +
    "Use for broad repo questions or before editing when the target files are not obvious. Skip when the exact file is already known.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language task or code/search terms.",
      },
      root_path: {
        type: "string",
        description: "Repo/worktree root. Defaults to the MCP process cwd.",
      },
      task_intent: {
        type: "string",
        enum: ["bug_fix", "implementation", "review", "explain", "test", "docs", "unknown"],
        default: "unknown",
      },
      include_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional rg glob includes, e.g. services/**/*.ts.",
      },
      exclude_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional rg glob excludes. Secrets and generated folders are always excluded.",
      },
      max_files: {
        type: "number",
        description: "Maximum ranked files. Default: 12.",
      },
      max_snippets: {
        type: "number",
        description: "Maximum snippets. Default: 18.",
      },
      max_chars: {
        type: "number",
        description: "Maximum compact_context characters. Default: 12000.",
      },
      include_tests: {
        type: "boolean",
        description: "Keep test/spec files in ranking. Tests are included by default but boosted only for test intent.",
      },
      include_repo_map: {
        type: "boolean",
        description: "Also return a token-budgeted repo_map artifact for architecture/onboarding orientation. Default false.",
      },
      repo_map_max_chars: {
        type: "number",
        description: "Maximum repo_map characters when include_repo_map=true. Default: 8000.",
      },
      git_context: {
        type: "boolean",
        description: "Boost files changed in the current git worktree. Default: true.",
      },
      context_hints: CONTEXT_HINTS_SCHEMA,
      metadata: METADATA_SCHEMA,
    },
    required: ["query"],
  },
};

const FIND_FILES_TOOL: Tool = {
  name: "find_files",
  description:
    "Find likely relevant local repo files for a query without returning code snippets. Use as a cheap first pass when you only need file candidates.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language or code/path query." },
      root_path: { type: "string", description: "Repo/worktree root. Defaults to MCP cwd." },
      include_globs: { type: "array", items: { type: "string" } },
      exclude_globs: { type: "array", items: { type: "string" } },
      max_files: { type: "number", description: "Maximum ranked files. Default: 30." },
      context_hints: CONTEXT_HINTS_SCHEMA,
      metadata: METADATA_SCHEMA,
    },
    required: ["query"],
  },
};

const GET_ARTIFACT_TOOL: Tool = {
  name: "get_artifact",
  description:
    "Read a retrieval artifact by artifact URL or file name. Use when compact snippets are insufficient or exact raw search ranking is needed.",
  inputSchema: {
    type: "object",
    properties: {
      artifact_url_or_file: {
        type: "string",
        description: "Artifact URL or file name from retrieve_context/find_files.",
      },
      max_chars: {
        type: "number",
        description: "Maximum returned characters. Default: 20000.",
      },
    },
    required: ["artifact_url_or_file"],
  },
};

const GET_REPO_MAP_TOOL: Tool = {
  name: "get_repo_map",
  description:
    "Build a token-budgeted local repo map from path policy plus code-graph-lite symbols. " +
    "Use for architecture/onboarding orientation before specific file reads. It is deterministic and local-first; read exact files before edits.",
  inputSchema: {
    type: "object",
    properties: {
      root_path: { type: "string", description: "Repo/worktree root. Defaults to MCP cwd." },
      include_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional rg glob includes, e.g. services/retrieval-mcp/**.",
      },
      exclude_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional rg glob excludes. Secrets and generated folders are always excluded.",
      },
      max_files: {
        type: "number",
        description: "Maximum prioritized files to map. Default: 240.",
      },
      max_chars: {
        type: "number",
        description: "Maximum repo_map characters. Default: 12000.",
      },
      include_tests: {
        type: "boolean",
        description: "Keep test/spec files in map. Default true.",
      },
      metadata: METADATA_SCHEMA,
    },
  },
};

const RECORD_FEEDBACK_TOOL: Tool = {
  name: "record_feedback",
  description:
    "Record the outcome of a retrieval call so misses can become benchmark candidates. " +
    "Use after retrieval was partial, wrong, or forced the frontier model/manual search to find better files. " +
    "Do not include file contents or secrets; paths and short notes only.",
  inputSchema: {
    type: "object",
    properties: {
      call_id: {
        type: "string",
        description: "call_id returned by retrieve_context/find_files when available.",
      },
      outcome: {
        type: "string",
        enum: ["helpful", "partial", "miss", "wrong_context", "manual_search_needed"],
      },
      frontier_had_to_search: {
        type: "boolean",
        description: "True when the frontier model or agent had to search manually after poor retrieval.",
      },
      query: { type: "string", description: "Original query/task, if safe to log." },
      corrected_query: {
        type: "string",
        description: "Better query wording discovered by the frontier model or agent.",
      },
      root_path: { type: "string" },
      retrieved_paths: { type: "array", items: { type: "string" } },
      opened_paths: { type: "array", items: { type: "string" } },
      expected_paths: { type: "array", items: { type: "string" } },
      missing_paths: { type: "array", items: { type: "string" } },
      notes: { type: "string", description: "Short safe note. Do not include raw code or secrets." },
      metadata: METADATA_SCHEMA,
    },
    required: ["outcome"],
  },
};

const GET_MEASUREMENT_REPORT_TOOL: Tool = {
  name: "get_measurement_report",
  description:
    "Return daily retrieval usage, token-savings estimates, feedback quality metrics, and a Pantheon-safe aggregate export.",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "UTC date YYYY-MM-DD. Defaults to today.",
      },
      since_iso: {
        type: "string",
        description: "Optional ISO start time; overrides date start.",
      },
      until_iso: {
        type: "string",
        description: "Optional ISO end time; overrides date end.",
      },
      include_samples: {
        type: "boolean",
        description: "Include corrected_query/notes in improvement candidates. Default false.",
      },
    },
  },
};

function stringifyResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function asContextHints(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    open_files: asStringArray(record.open_files),
    selected_paths: asStringArray(record.selected_paths),
    recent_files: asStringArray(record.recent_files),
    diagnostic_files: asStringArray(record.diagnostic_files),
    changed_files_override: asStringArray(record.changed_files_override),
  };
}

function asTaskIntent(value: unknown): TaskIntent | undefined {
  return value === "bug_fix" ||
    value === "implementation" ||
    value === "review" ||
    value === "explain" ||
    value === "test" ||
    value === "docs" ||
    value === "unknown"
    ? value
    : undefined;
}

function artifactFileName(raw: string): string {
  return artifactNameFromInput(raw || "");
}

function cleanMetadataLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
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
  return (
    cleanMetadataLabel(metadata?.source) ||
    cleanMetadataLabel(args.metadata_source) ||
    cleanMetadataLabel(args.source)
  );
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

function trafficClass(source: string | undefined, surface: string | undefined, tool: string): string {
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

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function summarizeInput(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) {
    return {};
  }
  if (tool === "retrieve_context" || tool === "find_files" || tool === "get_repo_map") {
    const source = metadataSource(args);
    const surface = metadataSurface(args);
    return {
      query_chars: typeof args.query === "string" ? args.query.length : undefined,
      root_path: typeof args.root_path === "string" ? args.root_path : undefined,
      task_intent: args.task_intent,
      include_globs_count: Array.isArray(args.include_globs) ? args.include_globs.length : 0,
      exclude_globs_count: Array.isArray(args.exclude_globs) ? args.exclude_globs.length : 0,
      max_files: args.max_files,
      max_snippets: args.max_snippets,
      max_chars: args.max_chars,
      include_repo_map: args.include_repo_map === true,
      metadata_source: source,
      metadata_surface: surface,
      traffic_class: trafficClass(source, surface, tool),
      context_hints_paths:
        args.context_hints && typeof args.context_hints === "object"
          ? Object.values(args.context_hints as Record<string, unknown>).reduce(
              (sum: number, value) => sum + (Array.isArray(value) ? value.length : 0),
              0,
            )
          : 0,
    };
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
  if (tool === "record_feedback") {
    const source = metadataSource(args);
    const surface = metadataSurface(args);
    return {
      call_id: typeof args.call_id === "string" ? args.call_id : undefined,
      outcome: args.outcome,
      frontier_had_to_search: args.frontier_had_to_search === true,
      metadata_source: source,
      metadata_surface: surface,
      traffic_class: trafficClass(source, surface, tool),
      retrieved_paths_count: Array.isArray(args.retrieved_paths) ? args.retrieved_paths.length : 0,
      expected_paths_count: Array.isArray(args.expected_paths) ? args.expected_paths.length : 0,
      missing_paths_count: Array.isArray(args.missing_paths) ? args.missing_paths.length : 0,
    };
  }
  if (tool === "get_measurement_report") {
    return {
      date: args.date,
      since_iso: args.since_iso,
      until_iso: args.until_iso,
      include_samples: args.include_samples === true,
    };
  }
  return {};
}

function summarizeOutput(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }
  const record = result as Record<string, any>;
  return {
    retrieval_mode: record.retrieval_mode,
    call_id: record.call_id,
    feedback_id: record.feedback_id,
    benchmark_candidate: record.benchmark_candidate,
    repo_map_file: record.artifacts?.repo_map_file,
    files_considered: record.input_stats?.files_considered,
    files_mapped: record.input_stats?.files_mapped,
    ranked_files_returned: record.input_stats?.ranked_files_returned,
    snippets_returned: record.input_stats?.snippets_returned,
    raw_tokens_estimate: record.input_stats?.raw_tokens_estimate,
    compact_tokens_estimate: record.input_stats?.compact_tokens_estimate,
    saved_tokens_estimate: record.input_stats?.saved_tokens_estimate,
    savings_pct: record.input_stats?.savings_pct,
    report_saved_tokens_estimate: record.token_savings?.saved_tokens_estimate,
    report_estimated_usd_saved: record.token_savings?.estimated_usd_saved,
    truncated: record.input_stats?.truncated,
    warnings_count: record.input_stats?.warnings_count,
    filtered_hits_count: record.input_stats?.filtered_hits_count,
    context_hints_applied_count: record.input_stats?.context_hints_applied_count,
    uncertainty: record.confidence?.uncertainty,
  };
}

async function audited<T>(
  tool: string,
  transport: "mcp" | "rest" | "http",
  args: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    await appendRequestLog(config, {
      tool,
      transport,
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
      ok: false,
      duration_ms: Date.now() - started,
      input: summarizeInput(tool, args),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createRetrievalServer(): Server {
  const server = new Server(
    {
      name: "hwai-retrieval-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use retrieval tools for broad local codebase questions, not when the exact file is already known. Retrieval prepares line-anchored context; before editing, read the exact files. Do not use it to expose secrets.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      RETRIEVE_CONTEXT_TOOL,
      FIND_FILES_TOOL,
      GET_REPO_MAP_TOOL,
      GET_ARTIFACT_TOOL,
      RECORD_FEEDBACK_TOOL,
      GET_MEASUREMENT_REPORT_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const recordArgs = args as Record<string, unknown> | undefined;

    if (name === "retrieve_context") {
      const query = asText(args?.query);
      if (!query) {
        return toolError("Error: query is required");
      }

      try {
        const result = await audited("retrieve_context", "mcp", recordArgs, async () =>
          retrieveContext(query, config, {
            root_path: asText(args?.root_path) || undefined,
            task_intent: asTaskIntent(args?.task_intent),
            include_globs: asStringArray(args?.include_globs),
            exclude_globs: asStringArray(args?.exclude_globs),
            max_files: args?.max_files as number | undefined,
            max_snippets: args?.max_snippets as number | undefined,
            max_chars: args?.max_chars as number | undefined,
            include_repo_map: args?.include_repo_map as boolean | undefined,
            repo_map_max_chars: args?.repo_map_max_chars as number | undefined,
            include_tests: args?.include_tests as boolean | undefined,
            git_context: args?.git_context as boolean | undefined,
            context_hints: asContextHints(args?.context_hints),
            metadata: args?.metadata as any,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        return toolError(`Error retrieving context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (name === "find_files") {
      const query = asText(args?.query);
      if (!query) {
        return toolError("Error: query is required");
      }

      try {
        const result = await audited("find_files", "mcp", recordArgs, async () =>
          findFiles(query, config, {
            root_path: asText(args?.root_path) || undefined,
            include_globs: asStringArray(args?.include_globs),
            exclude_globs: asStringArray(args?.exclude_globs),
            max_files: args?.max_files as number | undefined,
            context_hints: asContextHints(args?.context_hints),
            metadata: args?.metadata as any,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        return toolError(`Error finding files: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (name === "get_repo_map") {
      try {
        const result = await audited("get_repo_map", "mcp", recordArgs, async () =>
          buildRepoMap(config, {
            root_path: asText(args?.root_path) || undefined,
            include_globs: asStringArray(args?.include_globs),
            exclude_globs: asStringArray(args?.exclude_globs),
            max_files: args?.max_files as number | undefined,
            max_chars: args?.max_chars as number | undefined,
            include_tests: args?.include_tests as boolean | undefined,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        return toolError(`Error building repo map: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (name === "get_artifact") {
      const raw = asText(args?.artifact_url_or_file);
      const maxChars = (args?.max_chars as number) || 20_000;
      if (!raw) {
        return toolError("Error: artifact_url_or_file is required");
      }

      try {
        const artifact = await audited("get_artifact", "mcp", recordArgs, async () =>
          readArtifact(config, artifactFileName(raw)),
        );
        if (!artifact) {
          return toolError("Error: artifact not found");
        }
        return {
          content: [{ type: "text" as const, text: clampText(artifact.toString("utf8"), maxChars) }],
        };
      } catch (error) {
        return toolError(`Error reading artifact: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (name === "record_feedback") {
      try {
        const result = await audited("record_feedback", "mcp", recordArgs, async () =>
          recordRetrievalFeedback(config, recordArgs || {}),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        return toolError(`Error recording feedback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (name === "get_measurement_report") {
      try {
        const result = await audited("get_measurement_report", "mcp", recordArgs, async () =>
          buildMeasurementReport(config, {
            date: asText(args?.date) || undefined,
            since_iso: asText(args?.since_iso) || undefined,
            until_iso: asText(args?.until_iso) || undefined,
            include_samples: args?.include_samples === true,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      } catch (error) {
        return toolError(`Error building measurement report: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return toolError(`Unknown tool: ${name}`);
  });

  return server;
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseBody(req: IncomingMessage, maxBytes = config.maxBodyBytes): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds maximum allowed size (${maxBytes} bytes)`);
    }
    chunks.push(buffer);
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
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }

  const server = createRetrievalServer();
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
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
    await transport.close();
    await server.close();
  }
}

async function handleRest(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = (await parseBody(req)) as Record<string, unknown> | undefined;
  if (!body) {
    respondJson(res, 400, { error: "JSON body is required" });
    return;
  }

  if (pathname === "/api/retrieve/context") {
    const query = asText(body.query);
    if (!query) {
      respondJson(res, 400, { error: "query is required" });
      return;
    }

    respondJson(
      res,
      200,
      await audited("retrieve_context", "rest", body, async () =>
        retrieveContext(query, config, {
          root_path: asText(body.root_path) || undefined,
          task_intent: asTaskIntent(body.task_intent),
          include_globs: asStringArray(body.include_globs),
          exclude_globs: asStringArray(body.exclude_globs),
          max_files: body.max_files as number | undefined,
          max_snippets: body.max_snippets as number | undefined,
          max_chars: body.max_chars as number | undefined,
          include_repo_map: body.include_repo_map as boolean | undefined,
          repo_map_max_chars: body.repo_map_max_chars as number | undefined,
          include_tests: body.include_tests as boolean | undefined,
          git_context: body.git_context as boolean | undefined,
          context_hints: asContextHints(body.context_hints),
          metadata: body.metadata as any,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/retrieve/repo-map") {
    respondJson(
      res,
      200,
      await audited("get_repo_map", "rest", body, async () =>
        buildRepoMap(config, {
          root_path: asText(body.root_path) || undefined,
          include_globs: asStringArray(body.include_globs),
          exclude_globs: asStringArray(body.exclude_globs),
          max_files: body.max_files as number | undefined,
          max_chars: body.max_chars as number | undefined,
          include_tests: body.include_tests as boolean | undefined,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/retrieve/files") {
    const query = asText(body.query);
    if (!query) {
      respondJson(res, 400, { error: "query is required" });
      return;
    }

    respondJson(
      res,
      200,
      await audited("find_files", "rest", body, async () =>
        findFiles(query, config, {
          root_path: asText(body.root_path) || undefined,
          include_globs: asStringArray(body.include_globs),
          exclude_globs: asStringArray(body.exclude_globs),
          max_files: body.max_files as number | undefined,
          context_hints: asContextHints(body.context_hints),
          metadata: body.metadata as any,
        }),
      ),
    );
    return;
  }

  if (pathname === "/api/retrieve/feedback") {
    respondJson(
      res,
      200,
      await audited("record_feedback", "rest", body, async () =>
        recordRetrievalFeedback(config, body),
      ),
    );
    return;
  }

  if (pathname === "/api/retrieve/measurements") {
    respondJson(
      res,
      200,
      await audited("get_measurement_report", "rest", body, async () =>
        buildMeasurementReport(config, {
          date: asText(body.date) || undefined,
          since_iso: asText(body.since_iso) || undefined,
          until_iso: asText(body.until_iso) || undefined,
          include_samples: body.include_samples === true,
        }),
      ),
    );
    return;
  }

  respondJson(res, 404, { error: "Not found" });
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || "/", config.publicBaseUrl);
    if (url.pathname === "/health") {
      respondJson(res, 200, {
        ok: true,
        service: "retrieval-mcp",
        schema_version: RETRIEVAL_SCHEMA_VERSION,
        pipeline_version: RETRIEVAL_PIPELINE_VERSION,
        transport_mode: config.transportMode,
        default_root: config.defaultRoot,
        cache_dir: config.cacheDir,
        artifact_dir: config.artifactDir,
        request_log_path: config.requestLogPath,
        feedback_log_path: config.feedbackLogPath,
        measurement_usd_per_1m_tokens: config.measurementUsdPer1MTokens,
        tools: [
          "retrieve_context",
          "find_files",
          "get_repo_map",
          "get_artifact",
          "record_feedback",
          "get_measurement_report",
        ],
        local_first: true,
      });
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcpHttp(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/retrieve/")) {
      if (url.pathname === "/api/retrieve/measurements" && req.method === "GET") {
        respondJson(
          res,
          200,
          await audited("get_measurement_report", "http", undefined, async () =>
            buildMeasurementReport(config, {
              date: url.searchParams.get("date") || undefined,
              since_iso: url.searchParams.get("since_iso") || undefined,
              until_iso: url.searchParams.get("until_iso") || undefined,
              include_samples: url.searchParams.get("include_samples") === "true",
            }),
          ),
        );
        return;
      }
      await handleRest(url.pathname, req, res);
      return;
    }

    if (url.pathname.startsWith("/artifacts/")) {
      const fileName = path.basename(url.pathname);
      const artifact = await readArtifact(config, fileName);
      if (!artifact) {
        respondJson(res, 404, { error: "Artifact not found" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(artifact);
      return;
    }

    respondJson(res, 404, { error: "Not found" });
  } catch (error) {
    respondJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  if (config.transportMode === "http") {
    const server = createServer((req, res) => {
      void handleHttpRequest(req, res);
    });
    server.listen(config.httpPort, config.httpHost, () => {
      console.error(
        `HWAI Retrieval MCP HTTP running at http://${config.httpHost}:${config.httpPort}`,
      );
    });
    return;
  }

  const server = createRetrievalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HWAI Retrieval MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal retrieval-mcp error:", error);
  process.exit(1);
});
