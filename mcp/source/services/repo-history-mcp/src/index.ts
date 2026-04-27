#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getRepoHistoryConfig } from "./config.js";
import { appendRequestLog } from "./request-log.js";
import { buildMeasurementReport } from "./measurement.js";
import {
  findCochangeFiles,
  findChangeHotspots,
  searchCommits,
  summarizeBlame,
  summarizeDiffStat,
  summarizeFileHistory,
  summarizeRecentCommits,
} from "./history.js";
import { clampText, stableHash } from "./text-utils.js";

const config = getRepoHistoryConfig();

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

const COMMON_HISTORY_PROPS = {
  repo_root: { type: "string", description: "Optional local repo root. Defaults to MCP process cwd git root." },
  paths: { type: "array", items: { type: "string" }, description: "Optional relative repo paths to constrain history." },
  since_ref: { type: "string", description: "Optional base ref, for example origin/main or HEAD~20." },
  until_ref: { type: "string", description: "Optional end ref. Defaults to HEAD." },
  max_commits: { type: "number", description: "Maximum commits to inspect." },
  max_files: { type: "number", description: "Maximum file rows to return." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "summarize_recent_commits",
    description: "Summarize recent git commits as compact metadata. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_HISTORY_PROPS,
        include_changed_files: { type: "boolean", description: "Include name-status file lists. Defaults true." },
      },
    },
  },
  {
    name: "search_commits",
    description: "Search commit subjects/messages and return compact local history hits. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_HISTORY_PROPS,
        query: { type: "string", description: "Commit-message search string. Hashed in request logs and output." },
      },
      required: ["query"],
    },
  },
  {
    name: "summarize_file_history",
    description: "Summarize commit history for one file with --follow. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: COMMON_HISTORY_PROPS.repo_root,
        file_path: { type: "string", description: "Relative repo path to inspect." },
        max_commits: COMMON_HISTORY_PROPS.max_commits,
        metadata: METADATA_SCHEMA,
      },
      required: ["file_path"],
    },
  },
  {
    name: "summarize_blame",
    description: "Summarize git blame authorship for a file or line range. No source lines, raw diffs, or file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: COMMON_HISTORY_PROPS.repo_root,
        file_path: { type: "string", description: "Relative repo path to inspect." },
        start_line: { type: "number", description: "Optional 1-based start line." },
        end_line: { type: "number", description: "Optional 1-based end line." },
        max_authors: { type: "number", description: "Maximum authors to return." },
        max_commits: COMMON_HISTORY_PROPS.max_commits,
        metadata: METADATA_SCHEMA,
      },
      required: ["file_path"],
    },
  },
  {
    name: "summarize_diff_stat",
    description: "Summarize name-status and shortstat for a git range. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: COMMON_HISTORY_PROPS.repo_root,
        base_ref: { type: "string", description: "Base ref. Defaults HEAD~1." },
        head_ref: { type: "string", description: "Head ref. Defaults HEAD." },
        paths: COMMON_HISTORY_PROPS.paths,
        max_files: COMMON_HISTORY_PROPS.max_files,
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "find_change_hotspots",
    description: "Count frequently touched files over a git history window. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: COMMON_HISTORY_PROPS,
    },
  },
  {
    name: "find_cochange_files",
    description: "Find files commonly changed with target paths. No raw diffs or file bodies.",
    inputSchema: {
      type: "object",
      properties: COMMON_HISTORY_PROPS,
      required: ["paths"],
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by repo-history-mcp.",
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
    description: "Return local repo-history usage, quality, token-savings, and Pantheon-safe aggregate export.",
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
    repo_root_provided: typeof args.repo_root === "string",
    repo_root_hash: typeof args.repo_root === "string" ? stableHash(args.repo_root) : undefined,
    path_count: Array.isArray(args.paths) ? args.paths.length : undefined,
    file_path_hash: typeof args.file_path === "string" ? stableHash(args.file_path) : undefined,
    query_hash: typeof args.query === "string" ? stableHash(args.query) : undefined,
    since_ref_provided: typeof args.since_ref === "string",
    until_ref_provided: typeof args.until_ref === "string",
    base_ref_provided: typeof args.base_ref === "string",
    head_ref_provided: typeof args.head_ref === "string",
    max_commits: args.max_commits,
    max_files: args.max_files,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status || "ok",
    commits_returned: result?.commits_returned || 0,
    authors_returned: result?.authors_returned || 0,
    cochange_files_returned: result?.cochange_files_returned || 0,
    files_returned: result?.files_returned || 0,
    hotspots_returned: Array.isArray(result?.hotspots) ? result.hotspots.length : 0,
    search_results_returned: result?.search_results_returned || 0,
    artifact_file: result?.artifact_file,
    raw_tokens_estimate: result?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || 0,
    savings_pct: result?.savings_pct || 0,
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

function createRepoHistoryServer(): Server {
  const server = new Server(
    { name: "hwai-repo-history-mcp", version: "1.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use repo-history tools to get compact local git-history evidence before repo reasoning. Do not request raw diffs, file bodies, secrets, or long logs. Pantheon export is aggregate-only.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = asArgs(rawArgs);

    try {
      if (name === "summarize_recent_commits") {
        const result = await audited(name, args, async () => summarizeRecentCommits(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "search_commits") {
        const result = await audited(name, args, async () => searchCommits(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_file_history") {
        const result = await audited(name, args, async () => summarizeFileHistory(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_blame") {
        const result = await audited(name, args, async () => summarizeBlame(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_diff_stat") {
        const result = await audited(name, args, async () => summarizeDiffStat(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "find_change_hotspots") {
        const result = await audited(name, args, async () => findChangeHotspots(config, args));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "find_cochange_files") {
        const result = await audited(name, args, async () => findCochangeFiles(config, args));
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

const server = createRepoHistoryServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HWAI Repo History MCP Server running on stdio");
