#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getGoldenDatasetConfig } from "./config.js";
import {
  addCaseFromFeedback,
  buildDatasetManifestArtifact,
  compareRuns,
  importRetrievalFeedback,
  listDatasets,
  runDataset,
  runRetrievalDataset,
} from "./dataset-store.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { clampText, stableHash } from "./text-utils.js";

const config = getGoldenDatasetConfig();
let toolQueue: Promise<void> = Promise.resolve();

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
    name: "list_datasets",
    description: "List local golden datasets and compact counts. No case paths or raw queries are returned.",
    inputSchema: {
      type: "object",
      properties: {
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "add_case_from_feedback",
    description:
      "Promote a reviewed retrieval/context/vision/trace miss or partial into a local benchmark case. Raw query/code is not stored; raw_query/corrected_query are hashed only.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name. Defaults to retrieval-misses." },
        case_id: { type: "string", description: "Optional stable case id." },
        feedback_id: { type: "string" },
        call_id: { type: "string" },
        source_service: { type: "string", description: "Source service, for example retrieval-mcp." },
        task_type: { type: "string", description: "Task type, for example retrieval, vision, trace, hygiene." },
        raw_query: { type: "string", description: "Optional raw query to hash only. Not stored." },
        corrected_query: { type: "string", description: "Optional corrected query to hash only. Not stored." },
        query_summary: { type: "string", description: "Short reviewed-safe summary. Do not include raw code or secrets." },
        expected_paths: { type: "array", items: { type: "string" }, description: "Repo-relative expected paths. Local dataset only." },
        missing_paths: { type: "array", items: { type: "string" }, description: "Repo-relative missing paths. Local dataset only." },
        tags: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["candidate", "reviewed"], description: "Defaults to candidate." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "run_dataset",
    description:
      "Evaluate supplied result paths against a local dataset and write a local run artifact. If results are omitted, returns a needs_results run manifest.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        runner: { type: "string", description: "Runner label, for example retrieval-mcp@branch." },
        run_id: { type: "string" },
        include_candidates: { type: "boolean", description: "Include non-reviewed candidate cases. Defaults false." },
        results: {
          type: "array",
          items: {
                type: "object",
            properties: {
              case_id: { type: "string" },
              returned_paths: { type: "array", items: { type: "string" } },
              source_tokens_estimate: { type: "number" },
              raw_tokens_estimate: { type: "number", description: "Alias for source_tokens_estimate." },
              compact_tokens_estimate: { type: "number" },
              saved_tokens_estimate: { type: "number" },
            },
          },
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["dataset"],
    },
  },
  {
    name: "import_retrieval_feedback",
    description:
      "Import retrieval-mcp feedback.jsonl misses/partials into a local dataset. Raw query text is hashed only; request logs keep counts and hashes.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name. Defaults to retrieval-feedback." },
        feedback_log_path: { type: "string", description: "Optional local feedback.jsonl path. Not logged raw." },
        date: { type: "string", description: "Optional UTC date YYYY-MM-DD filter." },
        include_helpful: { type: "boolean", description: "Import helpful feedback too. Defaults false." },
        include_non_candidates: { type: "boolean", description: "Import non-candidate rows too. Defaults false." },
        status: { type: "string", enum: ["candidate", "reviewed"], description: "Imported case status. Defaults candidate." },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "run_retrieval_dataset",
    description:
      "Run reviewed dataset cases through local retrieval-mcp via stdio and evaluate returned ranked paths. Uses query_summary or local query_overrides; request logs keep counts/hashes only.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        repo_root: { type: "string", description: "Local repo root for retrieval-mcp. Not logged raw." },
        retrieval_tool: { type: "string", enum: ["find_files", "retrieve_context"], description: "Defaults to find_files." },
        retrieval_mcp_command: { type: "string", description: "Optional local retrieval MCP stdio command. Not logged raw." },
        retrieval_mcp_args: { type: "array", items: { type: "string" }, description: "Optional args for retrieval_mcp_command." },
        retrieval_cache_dir: { type: "string", description: "Optional isolated retrieval cache dir. Not logged raw." },
        runner: { type: "string" },
        run_id: { type: "string" },
        max_files: { type: "number" },
        include_candidates: { type: "boolean" },
        query_overrides: {
          type: "array",
          description: "Optional local-only case query overrides. Raw values are not logged.",
          items: {
            type: "object",
            properties: {
              case_id: { type: "string" },
              query: { type: "string" },
            },
          },
        },
        metadata: METADATA_SCHEMA,
      },
      required: ["dataset"],
    },
  },
  {
    name: "compare_runs",
    description: "Compare two local dataset run IDs and return aggregate deltas. No paths or raw case contents are returned.",
    inputSchema: {
      type: "object",
      properties: {
        baseline_run_id: { type: "string" },
        candidate_run_id: { type: "string" },
        metadata: METADATA_SCHEMA,
      },
      required: ["baseline_run_id", "candidate_run_id"],
    },
  },
  {
    name: "export_dataset_manifest",
    description: "Write a local manifest artifact with case ids and counts only. It excludes expected path values and raw query text.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        metadata: METADATA_SCHEMA,
      },
      required: ["dataset"],
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by golden-dataset-mcp.",
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
    description: "Return local golden-dataset usage, benchmark quality, token-savings, and Pantheon-safe aggregate export.",
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

function metadataSource(args: Record<string, unknown> | undefined): string | undefined {
  const metadata = args?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const source = (metadata as Record<string, unknown>).source;
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : undefined;
}

function countArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
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
    dataset: typeof args.dataset === "string" ? args.dataset.slice(0, 80) : undefined,
    case_id_hash: typeof args.case_id === "string" ? stableHash(args.case_id) : undefined,
    feedback_id_hash: typeof args.feedback_id === "string" ? stableHash(args.feedback_id) : undefined,
    call_id_hash: typeof args.call_id === "string" ? stableHash(args.call_id) : undefined,
    source_service: typeof args.source_service === "string" ? args.source_service.slice(0, 80) : undefined,
    task_type: typeof args.task_type === "string" ? args.task_type.slice(0, 80) : undefined,
    raw_query_provided: typeof args.raw_query === "string" && args.raw_query.length > 0,
    corrected_query_provided: typeof args.corrected_query === "string" && args.corrected_query.length > 0,
    expected_paths_count: countArray(args.expected_paths),
    missing_paths_count: countArray(args.missing_paths),
    result_count: countArray(args.results),
    query_override_count: countArray(args.query_overrides),
    repo_root_hash: typeof args.repo_root === "string" ? stableHash(args.repo_root) : undefined,
    retrieval_tool: args.retrieval_tool,
    retrieval_mcp_command_hash: typeof args.retrieval_mcp_command === "string" ? stableHash(args.retrieval_mcp_command) : undefined,
    retrieval_mcp_args_count: countArray(args.retrieval_mcp_args),
    retrieval_cache_dir_hash: typeof args.retrieval_cache_dir === "string" ? stableHash(args.retrieval_cache_dir) : undefined,
    feedback_log_path_hash: typeof args.feedback_log_path === "string" ? stableHash(args.feedback_log_path) : undefined,
    include_helpful: args.include_helpful === true,
    include_non_candidates: args.include_non_candidates === true,
    baseline_run_id_hash: typeof args.baseline_run_id === "string" ? stableHash(args.baseline_run_id) : undefined,
    candidate_run_id_hash: typeof args.candidate_run_id === "string" ? stableHash(args.candidate_run_id) : undefined,
    include_candidates: args.include_candidates === true,
    date: args.date,
    since_iso: args.since_iso,
    until_iso: args.until_iso,
    metadata_source: metadataSource(args),
  };
}

function summarizeOutput(result: any): Record<string, unknown> {
  return {
    status: result?.status || "ok",
    dataset_count: result?.dataset_count || 0,
    case_count: result?.case_count || result?.cases || 0,
    cases_added: result?.cases_added || (result?.case_id ? 1 : 0),
    imported_count: result?.imported_count || 0,
    skipped_count: result?.skipped_count || 0,
    retrieval_calls: result?.retrieval_calls || 0,
    retrieval_errors: result?.retrieval_errors || 0,
    skipped_cases: result?.skipped_cases || 0,
    cases_run: result?.cases_run || 0,
    cases_passed: result?.cases_passed || 0,
    cases_failed: result?.cases_failed || 0,
    recall_at_5_pct: result?.recall_at_5_pct || 0,
    recall_at_10_pct: result?.recall_at_10_pct || 0,
    mrr: result?.mrr || 0,
    regression: result?.regression === true,
    artifact_file: result?.artifact_file,
    raw_tokens_estimate: result?.raw_tokens_estimate || result?.source_tokens_estimate || 0,
    source_tokens_estimate: result?.source_tokens_estimate || result?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || 0,
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

function enqueueToolCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = toolQueue.then(fn, fn);
  toolQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const server = new Server(
  {
    name: "golden-dataset-mcp",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

async function runTool(name: string, args: Record<string, unknown>) {
  try {
    if (name === "list_datasets") {
      const result = await audited(name, args, () => listDatasets(config));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "add_case_from_feedback") {
      const result = await audited(name, args, () => addCaseFromFeedback(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "run_dataset") {
      const result = await audited(name, args, () => runDataset(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "import_retrieval_feedback") {
      const result = await audited(name, args, () => importRetrievalFeedback(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "run_retrieval_dataset") {
      const result = await audited(name, args, () => runRetrievalDataset(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "compare_runs") {
      const result = await audited(name, args, () => compareRuns(config, args));
      return { content: [{ type: "text", text: stringifyResult(result) }] };
    }
    if (name === "export_dataset_manifest") {
      const result = await audited(name, args, () => buildDatasetManifestArtifact(config, args));
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
          schema_version: "golden-dataset-artifact.v1",
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
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = asArgs(request.params.arguments);
  return enqueueToolCall(() => runTool(name, args));
});

const transport = new StdioServerTransport();
await server.connect(transport);
