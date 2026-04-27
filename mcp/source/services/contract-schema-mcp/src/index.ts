#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getContractSchemaConfig } from "./config.js";
import {
  ContractArgs,
  createContractSnapshot,
  diffContracts,
  indexEnvContracts,
  indexOpenApi,
  indexZod,
  summarizeBreakingChanges,
  validatePayloadSample,
} from "./contracts.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getContractSchemaConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, code bodies, env values, payload bodies, secrets, or long notes.",
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
  max_files: { type: "number", description: "Maximum files to scan." },
  max_file_bytes: { type: "number", description: "Maximum file size scanned." },
  max_findings: { type: "number", description: "Maximum returned findings." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "index_openapi",
    description: "Index local OpenAPI/Swagger JSON/YAML files into compact operation and schema facts.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        openapi_paths: { type: "array", items: { type: "string" }, description: "Optional repo-relative OpenAPI files." },
      },
    },
  },
  {
    name: "index_zod",
    description: "Index local Zod object schemas from TS/JS files using dependency-light structural parsing.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        zod_paths: { type: "array", items: { type: "string" }, description: "Optional repo-relative Zod files." },
      },
    },
  },
  {
    name: "index_env_contracts",
    description: "Index .env.example-style declarations and process.env usages without reading secret values.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        env_paths: { type: "array", items: { type: "string" }, description: "Optional repo-relative env/code files." },
      },
    },
  },
  {
    name: "create_contract_snapshot",
    description: "Create a local aggregate OpenAPI/Zod/env contract snapshot for later diffing.",
    inputSchema: { type: "object", properties: COMMON_PROPS },
  },
  {
    name: "diff_contracts",
    description: "Compare baseline/current contract snapshots and report removed operations, required fields, and env declarations.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        baseline: { type: "object" },
        baseline_artifact_file: { type: "string" },
        current: { type: "object" },
      },
    },
  },
  {
    name: "validate_payload_sample",
    description: "Validate a payload sample against a JSON Schema object using local AJV. Logs only hashes/counts.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        schema: { type: "object" },
        payload_sample: {},
      },
      required: ["schema", "payload_sample"],
    },
  },
  {
    name: "summarize_breaking_changes",
    description: "Convert contract diff facts into an advisory migration/review checklist.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        baseline: { type: "object" },
        baseline_artifact_file: { type: "string" },
        current: { type: "object" },
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by contract-schema-mcp.",
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
    description: "Return local contract-schema usage, quality counters, token-savings, and Pantheon-safe export.",
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

function asContractArgs(args: Record<string, unknown>): ContractArgs {
  return {
    baseline: args.baseline,
    baseline_artifact_file: typeof args.baseline_artifact_file === "string" ? args.baseline_artifact_file : undefined,
    current: args.current,
    env_paths: stringArray(args.env_paths),
    max_file_bytes: typeof args.max_file_bytes === "number" ? args.max_file_bytes : undefined,
    max_files: typeof args.max_files === "number" ? args.max_files : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    metadata: args.metadata,
    openapi_paths: stringArray(args.openapi_paths),
    payload_sample: args.payload_sample,
    repo_root: typeof args.repo_root === "string" ? args.repo_root : undefined,
    schema: args.schema,
    schema_name: typeof args.schema_name === "string" ? args.schema_name : undefined,
    schema_path: typeof args.schema_path === "string" ? args.schema_path : undefined,
    zod_paths: stringArray(args.zod_paths),
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
    openapi_paths_count: Array.isArray(args.openapi_paths) ? args.openapi_paths.length : 0,
    zod_paths_count: Array.isArray(args.zod_paths) ? args.zod_paths.length : 0,
    env_paths_count: Array.isArray(args.env_paths) ? args.env_paths.length : 0,
    max_files: args.max_files,
    max_file_bytes: args.max_file_bytes,
    max_findings: args.max_findings,
    baseline_hash: args.baseline ? stableHash(JSON.stringify(args.baseline)) : undefined,
    baseline_artifact_file: typeof args.baseline_artifact_file === "string" ? artifactFileName(args.baseline_artifact_file) : undefined,
    current_hash: args.current ? stableHash(JSON.stringify(args.current)) : undefined,
    schema_hash: args.schema ? stableHash(JSON.stringify(args.schema)) : undefined,
    payload_hash: args.payload_sample ? stableHash(JSON.stringify(args.payload_sample)) : undefined,
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
    breaking_changes_count: result?.breaking_changes_count || 0,
    contract_snapshots: result?.contract_snapshots || 0,
    diff_removed_env_vars: result?.diff_removed_env_vars || 0,
    diff_removed_operations: result?.diff_removed_operations || 0,
    diff_removed_schema_fields: result?.diff_removed_schema_fields || 0,
    env_declared_count: result?.env_declared_count || 0,
    env_used_count: result?.env_used_count || 0,
    missing_env_examples_count: result?.missing_env_examples_count || 0,
    openapi_files_count: result?.openapi_files_count || 0,
    operations_count: result?.operations_count || 0,
    payload_validation_failures: result?.payload_validation_failures || 0,
    schemas_count: result?.schemas_count || 0,
    unused_env_declared_count: result?.unused_env_declared_count || 0,
    validation_errors_count: result?.validation_errors_count || 0,
    zod_embedded_schemas_count: result?.zod_embedded_schemas_count || 0,
    zod_fields_count: result?.zod_fields_count || 0,
    zod_files_count: result?.zod_files_count || 0,
    zod_schemas_count: result?.zod_schemas_count || 0,
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
      case "index_openapi":
        result = await indexOpenApi(config, asContractArgs(args));
        break;
      case "index_zod":
        result = await indexZod(config, asContractArgs(args));
        break;
      case "index_env_contracts":
        result = await indexEnvContracts(config, asContractArgs(args));
        break;
      case "create_contract_snapshot":
        result = await createContractSnapshot(config, asContractArgs(args));
        break;
      case "diff_contracts":
        result = await diffContracts(config, asContractArgs(args));
        break;
      case "validate_payload_sample":
        result = await validatePayloadSample(config, asContractArgs(args));
        break;
      case "summarize_breaking_changes":
        result = await summarizeBreakingChanges(config, asContractArgs(args));
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
    name: "hwai-contract-schema-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use contract-schema tools for local advisory contract/schema/env drift evidence. Do not edit contracts from compact output alone; read exact files first.",
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
  console.error("HWAI Contract Schema MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Contract Schema MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
