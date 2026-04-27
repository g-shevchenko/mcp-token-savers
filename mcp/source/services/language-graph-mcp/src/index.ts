#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getLanguageGraphConfig } from "./config.js";
import {
  buildLanguageGraphIndex,
  findReferences,
  findSymbol,
  getBlastRadius,
  getFileOutline,
  getGraphStatus,
  getImportNeighbors,
  graphArgs,
} from "./graph.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { clampText, stableHash } from "./text-utils.js";

const config = getLanguageGraphConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, code, secrets, file bodies, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
  },
};

const TOOLS: Tool[] = [
  {
    name: "index_repo",
    description:
      "Build or refresh a local structural language graph for a repo. Stores only symbols/imports/references metadata, never file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        max_files: { type: "number", description: "Optional file cap. Defaults to service config." },
        max_file_bytes: { type: "number", description: "Optional per-file byte cap. Defaults to service config." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "get_graph_status",
    description: "Return local graph freshness and aggregate counts. No paths or source bodies are returned.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "get_file_outline",
    description: "Return symbols, imports, and importers for one indexed file. Read exact files before editing.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        file_path: { type: "string", description: "Repo-relative or absolute local file path. Logged only as hash." },
        auto_index: { type: "boolean", description: "Build index if missing. Defaults false to avoid surprise large scans." },
        refresh: { type: "boolean", description: "Refresh index before lookup." },
        metadata: METADATA_SCHEMA,
      },
      required: ["file_path"],
    },
  },
  {
    name: "find_symbol",
    description: "Find symbol definitions by name/query across the local graph.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        symbol_name: { type: "string", description: "Symbol name or substring. Logged only as hash." },
        query: { type: "string", description: "Alias for symbol_name. Logged only as hash." },
        auto_index: { type: "boolean", description: "Build index if missing. Defaults false to avoid surprise large scans." },
        max_results: { type: "number" },
        refresh: { type: "boolean", description: "Refresh index before lookup." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "find_references",
    description: "Find files and line numbers referencing a local symbol. Does not return source line text.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        symbol_name: { type: "string", description: "Symbol name. Logged only as hash." },
        auto_index: { type: "boolean", description: "Build index if missing. Defaults false to avoid surprise large scans." },
        max_results: { type: "number" },
        refresh: { type: "boolean", description: "Refresh index before lookup." },
        metadata: METADATA_SCHEMA,
      },
      required: ["symbol_name"],
    },
  },
  {
    name: "get_import_neighbors",
    description: "Return imports from a file and files importing it, using best-effort local import resolution.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        file_path: { type: "string", description: "Repo-relative or absolute local file path. Logged only as hash." },
        auto_index: { type: "boolean", description: "Build index if missing. Defaults false to avoid surprise large scans." },
        max_results: { type: "number" },
        refresh: { type: "boolean", description: "Refresh index before lookup." },
        metadata: METADATA_SCHEMA,
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_blast_radius",
    description:
      "Return a compact local impact set for a file or symbol based on importers and references. Use before broad edits.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string", description: "Local repo root. Not logged raw." },
        file_path: { type: "string", description: "Repo-relative or absolute local file path. Logged only as hash." },
        symbol_name: { type: "string", description: "Symbol name. Logged only as hash." },
        auto_index: { type: "boolean", description: "Build index if missing. Defaults false to avoid surprise large scans." },
        max_results: { type: "number" },
        refresh: { type: "boolean", description: "Refresh index before lookup." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by language-graph-mcp.",
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
    description: "Return local language-graph usage, quality counters, token-savings, and Pantheon-safe aggregate export.",
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

function asArgs(args: unknown): Record<string, unknown> {
  return graphArgs(args);
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
      artifact_file: typeof args.artifact_url_or_file === "string" ? artifactFileName(args.artifact_url_or_file) : undefined,
      max_chars: args.max_chars,
    };
  }
  return {
    repo_root_hash: typeof args.repo_root === "string" ? stableHash(args.repo_root) : undefined,
    file_path_hash: typeof args.file_path === "string" ? stableHash(args.file_path) : undefined,
    symbol_name_hash: typeof args.symbol_name === "string" ? stableHash(args.symbol_name) : undefined,
    query_hash: typeof args.query === "string" ? stableHash(args.query) : undefined,
    max_files: args.max_files,
    max_file_bytes: args.max_file_bytes,
    max_results: args.max_results,
    auto_index: args.auto_index === true,
    refresh: args.refresh === true,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status || "ok",
    files_indexed: result?.files_indexed || 0,
    symbols_indexed: result?.symbols_indexed || 0,
    imports_indexed: result?.imports_indexed || 0,
    dynamic_imports_indexed: result?.dynamic_imports_indexed || 0,
    references_indexed: result?.references_indexed || 0,
    stale_files: result?.stale_files || 0,
    symbol_count: result?.symbol_count || 0,
    import_count: result?.import_count || 0,
    importer_count: result?.importer_count || 0,
    result_count: result?.result_count || 0,
    references_returned: result?.references_returned || 0,
    blast_radius_files: result?.blast_radius_files || 0,
    raw_tokens_estimate: result?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || 0,
    artifact_file: result?.artifact_file,
    safe_for_pantheon: result?.pantheon_export?.safe_for_pantheon || result?.safe_for_pantheon,
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

async function audited(tool: string, args: Record<string, unknown>, fn: () => Promise<any>) {
  const started = Date.now();
  try {
    const result = await fn();
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

const server = new Server(
  {
    name: "language-graph-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = asArgs(request.params.arguments);

  try {
    if (name === "index_repo") {
      const result = await audited(name, args, () => buildLanguageGraphIndex(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_graph_status") {
      const result = await audited(name, args, () => getGraphStatus(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_file_outline") {
      const result = await audited(name, args, () => getFileOutline(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "find_symbol") {
      const result = await audited(name, args, () => findSymbol(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "find_references") {
      const result = await audited(name, args, () => findReferences(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_import_neighbors") {
      const result = await audited(name, args, () => getImportNeighbors(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_blast_radius") {
      const result = await audited(name, args, () => getBlastRadius(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_artifact") {
      const result = await audited(name, args, async () => {
        const raw = typeof args.artifact_url_or_file === "string" ? args.artifact_url_or_file : "";
        const file = artifactFileName(raw);
        const artifact = await readArtifact(config, file);
        if (!artifact) {
          throw new Error(`artifact not found: ${file}`);
        }
        const maxChars = typeof args.max_chars === "number" && args.max_chars > 0 ? Math.min(args.max_chars, config.maxArtifactChars) : 20_000;
        return {
          schema_version: "language-graph-artifact.v1",
          artifact_file: file,
          content: clampText(artifact.toString("utf8"), maxChars),
        };
      });
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "get_measurement_report") {
      const result = await audited(name, args, () =>
        buildMeasurementReport(config, {
          date: typeof args.date === "string" ? args.date : undefined,
          since_iso: typeof args.since_iso === "string" ? args.since_iso : undefined,
          until_iso: typeof args.until_iso === "string" ? args.until_iso : undefined,
        }),
      );
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    return toolError(`Error running ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
