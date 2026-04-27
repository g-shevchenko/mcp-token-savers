#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getDocsHygieneConfig } from "./config.js";
import {
  DocsArgs,
  checkDocFrontmatter,
  checkSsotConflicts,
  findBrokenAnchors,
  findBrokenLinks,
  findDuplicateSections,
  findOrphanDocs,
  findStaleCodeReferences,
  inventoryDocs,
  proposeDocMergeOrArchive,
} from "./docs.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getDocsHygieneConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, doc bodies, code, secrets, or long notes.",
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
      "Include imported seed skill/template docs under templates/hwai_internal_seed/skills/imported. Defaults false so SSOT reports are not mixed with vendored template debt.",
  },
  repo_root: { type: "string", description: "Local repo root. Not logged raw." },
  max_files: { type: "number", description: "Maximum docs to scan. Defaults to service config." },
  max_file_bytes: { type: "number", description: "Maximum doc size scanned. Defaults to service config." },
  max_findings: { type: "number", description: "Maximum returned findings. Defaults to service config." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "inventory_docs",
    description: "Inventory local Markdown/MDX docs, headings, line counts, large docs, and frontmatter gaps.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "find_broken_links",
    description: "Find relative Markdown links whose local file target does not exist.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "find_broken_anchors",
    description: "Find relative Markdown anchors that do not match a target document heading.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "find_orphan_docs",
    description: "Find docs with no inbound Markdown links from scanned docs. Advisory only; external links may exist.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "find_duplicate_sections",
    description: "Find exact normalized duplicate doc sections without returning section bodies.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_SCAN_PROPS,
        min_section_lines: { type: "number", description: "Minimum non-empty body lines per section." },
      },
    },
  },
  {
    name: "find_stale_code_references",
    description: "Find doc references to local code/doc paths that do not exist in this worktree.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "check_doc_frontmatter",
    description: "Find docs missing YAML frontmatter. Advisory only because root runbooks can intentionally omit it.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "check_ssot_conflicts",
    description: "Find possible external-surface SSOT/canonical claims that conflict with repo-markdown-as-SSOT policy.",
    inputSchema: { type: "object", properties: COMMON_SCAN_PROPS },
  },
  {
    name: "propose_doc_merge_or_archive",
    description:
      "Combine docs hygiene scans into a reviewed merge/archive plan. Advisory only; no docs are changed, moved, or deleted.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_SCAN_PROPS,
        min_section_lines: { type: "number", description: "Minimum non-empty body lines per duplicate section." },
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by docs-hygiene-mcp.",
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
    description: "Return local docs-hygiene usage, quality counters, token-savings, and Pantheon-safe aggregate export.",
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

function asDocsArgs(args: Record<string, unknown>): DocsArgs {
  return {
    include_imported_templates: args.include_imported_templates === true ? true : undefined,
    max_file_bytes: typeof args.max_file_bytes === "number" ? args.max_file_bytes : undefined,
    max_files: typeof args.max_files === "number" ? args.max_files : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    metadata: args.metadata,
    min_section_lines: typeof args.min_section_lines === "number" ? args.min_section_lines : undefined,
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
    include_imported_templates: args.include_imported_templates,
    min_section_lines: args.min_section_lines,
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
    broken_anchors_count: result?.broken_anchors_count || 0,
    broken_links_count: result?.broken_links_count || 0,
    doc_count: result?.doc_count || 0,
    doc_lines: result?.doc_lines || 0,
    duplicate_section_groups: result?.duplicate_section_groups || 0,
    frontmatter_missing_count: result?.frontmatter_missing_count || 0,
    large_docs_count: result?.large_docs_count || 0,
    orphan_docs_count: result?.orphan_docs_count || 0,
    plan_items_count: result?.plan_items_count || 0,
    ssot_conflicts_count: result?.ssot_conflicts_count || 0,
    stale_references_count: result?.stale_references_count || 0,
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
      case "inventory_docs":
        result = await inventoryDocs(config, asDocsArgs(args));
        break;
      case "find_broken_links":
        result = await findBrokenLinks(config, asDocsArgs(args));
        break;
      case "find_broken_anchors":
        result = await findBrokenAnchors(config, asDocsArgs(args));
        break;
      case "find_orphan_docs":
        result = await findOrphanDocs(config, asDocsArgs(args));
        break;
      case "find_duplicate_sections":
        result = await findDuplicateSections(config, asDocsArgs(args));
        break;
      case "find_stale_code_references":
        result = await findStaleCodeReferences(config, asDocsArgs(args));
        break;
      case "check_doc_frontmatter":
        result = await checkDocFrontmatter(config, asDocsArgs(args));
        break;
      case "check_ssot_conflicts":
        result = await checkSsotConflicts(config, asDocsArgs(args));
        break;
      case "propose_doc_merge_or_archive":
        result = await proposeDocMergeOrArchive(config, asDocsArgs(args));
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
    name: "hwai-docs-hygiene-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use docs-hygiene tools for local advisory documentation cleanup evidence. Repo markdown remains SSOT. Do not auto-delete or rewrite docs.",
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
  console.error("HWAI Docs Hygiene MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Docs Hygiene MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
