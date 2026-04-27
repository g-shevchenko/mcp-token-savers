#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function resolveWindow() {
  if (hasFlag("--all")) {
    return {
      date: null,
      sinceIso: null,
      untilIso: null,
      sinceMs: Number.NEGATIVE_INFINITY,
      untilMs: Number.POSITIVE_INFINITY,
    };
  }

  const date = argValue("--date", todayUtc());
  const sinceIso = argValue("--since", `${date}T00:00:00.000Z`);
  const untilIso = argValue("--until", addDays(date, 1));
  return {
    date,
    sinceIso,
    untilIso,
    sinceMs: Date.parse(sinceIso),
    untilMs: Date.parse(untilIso),
  };
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function inWindow(row, window) {
  const ts = Date.parse(row?.ts || "");
  return Number.isFinite(ts) && ts >= window.sinceMs && ts < window.untilMs;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, pct) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index];
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const SAFE_QUALITY_COUNTER_KEYS = [
  "added_code_lines",
  "added_dependencies_count",
  "added_doc_lines",
  "action_prelude_lines_count",
  "action_docs_count",
  "action_items_count",
  "context_prep_recommended",
  "clarification_recommended",
  "failure_found",
  "failure_window_present",
  "failure_window_console_errors",
  "failure_window_network_failures",
  "failure_window_slow_requests",
  "files_indexed",
  "approval_recorded",
  "approved_compare",
  "artifact_outputs",
  "authors_returned",
  "baseline_created",
  "baseline_approval_stale",
  "baseline_approved",
  "budget_checks",
  "broken_anchors_count",
  "broken_links_count",
  "case_count",
  "cases_added",
  "cases_failed",
  "cases_passed",
  "cases_run",
  "candidates_count",
  "changed_pixels",
  "changed_code_files",
  "changed_dependencies_count",
  "changed_doc_files",
  "changed_files",
  "code_files",
  "cochange_files_returned",
  "commits_returned",
  "context_pressure_score",
  "breaking_changes_count",
  "contract_snapshots",
  "critical_vulnerability_count",
  "cycles_count",
  "dataset_count",
  "dataset_count_returned",
  "deprecated_package_count",
  "dependencies_total",
  "dependency_count",
  "direct_dependency_count",
  "disallowed_license_count",
  "doc_count",
  "doc_lines",
  "dry_run_added_count",
  "dry_run_changed_count",
  "dry_run_net_package_delta",
  "dry_run_removed_count",
  "duplicate_section_groups",
  "dimension_mismatch",
  "dynamic_imports_indexed",
  "dynamic_imports_seen",
  "duplicate_groups",
  "diff_removed_env_vars",
  "diff_removed_operations",
  "diff_removed_schema_fields",
  "env_declared_count",
  "env_used_count",
  "files_returned",
  "fix_available_count",
  "frontmatter_missing_count",
  "frontier_required",
  "growth_findings_count",
  "external_resolved_count",
  "git_resolved_count",
  "high_vulnerability_count",
  "hotspots_returned",
  "hotspots_count",
  "ignored_changed_pixels",
  "imported_count",
  "import_count",
  "importer_count",
  "imports_indexed",
  "mask_preset_applied",
  "mask_preset_query_matched",
  "mask_preset_query_used",
  "mask_preset_regions_count",
  "mask_preset_saved",
  "mask_presets_applied",
  "large_docs_count",
  "low_vulnerability_count",
  "major_bumps_count",
  "insecure_resolved_count",
  "install_script_packages_count",
  "missing_env_examples_count",
  "missing_integrity_count",
  "missing_mirror_count",
  "missing_registry_entries_count",
  "missing_source_count",
  "mirror_count",
  "moderate_vulnerability_count",
  "npm_audit_fix_skipped_count",
  "npm_audit_skipped_count",
  "npm_registry_resolved_count",
  "orphan_docs_count",
  "openapi_files_count",
  "osv_scanner_skipped_count",
  "osv_vulnerability_count",
  "over_budget_count",
  "package_age_unknown_count",
  "package_files",
  "plan_items_count",
  "operations_count",
  "payload_validation_failures",
  "references_indexed",
  "references_returned",
  "removed_dependencies_count",
  "retrieval_calls",
  "retrieval_errors",
  "retrieval_recommended",
  "scraper_followup_recommended",
  "scraper_recommended",
  "scanned_files",
  "schemas_count",
  "search_results_returned",
  "semver_major_fix_count",
  "skipped_cases",
  "skipped_count",
  "ssot_conflicts_count",
  "stale_approval_compare",
  "stale_files",
  "stale_mirrors_count",
  "stale_registry_entries_count",
  "stale_references_count",
  "snapshot_code_lines",
  "snapshot_doc_lines",
  "snapshot_files",
  "stale_package_count",
  "supply_chain_risk_count",
  "synced_mirror_count",
  "symbols_indexed",
  "title_mismatch_count",
  "trigger_recommended",
  "unapproved_compare",
  "unused_env_declared_count",
  "skip_recommended",
  "unknown_license_count",
  "update_candidates_count",
  "validation_errors_count",
  "vulnerability_count",
  "vision_recommended",
  "zod_embedded_schemas_count",
  "zod_fields_count",
  "zod_files_count",
  "zod_schemas_count",
];

function qualityCounters(rows) {
  const counters = {};
  for (const row of rows) {
    const output = row?.output || {};
    for (const key of SAFE_QUALITY_COUNTER_KEYS) {
      const value = output[key];
      if (value === true) {
        counters[key] = (counters[key] || 0) + 1;
      } else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        counters[key] = (counters[key] || 0) + value;
      }
    }
  }
  return Object.fromEntries(Object.entries(counters).sort((a, b) => a[0].localeCompare(b[0])));
}

function tokenEvent(row) {
  const output = row?.output || {};
  const sourceTokens = number(output.raw_tokens_estimate) || number(output.full_tokens_estimate);
  const compactTokens = number(output.compact_tokens_estimate);
  const savedTokens = number(output.saved_tokens_estimate) || Math.max(0, sourceTokens - compactTokens);

  if (sourceTokens <= 0 && compactTokens <= 0 && savedTokens <= 0) {
    return null;
  }

  return {
    sourceTokens,
    compactTokens,
    savedTokens,
  };
}

function sanitizeSampleValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeSampleValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.toLowerCase();
        return !(
          normalized === "query" ||
          normalized === "corrected_query" ||
          normalized === "notes" ||
          normalized === "text" ||
          normalized.endsWith("_text") ||
          normalized.includes("body") ||
          normalized.includes("content") ||
          normalized.includes("path")
        );
      })
      .map(([key, item]) => [key, sanitizeSampleValue(item)]),
  );
}

function traceSource(row) {
  const input = row.input || {};
  const explicit = typeof input.metadata_source === "string" ? input.metadata_source.trim() : "";
  const surface = typeof input.metadata_surface === "string" ? input.metadata_surface.trim() : "";

  if (trafficClass(row) === "proof") {
    return "proof_loop";
  }
  if (trafficClass(row) === "benchmark") {
    return "benchmark";
  }
  if (explicit) {
    return explicit.slice(0, 80);
  }
  if (surface) {
    return surface.slice(0, 80);
  }
  return "unknown";
}

function cleanLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 80);
}

function inferSurfaceFromSource(source) {
  const normalized = (source || "").toLowerCase();
  for (const surface of ["claude", "codex", "cursor", "windsurf"]) {
    if (normalized.includes(surface)) {
      return surface;
    }
  }
  return "";
}

function trafficClass(row) {
  const input = row.input || {};
  const explicit = cleanLabel(input.traffic_class);
  if (["production_like", "proof", "benchmark", "unknown"].includes(explicit)) {
    return explicit;
  }

  const source = cleanLabel(input.metadata_source);
  const surface = cleanLabel(input.metadata_surface) || inferSurfaceFromSource(source);
  const haystack = JSON.stringify({
    source,
    surface,
    tool: row.tool,
    purpose: input.purpose,
    context: input.context,
  }).toLowerCase();

  if (
    haystack.includes("golden") ||
    haystack.includes("benchmark") ||
    haystack.includes("bench") ||
    haystack.includes("dataset") ||
    haystack.includes("regression")
  ) {
    return "benchmark";
  }
  if (
    haystack.includes("smoke") ||
    haystack.includes("e2e") ||
    haystack.includes("proof") ||
    haystack.includes("test") ||
    haystack.includes("fixture")
  ) {
    return "proof";
  }
  if (/\b(claude|codex|cursor|windsurf|agent)\b/.test(haystack)) {
    return "production_like";
  }
  return "unknown";
}

function summarizeHighUncertainty(row) {
  const output = row.output || {};
  const uncertainty = number(output.uncertainty) || number(output.max_uncertainty);
  return {
    ts: row.ts,
    tool: row.tool,
    trace_source: traceSource(row),
    traffic_class: trafficClass(row),
    duration_ms: row.duration_ms,
    uncertainty,
    requires_clarification: output.requires_clarification === true,
    input: sanitizeSampleValue(row.input || {}),
    output: {
      prep_mode: output.prep_mode,
      parser_used: output.parser_used,
      recommended_profile: output.recommended_profile,
      image_urls_for_model_count: output.image_urls_for_model_count,
      annotation_regions_count: output.annotation_regions_count,
      changed_regions_count: output.changed_regions_count,
      ranked_files_returned: output.ranked_files_returned,
      snippets_returned: output.snippets_returned,
      warnings_count: output.warnings_count,
      savings_pct: output.savings_pct,
    },
  };
}

function summarizeFeedbackCandidate(row) {
  return {
    ts: row.ts,
    feedback_id: row.feedback_id,
    call_id: row.call_id,
    outcome: row.outcome,
    frontier_had_to_search: row.frontier_had_to_search === true,
    expected_paths_count: Array.isArray(row.expected_paths) ? row.expected_paths.length : 0,
    missing_paths_count: Array.isArray(row.missing_paths) ? row.missing_paths.length : 0,
    retrieved_paths_count: Array.isArray(row.retrieved_paths) ? row.retrieved_paths.length : 0,
  };
}

function serviceRollup(service, requestRows, feedbackRows = []) {
  const durations = requestRows.map((row) => number(row.duration_ms));
  const tokenEvents = requestRows.map(tokenEvent).filter(Boolean);
  const sourceTokens = tokenEvents.reduce((sum, item) => sum + item.sourceTokens, 0);
  const compactTokens = tokenEvents.reduce((sum, item) => sum + item.compactTokens, 0);
  const savedTokens = tokenEvents.reduce((sum, item) => sum + item.savedTokens, 0);
  const highUncertainty = requestRows.filter((row) => {
    const output = row.output || {};
    const uncertainty = number(output.uncertainty) || number(output.max_uncertainty);
    return uncertainty > 0.03 || output.requires_clarification === true;
  });
  const helpfulFeedbackCallIds = new Set(
    feedbackRows
      .filter((row) => row.outcome === "helpful" && typeof row.call_id === "string" && row.call_id)
      .map((row) => row.call_id),
  );
  const helpfulHighUncertainty = highUncertainty.filter((row) => helpfulFeedbackCallIds.has(row.output?.call_id));
  const proofLoopHighUncertainty = highUncertainty.filter((row) => ["proof", "benchmark"].includes(trafficClass(row)));
  const actionableHighUncertainty = highUncertainty.filter(
    (row) => !["proof", "benchmark"].includes(trafficClass(row)) && !helpfulFeedbackCallIds.has(row.output?.call_id),
  );
  const errors = requestRows.filter((row) => row.ok === false);
  const proofLoopErrors = errors.filter((row) => ["proof", "benchmark"].includes(trafficClass(row)));
  const actionableErrors = errors.filter((row) => !["proof", "benchmark"].includes(trafficClass(row)));
  const benchmarkCandidates = feedbackRows.filter((row) => row.benchmark_candidate === true);

  return {
    service,
    request_log_path: service.requestLogPath,
    feedback_log_path: service.feedbackLogPath || null,
    requests: requestRows.length,
    ok: requestRows.length - errors.length,
    errors: errors.length,
    actionable_error_count: actionableErrors.length,
    proof_loop_error_count: proofLoopErrors.length,
    token_events: tokenEvents.length,
    source_tokens_estimate: sourceTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: sourceTokens > 0 ? round((savedTokens / sourceTokens) * 100) : 0,
    high_uncertainty_count: highUncertainty.length,
    actionable_high_uncertainty_count: actionableHighUncertainty.length,
    proof_loop_high_uncertainty_count: proofLoopHighUncertainty.length,
    reviewed_helpful_high_uncertainty_count: helpfulHighUncertainty.length,
    high_uncertainty_samples: highUncertainty.slice(-5).map(summarizeHighUncertainty),
    p95_latency_ms: percentile(durations, 0.95),
    by_tool: countBy(requestRows, (row) => row.tool),
    by_transport: countBy(requestRows, (row) => row.transport),
    by_traffic_class: countBy(requestRows, trafficClass),
    by_trace_source: countBy(requestRows, traceSource),
    quality_counts: qualityCounters(requestRows),
    feedback: {
      count: feedbackRows.length,
      benchmark_candidates: benchmarkCandidates.length,
      frontier_search_count: feedbackRows.filter((row) => row.frontier_had_to_search === true).length,
      helpful_count: feedbackRows.filter((row) => row.outcome === "helpful").length,
      by_outcome: countBy(feedbackRows, (row) => row.outcome),
      candidate_samples: benchmarkCandidates.slice(-5).map(summarizeFeedbackCandidate),
    },
    error_samples: errors.slice(-5).map((row) => ({
      ts: row.ts,
      tool: row.tool,
      trace_source: traceSource(row),
      duration_ms: row.duration_ms,
      error: row.error,
    })),
  };
}

function buildRecommendations(services) {
  const recommendations = [];
  for (const item of services) {
    if (item.requests === 0) {
      recommendations.push(`${item.service.name}: no traces in the selected window; run smoke/benchmark or wait for real agent usage.`);
    }
    if (item.actionable_error_count > 0) {
      recommendations.push(
        `${item.service.name}: inspect ${item.actionable_error_count} non-proof-loop error request(s) before optimizing token budgets.`,
      );
    } else if (item.proof_loop_error_count > 0) {
      recommendations.push(
        `${item.service.name}: error traces are proof-loop only; keep them for benchmark hygiene but do not tune product behavior from them.`,
      );
    }
    if (item.actionable_high_uncertainty_count > 0) {
      recommendations.push(`${item.service.name}: review non-proof-loop high-uncertainty traces and expand artifacts/tests only where quality requires it.`);
    } else if (item.proof_loop_high_uncertainty_count > 0 && item.reviewed_helpful_high_uncertainty_count > 0) {
      recommendations.push(`${item.service.name}: remaining high-uncertainty traces are proof-loop or already reviewed helpful; no tuning needed from those samples.`);
    } else if (item.proof_loop_high_uncertainty_count > 0) {
      recommendations.push(`${item.service.name}: high-uncertainty traces are proof-loop only; keep collecting real usage before tuning.`);
    } else if (item.reviewed_helpful_high_uncertainty_count > 0) {
      recommendations.push(`${item.service.name}: high-uncertainty traces reviewed as helpful; no tuning needed from those samples.`);
    }
    if (item.feedback.benchmark_candidates > 0) {
      recommendations.push(`${item.service.name}: promote benchmark_candidate feedback into reviewed regression cases before ranking changes.`);
    }
  }
  if (recommendations.length === 0) {
    recommendations.push("No immediate action from this window; keep collecting real traces before tuning.");
  }
  return recommendations;
}

function sumValues(object, predicate = () => true) {
  return Object.entries(object || {}).reduce((sum, [key, value]) => (predicate(key) ? sum + number(value) : sum), 0);
}

function traceSourceExportCounts(byTraceSource) {
  return {
    proof_loop: number(byTraceSource?.proof_loop),
    benchmark: number(byTraceSource?.benchmark),
    unknown: number(byTraceSource?.unknown),
    labeled: sumValues(byTraceSource, (key) => key !== "proof_loop" && key !== "benchmark" && key !== "unknown"),
  };
}

function servicePantheonExport(item) {
  return {
    service: item.service.name,
    requests: item.requests,
    ok: item.ok,
    errors: item.errors,
    actionable_error_count: item.actionable_error_count,
    proof_loop_error_count: item.proof_loop_error_count,
    token_events: item.token_events,
    source_tokens_estimate: item.source_tokens_estimate,
    compact_tokens_estimate: item.compact_tokens_estimate,
    saved_tokens_estimate: item.saved_tokens_estimate,
    savings_pct: item.savings_pct,
    p95_latency_ms: item.p95_latency_ms,
    high_uncertainty_count: item.high_uncertainty_count,
    actionable_high_uncertainty_count: item.actionable_high_uncertainty_count,
    proof_loop_high_uncertainty_count: item.proof_loop_high_uncertainty_count,
    reviewed_helpful_high_uncertainty_count: item.reviewed_helpful_high_uncertainty_count,
    feedback_count: item.feedback.count,
    feedback_benchmark_candidates: item.feedback.benchmark_candidates,
    feedback_frontier_search_count: item.feedback.frontier_search_count,
    by_tool: item.by_tool,
    by_transport: item.by_transport,
    by_traffic_class: item.by_traffic_class,
    quality_counts: item.quality_counts,
    trace_source_counts: traceSourceExportCounts(item.by_trace_source),
  };
}

function buildPantheonExport(report) {
  return {
    schema_version: "hwai-utility-mcp-pantheon-export.v1",
    generated_at: report.generated_at,
    safe_for_pantheon: true,
    data_policy: {
      aggregate_only: true,
      includes_raw_queries: false,
      includes_file_paths: false,
      includes_local_log_paths: false,
      includes_notes: false,
      includes_samples: false,
      includes_artifact_urls: false,
    },
    filters: report.filters,
    summary: report.summary,
    services: Object.fromEntries(
      Object.values(report.services).map((item) => [item.service.name, servicePantheonExport(item)]),
    ),
    recommendations_count: report.recommendations.length,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# HWAI Utility MCP Measurement Digest");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Window: ${report.filters.since_iso || "beginning"} -> ${report.filters.until_iso || "now"}`);
  lines.push("");
  lines.push("| Service | Requests | Errors | Actionable Errors | Token Events | Saved Tokens | Savings | p95 ms | High Uncertainty | Actionable | Reviewed Helpful | Feedback Candidates |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const item of Object.values(report.services)) {
    lines.push(
      `| ${item.service.name} | ${item.requests} | ${item.errors} | ${item.actionable_error_count} | ${item.token_events} | ${item.saved_tokens_estimate} | ${item.savings_pct}% | ${item.p95_latency_ms} | ${item.high_uncertainty_count} | ${item.actionable_high_uncertainty_count} | ${item.reviewed_helpful_high_uncertainty_count} | ${item.feedback.benchmark_candidates} |`,
    );
  }
  lines.push("");
  lines.push(`Total saved tokens estimate: ${report.summary.saved_tokens_estimate}`);
  lines.push(`Weighted savings: ${report.summary.savings_pct}%`);
  lines.push("");
  lines.push("Pantheon-safe export: `--format=pantheon` returns aggregate-only telemetry without samples, raw queries, paths, notes, local log paths, or artifact URLs.");
  lines.push("");
  const servicesWithUncertainty = Object.values(report.services).filter((item) => item.high_uncertainty_samples.length > 0);
  if (servicesWithUncertainty.length > 0) {
    lines.push("## High-Uncertainty Samples");
    for (const item of servicesWithUncertainty) {
      lines.push("");
      lines.push(`### ${item.service.name}`);
      for (const sample of item.high_uncertainty_samples) {
        const details = [
          `tool=${sample.tool}`,
          `source=${sample.trace_source}`,
          `uncertainty=${sample.uncertainty}`,
          `duration_ms=${sample.duration_ms}`,
        ];
        if (sample.output.prep_mode) {
          details.push(`prep_mode=${sample.output.prep_mode}`);
        }
        if (sample.output.recommended_profile) {
          details.push(`profile=${sample.output.recommended_profile}`);
        }
        if (sample.output.parser_used) {
          details.push(`parser=${sample.output.parser_used}`);
        }
        lines.push(`- ${sample.ts}: ${details.join(", ")}`);
      }
    }
    lines.push("");
  }
  const servicesWithFeedbackCandidates = Object.values(report.services).filter(
    (item) => item.feedback.candidate_samples.length > 0,
  );
  if (servicesWithFeedbackCandidates.length > 0) {
    lines.push("## Feedback Candidate Samples");
    for (const item of servicesWithFeedbackCandidates) {
      lines.push("");
      lines.push(`### ${item.service.name}`);
      for (const sample of item.feedback.candidate_samples) {
        lines.push(
          `- ${sample.ts}: feedback_id=${sample.feedback_id}, outcome=${sample.outcome}, expected_paths=${sample.expected_paths_count}, missing_paths=${sample.missing_paths_count}, frontier_search=${sample.frontier_had_to_search}`,
        );
      }
    }
    lines.push("");
  }
  const servicesWithQualityCounts = Object.values(report.services).filter(
    (item) => Object.keys(item.quality_counts || {}).length > 0,
  );
  if (servicesWithQualityCounts.length > 0) {
    lines.push("## Quality Counters");
    for (const item of servicesWithQualityCounts) {
      const rendered = Object.entries(item.quality_counts)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      lines.push(`- ${item.service.name}: ${rendered}`);
    }
    lines.push("");
  }
  lines.push("## Recommendations");
  for (const item of report.recommendations) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const services = [
  {
    name: "retrieval-mcp",
    requestLogPath: process.env.RETRIEVAL_REQUEST_LOG_PATH || homePath(".hwai", "retrieval-mcp", "requests.jsonl"),
    feedbackLogPath: process.env.RETRIEVAL_FEEDBACK_LOG_PATH || homePath(".hwai", "retrieval-mcp", "feedback.jsonl"),
  },
  {
    name: "context-prep-mcp",
    requestLogPath: process.env.CONTEXT_PREP_REQUEST_LOG_PATH || homePath(".hwai", "context-prep-mcp", "requests.jsonl"),
  },
  {
    name: "vision-mcp",
    requestLogPath: process.env.VISION_MCP_REQUEST_LOG_PATH || homePath(".hwai", "vision-mcp", "requests.jsonl"),
  },
  {
    name: "static-analysis-mcp",
    requestLogPath:
      process.env.STATIC_ANALYSIS_REQUEST_LOG_PATH || homePath(".hwai", "static-analysis-mcp", "requests.jsonl"),
  },
  {
    name: "agent-trace-mcp",
    requestLogPath:
      process.env.AGENT_TRACE_REQUEST_LOG_PATH || homePath(".hwai", "agent-trace-mcp", "requests.jsonl"),
  },
  {
    name: "playwright-trace-mcp",
    requestLogPath:
      process.env.PLAYWRIGHT_TRACE_REQUEST_LOG_PATH || homePath(".hwai", "playwright-trace-mcp", "requests.jsonl"),
  },
  {
    name: "visual-baseline-mcp",
    requestLogPath:
      process.env.VISUAL_BASELINE_REQUEST_LOG_PATH || homePath(".hwai", "visual-baseline-mcp", "requests.jsonl"),
  },
  {
    name: "repo-history-mcp",
    requestLogPath:
      process.env.REPO_HISTORY_REQUEST_LOG_PATH || homePath(".hwai", "repo-history-mcp", "requests.jsonl"),
  },
  {
    name: "golden-dataset-mcp",
    requestLogPath:
      process.env.GOLDEN_DATASET_REQUEST_LOG_PATH || homePath(".hwai", "golden-dataset-mcp", "requests.jsonl"),
  },
  {
    name: "language-graph-mcp",
    requestLogPath:
      process.env.LANGUAGE_GRAPH_REQUEST_LOG_PATH || homePath(".hwai", "language-graph-mcp", "requests.jsonl"),
  },
  {
    name: "repo-hygiene-mcp",
    requestLogPath:
      process.env.REPO_HYGIENE_REQUEST_LOG_PATH || homePath(".hwai", "repo-hygiene-mcp", "requests.jsonl"),
  },
  {
    name: "docs-hygiene-mcp",
    requestLogPath:
      process.env.DOCS_HYGIENE_REQUEST_LOG_PATH || homePath(".hwai", "docs-hygiene-mcp", "requests.jsonl"),
  },
  {
    name: "repo-quality-gate-mcp",
    requestLogPath:
      process.env.REPO_QUALITY_GATE_REQUEST_LOG_PATH || homePath(".hwai", "repo-quality-gate-mcp", "requests.jsonl"),
  },
  {
    name: "contract-schema-mcp",
    requestLogPath:
      process.env.CONTRACT_SCHEMA_REQUEST_LOG_PATH || homePath(".hwai", "contract-schema-mcp", "requests.jsonl"),
  },
  {
    name: "dependency-risk-mcp",
    requestLogPath:
      process.env.DEPENDENCY_RISK_REQUEST_LOG_PATH || homePath(".hwai", "dependency-risk-mcp", "requests.jsonl"),
  },
  {
    name: "docs-sync-mcp",
    requestLogPath:
      process.env.DOCS_SYNC_REQUEST_LOG_PATH || homePath(".hwai", "docs-sync-mcp", "requests.jsonl"),
  },
  {
    name: "router-lite-mcp",
    requestLogPath:
      process.env.ROUTER_LITE_REQUEST_LOG_PATH || homePath(".hwai", "router-lite-mcp", "requests.jsonl"),
  },
];

const window = resolveWindow();
const serviceReports = {};
for (const service of services) {
  const requestRows = (await readJsonl(service.requestLogPath)).filter((row) => inWindow(row, window));
  const feedbackRows = service.feedbackLogPath
    ? (await readJsonl(service.feedbackLogPath)).filter((row) => inWindow(row, window))
    : [];
  serviceReports[service.name] = serviceRollup(service, requestRows, feedbackRows);
}

const totals = Object.values(serviceReports).reduce(
  (acc, item) => {
    acc.requests += item.requests;
    acc.errors += item.errors;
    acc.actionable_error_count += item.actionable_error_count;
    acc.proof_loop_error_count += item.proof_loop_error_count;
    acc.token_events += item.token_events;
    acc.source_tokens_estimate += item.source_tokens_estimate;
    acc.compact_tokens_estimate += item.compact_tokens_estimate;
    acc.saved_tokens_estimate += item.saved_tokens_estimate;
    acc.high_uncertainty_count += item.high_uncertainty_count;
    acc.actionable_high_uncertainty_count += item.actionable_high_uncertainty_count;
    acc.proof_loop_high_uncertainty_count += item.proof_loop_high_uncertainty_count;
    acc.reviewed_helpful_high_uncertainty_count += item.reviewed_helpful_high_uncertainty_count;
    acc.feedback_benchmark_candidates += item.feedback.benchmark_candidates;
    return acc;
  },
  {
    requests: 0,
    errors: 0,
    actionable_error_count: 0,
    proof_loop_error_count: 0,
    token_events: 0,
    source_tokens_estimate: 0,
    compact_tokens_estimate: 0,
    saved_tokens_estimate: 0,
    high_uncertainty_count: 0,
    actionable_high_uncertainty_count: 0,
    proof_loop_high_uncertainty_count: 0,
    reviewed_helpful_high_uncertainty_count: 0,
    feedback_benchmark_candidates: 0,
  },
);

const report = {
  schema_version: "hwai-utility-mcp-measurement-report.v1",
  generated_at: new Date().toISOString(),
  filters: {
    date: window.date,
    since_iso: window.sinceIso,
    until_iso: window.untilIso,
  },
  summary: {
    ...totals,
    savings_pct:
      totals.source_tokens_estimate > 0
        ? round((totals.saved_tokens_estimate / totals.source_tokens_estimate) * 100)
        : 0,
  },
  services: serviceReports,
};
report.recommendations = buildRecommendations(Object.values(serviceReports));
report.pantheon_export = buildPantheonExport(report);

const format = argValue("--format", "json");
const allowedFormats = new Set(["json", "markdown", "pantheon"]);
if (!allowedFormats.has(format)) {
  console.error(`Unsupported --format=${format}. Expected one of: ${Array.from(allowedFormats).join(", ")}`);
  process.exit(1);
}

const rendered =
  format === "markdown"
    ? renderMarkdown(report)
    : format === "pantheon"
      ? `${JSON.stringify(report.pantheon_export, null, 2)}\n`
      : `${JSON.stringify(report, null, 2)}\n`;
const outPath = argValue("--out", "");

if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), format }, null, 2));
} else {
  process.stdout.write(rendered);
}
