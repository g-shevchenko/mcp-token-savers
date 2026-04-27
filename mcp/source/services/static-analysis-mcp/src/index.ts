#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getStaticAnalysisConfig } from "./config.js";
import { appendRequestLog } from "./request-log.js";
import {
  AnalysisOptions,
  getCommandPolicy,
  runEslint,
  runGitleaks,
  runSemgrepLocal,
  runTestsChanged,
  runTsc,
  summarizeSarif,
} from "./analyzers.js";
import { buildMeasurementReport } from "./measurement.js";
import { clampText } from "./text-utils.js";

const config = getStaticAnalysisConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional sidecar metadata for attribution. Recommended fields: owner, project, surface, repo, branch, commit_sha, session_id, source.",
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

const COMMON_RUN_PROPS = {
  root_path: { type: "string", description: "Repo or package directory. Defaults to MCP cwd." },
  command: {
    type: "array",
    items: { type: "string" },
    description: "Optional explicit command argv. No shell is used.",
  },
  timeout_ms: { type: "number", description: "Command timeout. Default from STATIC_ANALYSIS_COMMAND_TIMEOUT_MS." },
  max_output_chars: { type: "number", description: "Maximum captured stdout/stderr characters. Default 120000." },
  command_policy_preset: {
    type: "string",
    description:
      "Optional command policy preset. Built-ins include auto, node-package, node-package-safe, and repo-safe. Local static-analysis.policy.json can define repo/package presets.",
  },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "get_command_policy",
    description:
      "Resolve local package/repo static-analysis command policy without running commands. Use before broad tests/lint/typecheck when the right command is unclear.",
    inputSchema: {
      type: "object",
      properties: {
        root_path: { type: "string", description: "Repo or package directory. Defaults to MCP cwd." },
        command_policy_preset: COMMON_RUN_PROPS.command_policy_preset,
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "run_tsc",
    description:
      "Run a local TypeScript check and return compact diagnostics. Uses package typecheck script or tsconfig.json when command is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPS,
        project: { type: "string", description: "Optional tsconfig path passed to tsc -p." },
      },
    },
  },
  {
    name: "run_eslint",
    description:
      "Run local ESLint when configured and return compact findings. Skips safely when no lint script or local eslint binary is found.",
    inputSchema: { type: "object", properties: COMMON_RUN_PROPS },
  },
  {
    name: "run_tests_changed",
    description:
      "Run a focused local test command and summarize failures. Prefer passing an explicit command for changed-file scopes.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPS,
        changed_files: {
          type: "array",
          items: { type: "string" },
          description: "Optional changed file list for metadata and future focused runners.",
        },
      },
    },
  },
  {
    name: "run_semgrep_local",
    description:
      "Run local semgrep if installed and return compact findings. No paid infra is used by this MCP; missing semgrep returns skipped.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPS,
        config: { type: "string", description: "Semgrep config. Default: auto." },
      },
    },
  },
  {
    name: "run_gitleaks",
    description:
      "Run local gitleaks if installed with redacted output and return compact secret finding counts. Missing gitleaks returns skipped.",
    inputSchema: { type: "object", properties: COMMON_RUN_PROPS },
  },
  {
    name: "summarize_sarif",
    description: "Summarize SARIF JSON into compact file/line/rule/severity findings.",
    inputSchema: {
      type: "object",
      properties: {
        root_path: { type: "string" },
        sarif_json: { type: "string" },
        sarif_path: { type: "string", description: "Local SARIF path relative to root_path." },
        max_findings: { type: "number", description: "Maximum findings returned. Default 100." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by static-analysis-mcp.",
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
    description: "Return local static-analysis usage, token-savings, finding counts, and Pantheon-safe aggregate export.",
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

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function asOptions(args: Record<string, unknown> | undefined): AnalysisOptions {
  return {
    changed_files: asStringArray(args?.changed_files),
    command: asStringArray(args?.command),
    command_policy_preset: asText(args?.command_policy_preset) || undefined,
    config: asText(args?.config) || undefined,
    max_output_chars: args?.max_output_chars as number | undefined,
    metadata: args?.metadata,
    project: asText(args?.project) || undefined,
    root_path: asText(args?.root_path) || undefined,
    timeout_ms: args?.timeout_ms as number | undefined,
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
  if (tool === "summarize_sarif") {
    return {
      sarif_json_chars: typeof args.sarif_json === "string" ? args.sarif_json.length : 0,
      sarif_path_provided: typeof args.sarif_path === "string",
      max_findings: args.max_findings,
      metadata_source: metadataSource(args),
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
  if (tool === "get_measurement_report") {
    return {
      date: args.date,
      since_iso: args.since_iso,
      until_iso: args.until_iso,
      metadata_source: metadataSource(args),
    };
  }
  return {
    command_argc: Array.isArray(args.command) ? args.command.length : 0,
    command_policy_preset: typeof args.command_policy_preset === "string" ? args.command_policy_preset : undefined,
    root_path_provided: typeof args.root_path === "string",
    timeout_ms: args.timeout_ms,
    max_output_chars: args.max_output_chars,
    changed_files_count: Array.isArray(args.changed_files) ? args.changed_files.length : 0,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status,
    exit_code: result?.exit_code,
    timed_out: result?.timed_out,
    findings_count: result?.finding_counts?.total,
    error_findings_count: result?.finding_counts?.errors,
    warning_findings_count: result?.finding_counts?.warnings,
    raw_tokens_estimate: result?.input_stats?.raw_tokens_estimate,
    compact_tokens_estimate: result?.input_stats?.compact_tokens_estimate,
    saved_tokens_estimate: result?.input_stats?.saved_tokens_estimate,
    savings_pct: result?.input_stats?.savings_pct,
    requires_frontier_review: result?.autopilot?.requires_frontier_review === true,
    command_policy_source: result?.command_policy?.source,
    command_policy_preset: result?.command_policy?.preset,
    command_policy_command_argc: result?.command_policy?.command_argc,
  };
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

function createStaticAnalysisServer(): Server {
  const server = new Server(
    { name: "hwai-static-analysis-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use static-analysis tools for deterministic local verification before frontier reasoning. Raw command output stays local; compact findings are triage evidence. Agents still read exact files before edits.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const recordArgs = args as Record<string, unknown> | undefined;

    try {
      if (name === "get_command_policy") {
        const result = await audited(name, recordArgs, async () => getCommandPolicy(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "run_tsc") {
        const result = await audited(name, recordArgs, async () => runTsc(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "run_eslint") {
        const result = await audited(name, recordArgs, async () => runEslint(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "run_tests_changed") {
        const result = await audited(name, recordArgs, async () => runTestsChanged(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "run_semgrep_local") {
        const result = await audited(name, recordArgs, async () => runSemgrepLocal(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "run_gitleaks") {
        const result = await audited(name, recordArgs, async () => runGitleaks(config, asOptions(recordArgs)));
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "summarize_sarif") {
        const result = await audited(name, recordArgs, async () =>
          summarizeSarif(config, {
            root_path: asText(recordArgs?.root_path) || undefined,
            sarif_json: asText(recordArgs?.sarif_json) || undefined,
            sarif_path: asText(recordArgs?.sarif_path) || undefined,
            max_findings: recordArgs?.max_findings as number | undefined,
          }),
        );
        return { content: [{ type: "text" as const, text: stringifyResult(result) }] };
      }
      if (name === "get_artifact") {
        const raw = asText(recordArgs?.artifact_url_or_file);
        if (!raw) {
          return toolError("Error: artifact_url_or_file is required");
        }
        const maxChars = (recordArgs?.max_chars as number) || 20_000;
        const artifact = await audited(name, recordArgs, async () => readArtifact(config, artifactFileName(raw)));
        if (!artifact) {
          return toolError("Error: artifact not found");
        }
        return { content: [{ type: "text" as const, text: clampText(artifact.toString("utf8"), maxChars) }] };
      }
      if (name === "get_measurement_report") {
        const result = await audited(name, recordArgs, async () =>
          buildMeasurementReport(config, {
            date: asText(recordArgs?.date) || undefined,
            since_iso: asText(recordArgs?.since_iso) || undefined,
            until_iso: asText(recordArgs?.until_iso) || undefined,
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

const server = createStaticAnalysisServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HWAI Static Analysis MCP Server running on stdio");
