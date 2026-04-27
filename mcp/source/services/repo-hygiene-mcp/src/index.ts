#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getRepoHygieneConfig } from "./config.js";
import {
  HygieneArgs,
  proposeCleanupPlan,
  scanComplexityHotspots,
  scanDependencyCycles,
  scanDuplicateCode,
  scanUnusedCode,
  scanUnusedDependencies,
} from "./hygiene.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getRepoHygieneConfig();

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

const COMMON_SCAN_PROPS = {
  include_imported_templates: {
    type: "boolean",
    description:
      "Include imported seed skill/template files under templates/hwai_internal_seed/skills/imported. Defaults false so maintained-repo cleanup is not mixed with vendored template debt.",
  },
  repo_root: { type: "string", description: "Local repo root. Not logged raw." },
  max_files: { type: "number", description: "Maximum files to scan. Defaults to service config." },
  max_file_bytes: { type: "number", description: "Maximum file size scanned. Defaults to service config." },
  max_findings: { type: "number", description: "Maximum returned findings. Defaults to service config." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "scan_unused_code",
    description:
      "Find advisory unused export candidates by local reference count. No auto-delete; agents must inspect exact files before edits.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "scan_unused_dependencies",
    description:
      "Find advisory package dependency cleanup candidates from local package.json plus import/require usage. No auto-delete.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "scan_duplicate_code",
    description:
      "Find duplicate normalized code blocks across local source files without returning block text.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_SCAN_PROPS,
        block_lines: { type: "number", description: "Normalized lines per duplicate block. Defaults to service config." },
      },
    },
  },
  {
    name: "scan_dependency_cycles",
    description: "Find relative JS/TS import cycles as local advisory cleanup evidence.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "scan_complexity_hotspots",
    description: "Rank local complexity hotspots by simple lines/functions/branch/import heuristics.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "propose_cleanup_plan",
    description:
      "Combine repo hygiene scans into a reviewed cleanup plan. Advisory only; no files are changed, moved, or deleted.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_SCAN_PROPS,
        block_lines: { type: "number", description: "Normalized lines per duplicate block. Defaults to service config." },
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by repo-hygiene-mcp.",
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
    description: "Return local repo-hygiene usage, cleanup quality counters, token-savings, and Pantheon-safe aggregate export.",
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

function asHygieneArgs(args: Record<string, unknown>): HygieneArgs {
  return {
    block_lines: typeof args.block_lines === "number" ? args.block_lines : undefined,
    include_imported_templates: args.include_imported_templates === true ? true : undefined,
    max_file_bytes: typeof args.max_file_bytes === "number" ? args.max_file_bytes : undefined,
    max_files: typeof args.max_files === "number" ? args.max_files : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    metadata: args.metadata,
    repo_root: typeof args.repo_root === "string" ? args.repo_root : undefined,
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
    max_files: args.max_files,
    max_file_bytes: args.max_file_bytes,
    max_findings: args.max_findings,
    block_lines: args.block_lines,
    include_imported_templates: args.include_imported_templates,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status || "ok",
    scanned_files: result?.scanned_files || 0,
    code_files: result?.code_files || 0,
    package_files: result?.package_files || 0,
    dependencies_total: result?.dependencies_total || 0,
    dynamic_imports_seen: result?.dynamic_imports_seen || 0,
    candidates_count: result?.candidates_count || 0,
    duplicate_groups: result?.duplicate_groups || 0,
    cycles_count: result?.cycles_count || 0,
    hotspots_count: result?.hotspots_count || 0,
    plan_items_count: result?.plan_items_count || 0,
    artifact_outputs: result?.artifact_file ? 1 : 0,
    artifact_file: result?.artifact_file,
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
      case "scan_unused_code":
        result = await scanUnusedCode(config, asHygieneArgs(args));
        break;
      case "scan_unused_dependencies":
        result = await scanUnusedDependencies(config, asHygieneArgs(args));
        break;
      case "scan_duplicate_code":
        result = await scanDuplicateCode(config, asHygieneArgs(args));
        break;
      case "scan_dependency_cycles":
        result = await scanDependencyCycles(config, asHygieneArgs(args));
        break;
      case "scan_complexity_hotspots":
        result = await scanComplexityHotspots(config, asHygieneArgs(args));
        break;
      case "propose_cleanup_plan":
        result = await proposeCleanupPlan(config, asHygieneArgs(args));
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
    return {
      content: [{ type: "text" as const, text: stringifyResult(result) }],
    };
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
    name: "hwai-repo-hygiene-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use repo-hygiene tools for local advisory cleanup evidence. Do not auto-delete. Agents must read exact files and run proof loops before edits.",
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
  console.error("HWAI Repo Hygiene MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Repo Hygiene MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
