#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { artifactFileName, readArtifact } from "./artifact-store.js";
import { getDependencyRiskConfig } from "./config.js";
import {
  DependencyRiskArgs,
  checkLicenses,
  packageAgeReport,
  runNpmAudit,
  runOsvScanner,
  summarizeNpmAuditFixPlan,
  summarizeSupplyChainRisk,
  summarizeLockfileDiff,
} from "./dependency-risk.js";
import { buildMeasurementReport } from "./measurement.js";
import { appendRequestLog } from "./request-log.js";
import { stableHash } from "./text-utils.js";

const config = getDependencyRiskConfig();

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional metadata for attribution. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, lockfile bodies, audit JSON, package manager output, secrets, or long notes.",
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
  lockfile_path: { type: "string", description: "Repo-relative package-lock.json path. Default package-lock.json." },
  package_json_path: { type: "string", description: "Repo-relative package.json path. Default package.json." },
  max_findings: { type: "number", description: "Maximum returned findings." },
  metadata: METADATA_SCHEMA,
};

const TOOLS: Tool[] = [
  {
    name: "summarize_lockfile_diff",
    description: "Compare npm lockfile snapshots and report added, removed, changed, and major-bump dependency facts.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        baseline_lockfile_path: { type: "string" },
        current_lockfile_path: { type: "string" },
        baseline: { type: "object" },
        current: { type: "object" },
      },
    },
  },
  {
    name: "run_npm_audit",
    description: "Summarize npm audit JSON. Runs npm audit only when allow_network=true; otherwise use audit_json_path/audit_json.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        allow_network: { type: "boolean" },
        audit_json_path: { type: "string" },
        audit_json: { type: "object" },
      },
    },
  },
  {
    name: "summarize_npm_audit_fix_plan",
    description:
      "Summarize npm audit fix dry-run JSON or stdout, including npm outputs that prepend action lines before JSON. Runs dry-run only when allow_network=true.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        allow_network: { type: "boolean" },
        audit_fix_json: { type: "object" },
        audit_fix_output: { type: "string", description: "Raw stdout from npm audit fix --dry-run --json. Not logged raw." },
        audit_fix_output_path: { type: "string", description: "Repo-relative saved stdout from npm audit fix --dry-run --json." },
        package_lock_only: { type: "boolean", description: "When allow_network=true, add --package-lock-only to the dry-run command." },
      },
    },
  },
  {
    name: "run_osv_scanner",
    description: "Summarize OSV scanner JSON. Runs osv-scanner only when allow_network=true and binary exists; otherwise use osv_json_path/osv_json.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        allow_network: { type: "boolean" },
        osv_json_path: { type: "string" },
        osv_json: { type: "object" },
      },
    },
  },
  {
    name: "check_licenses",
    description: "Summarize dependency licenses from package-lock data and flag unknown/disallowed licenses.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        disallowed_licenses: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "package_age_report",
    description: "Summarize direct dependency staleness/deprecation using optional local registry metadata.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
        registry_metadata_path: { type: "string" },
        registry_metadata: { type: "object" },
      },
    },
  },
  {
    name: "summarize_supply_chain_risk",
    description:
      "Summarize lockfile supply-chain risk signals such as install scripts, missing integrity, git/file/link sources, and non-registry resolved packages without returning raw resolved URLs.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_PROPS,
      },
    },
  },
  {
    name: "get_artifact",
    description: "Read a local artifact produced by dependency-risk-mcp.",
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
    description: "Return local dependency-risk usage, quality counters, token-savings, and Pantheon-safe export.",
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

function asDependencyArgs(args: Record<string, unknown>): DependencyRiskArgs {
  return {
    allow_network: args.allow_network === true,
    audit_fix_json: args.audit_fix_json,
    audit_fix_output: typeof args.audit_fix_output === "string" ? args.audit_fix_output : undefined,
    audit_fix_output_path: typeof args.audit_fix_output_path === "string" ? args.audit_fix_output_path : undefined,
    audit_json: args.audit_json,
    audit_json_path: typeof args.audit_json_path === "string" ? args.audit_json_path : undefined,
    baseline: args.baseline,
    baseline_lockfile_path: typeof args.baseline_lockfile_path === "string" ? args.baseline_lockfile_path : undefined,
    current: args.current,
    current_lockfile_path: typeof args.current_lockfile_path === "string" ? args.current_lockfile_path : undefined,
    disallowed_licenses: stringArray(args.disallowed_licenses),
    lockfile_path: typeof args.lockfile_path === "string" ? args.lockfile_path : undefined,
    max_findings: typeof args.max_findings === "number" ? args.max_findings : undefined,
    metadata: args.metadata,
    osv_json: args.osv_json,
    osv_json_path: typeof args.osv_json_path === "string" ? args.osv_json_path : undefined,
    package_json_path: typeof args.package_json_path === "string" ? args.package_json_path : undefined,
    package_lock_only: args.package_lock_only === true,
    registry_metadata: args.registry_metadata,
    registry_metadata_path: typeof args.registry_metadata_path === "string" ? args.registry_metadata_path : undefined,
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
    lockfile_path_hash: typeof args.lockfile_path === "string" ? stableHash(args.lockfile_path) : undefined,
    package_json_path_hash: typeof args.package_json_path === "string" ? stableHash(args.package_json_path) : undefined,
    baseline_lockfile_path_hash: typeof args.baseline_lockfile_path === "string" ? stableHash(args.baseline_lockfile_path) : undefined,
    current_lockfile_path_hash: typeof args.current_lockfile_path === "string" ? stableHash(args.current_lockfile_path) : undefined,
    audit_fix_json_hash: args.audit_fix_json ? stableHash(JSON.stringify(args.audit_fix_json)) : undefined,
    audit_fix_output_hash: typeof args.audit_fix_output === "string" ? stableHash(args.audit_fix_output) : undefined,
    audit_fix_output_path_hash: typeof args.audit_fix_output_path === "string" ? stableHash(args.audit_fix_output_path) : undefined,
    audit_json_path_hash: typeof args.audit_json_path === "string" ? stableHash(args.audit_json_path) : undefined,
    osv_json_path_hash: typeof args.osv_json_path === "string" ? stableHash(args.osv_json_path) : undefined,
    registry_metadata_path_hash: typeof args.registry_metadata_path === "string" ? stableHash(args.registry_metadata_path) : undefined,
    audit_json_hash: args.audit_json ? stableHash(JSON.stringify(args.audit_json)) : undefined,
    osv_json_hash: args.osv_json ? stableHash(JSON.stringify(args.osv_json)) : undefined,
    registry_metadata_hash: args.registry_metadata ? stableHash(JSON.stringify(args.registry_metadata)) : undefined,
    baseline_hash: args.baseline ? stableHash(JSON.stringify(args.baseline)) : undefined,
    current_hash: args.current ? stableHash(JSON.stringify(args.current)) : undefined,
    allow_network: args.allow_network === true,
    package_lock_only: args.package_lock_only === true,
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
    action_prelude_lines_count: result?.action_prelude_lines_count || 0,
    added_dependencies_count: result?.added_dependencies_count || 0,
    changed_dependencies_count: result?.changed_dependencies_count || 0,
    critical_vulnerability_count: result?.critical_vulnerability_count || 0,
    deprecated_package_count: result?.deprecated_package_count || 0,
    dependency_count: result?.dependency_count || 0,
    direct_dependency_count: result?.direct_dependency_count || 0,
    disallowed_license_count: result?.disallowed_license_count || 0,
    dry_run_added_count: result?.dry_run_added_count || 0,
    dry_run_changed_count: result?.dry_run_changed_count || 0,
    dry_run_net_package_delta: result?.dry_run_net_package_delta || 0,
    dry_run_removed_count: result?.dry_run_removed_count || 0,
    external_resolved_count: result?.external_resolved_count || 0,
    fix_available_count: result?.fix_available_count || 0,
    git_resolved_count: result?.git_resolved_count || 0,
    high_vulnerability_count: result?.high_vulnerability_count || 0,
    insecure_resolved_count: result?.insecure_resolved_count || 0,
    install_script_packages_count: result?.install_script_packages_count || 0,
    low_vulnerability_count: result?.low_vulnerability_count || 0,
    major_bumps_count: result?.major_bumps_count || 0,
    missing_integrity_count: result?.missing_integrity_count || 0,
    moderate_vulnerability_count: result?.moderate_vulnerability_count || 0,
    npm_audit_skipped_count: result?.npm_audit_skipped_count || 0,
    npm_audit_fix_skipped_count: result?.npm_audit_fix_skipped_count || 0,
    npm_registry_resolved_count: result?.npm_registry_resolved_count || 0,
    osv_scanner_skipped_count: result?.osv_scanner_skipped_count || 0,
    osv_vulnerability_count: result?.osv_vulnerability_count || 0,
    package_age_unknown_count: result?.package_age_unknown_count || 0,
    package_files: result?.package_files || 0,
    removed_dependencies_count: result?.removed_dependencies_count || 0,
    stale_package_count: result?.stale_package_count || 0,
    supply_chain_risk_count: result?.supply_chain_risk_count || 0,
    unknown_license_count: result?.unknown_license_count || 0,
    vulnerability_count: result?.vulnerability_count || 0,
    raw_tokens_estimate: result?.raw_tokens_estimate || result?.token_savings?.raw_tokens_estimate || 0,
    compact_tokens_estimate: result?.compact_tokens_estimate || result?.token_savings?.compact_tokens_estimate || 0,
    saved_tokens_estimate: result?.saved_tokens_estimate || result?.token_savings?.saved_tokens_estimate || 0,
    savings_pct: result?.savings_pct || result?.token_savings?.savings_pct || 0,
    semver_major_fix_count: result?.semver_major_fix_count || 0,
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
      case "summarize_lockfile_diff":
        result = await summarizeLockfileDiff(config, asDependencyArgs(args));
        break;
      case "run_npm_audit":
        result = await runNpmAudit(config, asDependencyArgs(args));
        break;
      case "summarize_npm_audit_fix_plan":
        result = await summarizeNpmAuditFixPlan(config, asDependencyArgs(args));
        break;
      case "run_osv_scanner":
        result = await runOsvScanner(config, asDependencyArgs(args));
        break;
      case "check_licenses":
        result = await checkLicenses(config, asDependencyArgs(args));
        break;
      case "package_age_report":
        result = await packageAgeReport(config, asDependencyArgs(args));
        break;
      case "summarize_supply_chain_risk":
        result = await summarizeSupplyChainRisk(config, asDependencyArgs(args));
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
    name: "hwai-dependency-risk-mcp",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Use dependency-risk tools for local advisory dependency, license, audit, OSV, package-age, and supply-chain lockfile evidence. Do not edit lockfiles from compact output alone; read exact files first.",
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
  console.error("HWAI Dependency Risk MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Dependency Risk MCP fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
