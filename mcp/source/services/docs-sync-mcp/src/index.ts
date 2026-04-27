#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getDocsSyncConfig } from "./config.js";
import {
  DocsSyncArgs,
  checkDocRegistry,
  compareRepoNotionMirror,
  extractRepoActions,
  findStaleNotionMirrors,
  proposeNotionUpdate,
} from "./docs-sync.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getDocsSyncConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, doc bodies, Notion content, Notion URLs, secrets, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
  },
};

const COMMON_PROPS = {
  repo_root: { type: "string", description: "Local repo root. Not logged raw." },
  doc_roots: { type: "array", items: { type: "string" }, description: "Repo-relative doc roots to scan." },
  source_paths: { type: "array", items: { type: "string" }, description: "Optional exact repo-relative docs to scan." },
  mirror_manifest_path: { type: "string", description: "Repo-relative local Notion mirror manifest JSON." },
  mirror_manifest: { type: "object", description: "Local mirror manifest object." },
  max_docs: { type: "number" },
  max_doc_bytes: { type: "number" },
  max_findings: { type: "number" },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "compare_repo_notion_mirror",
    description: "Compare repo Markdown SSOT docs with a local Notion mirror manifest.",
    inputSchema: { type: "object", properties: COMMON_PROPS },
  },
  {
    name: "find_stale_notion_mirrors",
    description: "Return stale/missing Notion mirror evidence from a local mirror manifest.",
    inputSchema: { type: "object", properties: COMMON_PROPS },
  },
  {
    name: "extract_repo_actions",
    description: "Extract repo action markers without returning raw doc bodies.",
    inputSchema: { type: "object", properties: COMMON_PROPS },
  },
  {
    name: "propose_notion_update",
    description: "Create an advisory Notion update plan. Does not write to Notion.",
    inputSchema: { type: "object", properties: COMMON_PROPS },
  },
  {
    name: "check_doc_registry",
    description: "Compare repo docs with a repo doc registry JSON/Markdown file.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        doc_registry_path: { type: "string" },
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by docs-sync-mcp.",
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
    description: "Return local docs-sync usage, quality counters, token-savings, and Pantheon-safe export.",
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
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function asDocsSyncArgs(args: Record<string, unknown>): DocsSyncArgs {
  return {
    doc_registry_path: typeof args.doc_registry_path === "string" ? args.doc_registry_path : undefined,
    doc_roots: stringArray(args.doc_roots),
    max_doc_bytes: typeof args.max_doc_bytes === "number" ? args.max_doc_bytes : undefined,
    max_docs: typeof args.max_docs === "number" ? args.max_docs : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    metadata: args.metadata,
    mirror_manifest: args.mirror_manifest,
    mirror_manifest_path: typeof args.mirror_manifest_path === "string" ? args.mirror_manifest_path : undefined,
    repo_root: typeof args.repo_root === "string" ? args.repo_root : undefined,
    source_paths: stringArray(args.source_paths),
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
      artifact_file: typeof args.artifact_url_or_file === "string" ? artifactFileName(args.artifact_url_or_file) : undefined,
      max_chars: args.max_chars,
    };
  }
  return {
    repo_root_hash: typeof args.repo_root === "string" ? stableHash(args.repo_root) : undefined,
    doc_roots_count: Array.isArray(args.doc_roots) ? args.doc_roots.length : 0,
    source_paths_count: Array.isArray(args.source_paths) ? args.source_paths.length : 0,
    mirror_manifest_path_hash: typeof args.mirror_manifest_path === "string" ? stableHash(args.mirror_manifest_path) : undefined,
    mirror_manifest_hash: args.mirror_manifest ? stableHash(JSON.stringify(args.mirror_manifest)) : undefined,
    doc_registry_path_hash: typeof args.doc_registry_path === "string" ? stableHash(args.doc_registry_path) : undefined,
    max_docs: args.max_docs,
    max_doc_bytes: args.max_doc_bytes,
    max_findings: args.max_findings,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status || "ok",
    artifact_outputs: result?.artifact_file ? 1 : 0,
    artifact_file: result?.artifact_file,
    action_docs_count: result?.action_docs_count || 0,
    action_items_count: result?.action_items_count || 0,
    doc_count: result?.doc_count || 0,
    mirror_count: result?.mirror_count || 0,
    missing_mirror_count: result?.missing_mirror_count || 0,
    missing_registry_entries_count: result?.missing_registry_entries_count || 0,
    missing_source_count: result?.missing_source_count || 0,
    scanned_docs_count: result?.scanned_docs_count || 0,
    stale_mirrors_count: result?.stale_mirrors_count || 0,
    stale_registry_entries_count: result?.stale_registry_entries_count || 0,
    synced_mirror_count: result?.synced_mirror_count || 0,
    title_mismatch_count: result?.title_mismatch_count || 0,
    update_candidates_count: result?.update_candidates_count || 0,
    raw_tokens_estimate: result?.raw_tokens_estimate || result?.token_savings?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || result?.token_savings?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || result?.token_savings?.saved_tokens_estimate || 0,
    savings_pct: result?.savings_pct || result?.token_savings?.savings_pct || 0,
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

async function runTool(name: string, rawArgs: unknown) {
  const args = asArgs(rawArgs);
  const started = Date.now();
  try {
    let result: unknown;
    switch (name) {
      case "compare_repo_notion_mirror":
        result = await compareRepoNotionMirror(config, asDocsSyncArgs(args));
        break;
      case "find_stale_notion_mirrors":
        result = await findStaleNotionMirrors(config, asDocsSyncArgs(args));
        break;
      case "extract_repo_actions":
        result = await extractRepoActions(config, asDocsSyncArgs(args));
        break;
      case "propose_notion_update":
        result = await proposeNotionUpdate(config, asDocsSyncArgs(args));
        break;
      case "check_doc_registry":
        result = await checkDocRegistry(config, asDocsSyncArgs(args));
        break;
      case "get_artifact":
        if (typeof args.artifact_url_or_file !== "string") {
          throw new Error("artifact_url_or_file is required");
        }
        result = await readArtifact(config, args.artifact_url_or_file, args.max_chars as number | undefined);
        break;
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
      input: summarizeInput(name, args),
      ok: true,
      output: summarizeOutput(result),
      tool: name,
      transport: "mcp",
    });
    return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendRequestLog(config, {
      duration_ms: Date.now() - started,
      error: message,
      input: summarizeInput(name, args),
      ok: false,
      tool: name,
      transport: "mcp",
    });
    return toolError(message);
  }
}

const server = new Server(
  {
    name: "hwai-docs-sync-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use docs-sync tools for local advisory repo SSOT versus Notion mirror evidence. Do not write Notion from compact output; read exact docs first.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return runTool(name, args);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HWAI Docs Sync MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Docs Sync MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
