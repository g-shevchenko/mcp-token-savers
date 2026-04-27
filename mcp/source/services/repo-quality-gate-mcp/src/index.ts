#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getRepoQualityGateConfig } from "./config.js";
import {
  GateArgs,
  checkContextBudget,
  checkNewCodeBudget,
  checkNewDocsBudget,
  compareQualitySnapshot,
  createQualitySnapshot,
  proposeQualityGatePlan,
} from "./gate.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getRepoQualityGateConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, code/doc bodies, secrets, or long notes.",
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
  base_ref: { type: "string", description: "Git base ref. Defaults to origin/main when available, then HEAD." },
  max_files: { type: "number", description: "Maximum files to scan." },
  max_findings: { type: "number", description: "Maximum returned findings." },
  metadata: METADATA_SCHEMA,
};

const BUDGET_PROPS = {
  max_added_code_lines: { type: "number" },
  max_added_doc_lines: { type: "number" },
  max_changed_code_files: { type: "number" },
  max_changed_doc_files: { type: "number" },
  max_context_pressure_score: { type: "number" },
  max_large_docs: { type: "number" },
  large_doc_lines: { type: "number" },
  include_generated: { type: "boolean", description: "Include generated-like files in new-work budgets. Defaults false." },
  include_imported_templates: {
    type: "boolean",
    description:
      "Include imported seed skill/template files under templates/hwai_internal_seed/skills/imported. Defaults false so maintained-repo quality budgets are not mixed with vendored template debt.",
  },
};

const TOOLS: Tool[] = [
  {
    name: "check_new_code_budget",
    description: "Advisory check for changed/untracked code file and added-line budgets versus a git base ref.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS, ...BUDGET_PROPS } },
  },
  {
    name: "check_new_docs_budget",
    description: "Advisory check for changed/untracked docs, added doc lines, large docs, and frontmatter gaps.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS, ...BUDGET_PROPS } },
  },
  {
    name: "check_context_budget",
    description: "Scan repo context pressure: docs/code lines, large docs, generated-like files, and pressure score.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS, ...BUDGET_PROPS } },
  },
  {
    name: "create_quality_snapshot",
    description: "Create a local aggregate snapshot of repo size/context pressure without code or doc bodies.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS, ...BUDGET_PROPS } },
  },
  {
    name: "compare_quality_snapshot",
    description: "Compare current aggregate snapshot with a prior snapshot object or local artifact.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        ...BUDGET_PROPS,
        baseline_artifact_file: { type: "string" },
        baseline: { type: "object" },
      },
    },
  },
  {
    name: "propose_quality_gate_plan",
    description:
      "Combine advisory code/docs/context budgets into a clean-new-work review plan. Never blocks by itself.",
    inputSchema: { type: "object", properties: { ...COMMON_PROPS, ...BUDGET_PROPS } },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by repo-quality-gate-mcp.",
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
    description: "Return local repo-quality-gate usage, quality counters, token-savings, and Pantheon-safe export.",
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

function asGateArgs(args: Record<string, unknown>): GateArgs {
  return {
    base_ref: typeof args.base_ref === "string" ? args.base_ref : undefined,
    baseline: args.baseline,
    baseline_artifact_file: typeof args.baseline_artifact_file === "string" ? args.baseline_artifact_file : undefined,
    include_generated: typeof args.include_generated === "boolean" ? args.include_generated : undefined,
    include_imported_templates: args.include_imported_templates === true ? true : undefined,
    large_doc_lines: typeof args.large_doc_lines === "number" ? args.large_doc_lines : undefined,
    max_added_code_lines: typeof args.max_added_code_lines === "number" ? args.max_added_code_lines : undefined,
    max_added_doc_lines: typeof args.max_added_doc_lines === "number" ? args.max_added_doc_lines : undefined,
    max_changed_code_files: typeof args.max_changed_code_files === "number" ? args.max_changed_code_files : undefined,
    max_changed_doc_files: typeof args.max_changed_doc_files === "number" ? args.max_changed_doc_files : undefined,
    max_context_pressure_score: typeof args.max_context_pressure_score === "number" ? args.max_context_pressure_score : undefined,
    max_files: typeof args.max_files === "number" ? args.max_files : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    max_large_docs: typeof args.max_large_docs === "number" ? args.max_large_docs : undefined,
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
    base_ref_hash: typeof args.base_ref === "string" ? stableHash(args.base_ref) : undefined,
    max_files: args.max_files,
    max_findings: args.max_findings,
    max_added_code_lines: args.max_added_code_lines,
    max_added_doc_lines: args.max_added_doc_lines,
    max_changed_code_files: args.max_changed_code_files,
    max_changed_doc_files: args.max_changed_doc_files,
    max_context_pressure_score: args.max_context_pressure_score,
    max_large_docs: args.max_large_docs,
    large_doc_lines: args.large_doc_lines,
    include_generated: args.include_generated,
    include_imported_templates: args.include_imported_templates,
    baseline_hash: args.baseline ? stableHash(JSON.stringify(args.baseline)) : undefined,
    baseline_artifact_file: typeof args.baseline_artifact_file === "string" ? artifactFileName(args.baseline_artifact_file) : undefined,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  const snapshot = result?.snapshot || {};
  return {
    status: result?.status || "ok",
    artifact_outputs: result?.artifact_file ? 1 : 0,
    artifact_file: result?.artifact_file,
    added_code_lines: result?.added_code_lines || result?.summary?.added_code_lines || 0,
    added_doc_lines: result?.added_doc_lines || result?.summary?.added_doc_lines || 0,
    budget_checks: String(result?.tool_kind || "").includes("budget") ? 1 : 0,
    changed_code_files: result?.changed_code_files || 0,
    changed_doc_files: result?.changed_doc_files || 0,
    changed_files: result?.changed_files || result?.summary?.changed_files || 0,
    context_pressure_score: result?.context_pressure_score || result?.summary?.context_pressure_score || snapshot.context_pressure_score || 0,
    frontmatter_missing_count: result?.frontmatter_missing_count || 0,
    growth_findings_count: result?.growth_findings_count || 0,
    large_docs_count: result?.large_docs_count || snapshot.large_docs_count || 0,
    over_budget_count: result?.over_budget_count || result?.summary?.over_budget_count || 0,
    plan_items_count: result?.plan_items_count || 0,
    scan_truncated_count: result?.scan_truncated || snapshot.scan_truncated ? 1 : 0,
    snapshot_code_lines: snapshot.code_lines || result?.code_lines || 0,
    snapshot_candidate_files_seen: snapshot.candidate_files_seen || result?.candidate_files_seen || 0,
    snapshot_doc_lines: snapshot.doc_lines || result?.doc_lines || 0,
    snapshot_files: snapshot.scanned_files || result?.scanned_files || 0,
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
      case "check_new_code_budget":
        result = await checkNewCodeBudget(config, asGateArgs(args));
        break;
      case "check_new_docs_budget":
        result = await checkNewDocsBudget(config, asGateArgs(args));
        break;
      case "check_context_budget":
        result = await checkContextBudget(config, asGateArgs(args));
        break;
      case "create_quality_snapshot":
        result = await createQualitySnapshot(config, asGateArgs(args));
        break;
      case "compare_quality_snapshot":
        result = await compareQualitySnapshot(config, asGateArgs(args));
        break;
      case "propose_quality_gate_plan":
        result = await proposeQualityGatePlan(config, asGateArgs(args));
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
    name: "hwai-repo-quality-gate-mcp",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use repo-quality-gate tools for local advisory clean-new-work budgets. Do not block, delete, or rewrite based only on this output.",
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
  console.error("HWAI Repo Quality Gate MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Repo Quality Gate MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
