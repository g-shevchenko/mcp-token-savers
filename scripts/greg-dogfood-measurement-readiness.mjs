#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function todayLocal() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  return Array.from({ length: days }, (_, index) => addDays(endDate, index - days + 1));
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function dailyPath(baseDir, date, fileName) {
  return path.join(baseDir, date, fileName.replaceAll("{date}", date));
}

function dayRow(baseDir, date, manifest, coverage) {
  const auto = manifest?.automeasurement || {};
  const summary = manifest?.summary || {};
  const coverageSummary = coverage?.summary || {};
  return {
    date,
    has_report: Boolean(manifest),
    safe_for_pantheon: manifest?.safe_for_pantheon === true,
    requests: number(summary.requests),
    production_like_request_count: number(auto.production_like_request_count),
    synthetic_request_count: number(auto.synthetic_request_count),
    real_production_like_request_count: number(auto.real_production_like_request_count),
    unknown_request_count: number(auto.unknown_request_count),
    metadata_labeled_pct: number(auto.metadata_labeled_pct),
    saved_tokens_estimate: number(summary.saved_tokens_estimate),
    source_tokens_estimate: number(summary.source_tokens_estimate),
    feedback_benchmark_candidates: number(summary.feedback_benchmark_candidates),
    actionable_error_count: number(summary.actionable_error_count),
    actionable_high_uncertainty_count: number(summary.actionable_high_uncertainty_count),
    local_production_like_services: number(coverageSummary.local_production_like_services),
    external_measurement_ready: number(coverageSummary.external_measurement_ready),
    coverage_path: dailyPath(baseDir, date, "hwai-mcp-coverage-{date}.json"),
  };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + number(row[key]), 0);
}

function max(rows, key) {
  return rows.reduce((value, row) => Math.max(value, number(row[key])), 0);
}

function pass(name, passed, detail) {
  return { name, passed, detail };
}

// --- Q4e C+D: activity-windowed + traffic-class-excluded coverage ---------
//
// The legacy `local_coverage_green` gate required ALL 17 utility MCPs to emit
// a production-like request on the single best day in the window (=== 17). For
// an opportunistic-by-design utility stack (retrieval "when target unknown",
// context-prep "noisy inputs only", router-lite "not every request") that
// invariant is structurally unreachable and the gate was red forever,
// permanently mis-advising "repair smoke coverage".
//
// C: a service is in the production-like coverage denominator only if it had
//    >=1 production-like request in the last COVERAGE_WINDOW_DAYS. Idle ones
//    are kept VISIBLE as `visible_idle` (NOT deleted).
// D: services whose traffic is inherently non-production-class are excluded
//    from the denominator BY NAME (`golden-dataset-mcp` = retrieval-benchmark
//    dataset infra), kept visible as `traffic_class_excluded`. The gate is
//    split into a BLOCKING `core_profile_coverage` and an informational
//    `extended_utility_coverage`.
// Regression-hiding guard: a service with a recent actionable error
//    (ok===false, non proof/benchmark, inside the window) is FORCE-KEPT in
//    the denominator and forces its tier gate red even if otherwise idle, so
//    "errored then went quiet" cannot silently leave scope.
//
// `trafficClass` below is a byte-faithful copy of the shared classifier in
// `mcp/source/scripts/hwai-utility-mcp-measurement-report.mjs` (parity-proven
// on every real row). It is NOT a modification of the shared classifier; the
// readiness script replays raw logs read-only so the blocking gate no longer
// depends on whether a daily coverage file was produced for each day.

const COVERAGE_LOCAL_SERVICES = [
  "retrieval-mcp",
  "context-prep-mcp",
  "vision-mcp",
  "static-analysis-mcp",
  "agent-trace-mcp",
  "playwright-trace-mcp",
  "visual-baseline-mcp",
  "repo-history-mcp",
  "golden-dataset-mcp",
  "language-graph-mcp",
  "repo-hygiene-mcp",
  "docs-hygiene-mcp",
  "repo-quality-gate-mcp",
  "contract-schema-mcp",
  "dependency-risk-mcp",
  "docs-sync-mcp",
  "router-lite-mcp",
];

// `core` profile from mcp/manifest.json (default_profile). The blocking
// public-claim coverage gate is anchored here; the rest is informational.
const COVERAGE_CORE_PROFILE = [
  "router-lite-mcp",
  "retrieval-mcp",
  "context-prep-mcp",
  "static-analysis-mcp",
  "repo-history-mcp",
  "repo-quality-gate-mcp",
];

// D: inherently non-production-class MCPs, excluded from the production-like
// denominator BY CLASSIFICATION (never deletion). golden-dataset-mcp is the
// retrieval-benchmark dataset surface (run_retrieval_dataset /
// add_case_from_feedback / import_retrieval_feedback / get_measurement_report)
// — benchmark-class by definition. The shared heuristic classifier mislabels
// its non-smoke metadata_source as production_like (the same residual-bucket
// mis-attribution Q4a documents), so the exclusion must be explicit by name,
// not trust the classifier's `production_like` label.
const COVERAGE_TRAFFIC_CLASS_EXCLUDED = new Set(["golden-dataset-mcp"]);

function coverageCleanLabel(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 80);
}

function coverageInferSurfaceFromSource(source) {
  const normalized = (source || "").toLowerCase();
  for (const surface of ["claude", "codex", "cursor", "windsurf"]) {
    if (normalized.includes(surface)) {
      return surface;
    }
  }
  return "";
}

function coverageTrafficClass(row) {
  const input = row.input || {};
  const explicit = coverageCleanLabel(input.traffic_class);
  if (["production_like", "proof", "benchmark", "unknown"].includes(explicit)) {
    return explicit;
  }

  const source = coverageCleanLabel(input.metadata_source);
  const surface = coverageCleanLabel(input.metadata_surface) || coverageInferSurfaceFromSource(source);
  const haystack = JSON.stringify({
    source,
    surface,
    tool: row.tool,
    purpose: input.purpose,
    context: input.context,
  }).toLowerCase();

  if (
    /\b(claude|codex|cursor|windsurf|agent)\b/.test(haystack) &&
    !/(smoke|e2e|proof|test|fixture|benchmark|bench|regression)/.test(source)
  ) {
    return "production_like";
  }

  if (source && !/(smoke|e2e|proof|test|fixture|benchmark|bench|regression)/.test(source)) {
    return "production_like";
  }

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
  if (
    row.service === "vision-mcp" &&
    ["fetch_image", "image_url_to_text"].includes(row.tool) &&
    input.url_host
  ) {
    return "production_like";
  }
  return "unknown";
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
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function buildCoverage(endDateIso, windowDays, logBaseDir) {
  // window = [endDate - (windowDays-1) .. endDate] inclusive, UTC days.
  const sinceMs = Date.parse(`${addDays(endDateIso, -(windowDays - 1))}T00:00:00.000Z`);
  const untilMs = Date.parse(`${addDays(endDateIso, 1)}T00:00:00.000Z`);
  const perService = [];
  for (const serviceId of COVERAGE_LOCAL_SERVICES) {
    const logPath = path.join(logBaseDir, serviceId, "requests.jsonl");
    const all = await readJsonl(logPath);
    let productionLike = 0;
    let recentActionableError = 0;
    let totalInWindow = 0;
    let lastProductionLikeDay = null;
    for (const row of all) {
      const ts = Date.parse(row?.ts || "");
      if (!(Number.isFinite(ts) && ts >= sinceMs && ts < untilMs)) continue;
      totalInWindow += 1;
      const tc = coverageTrafficClass(row);
      if (tc === "production_like") {
        productionLike += 1;
        const day = String(row.ts).slice(0, 10);
        if (!lastProductionLikeDay || day > lastProductionLikeDay) lastProductionLikeDay = day;
      }
      if (row.ok === false && tc !== "proof" && tc !== "benchmark") {
        recentActionableError += 1;
      }
    }
    const classExcluded = COVERAGE_TRAFFIC_CLASS_EXCLUDED.has(serviceId);
    const hasRecentError = recentActionableError > 0;
    const activeProductionLike = productionLike > 0;
    // D excludes by class UNLESS the regression-hiding guard force-keeps it
    // (a class-excluded service that errors must still surface).
    const forceKept = hasRecentError && (classExcluded || !activeProductionLike);
    const inDenominator = forceKept || (!classExcluded && activeProductionLike);
    let status;
    if (forceKept) status = "force_kept_recent_error";
    else if (classExcluded) status = "traffic_class_excluded";
    else if (activeProductionLike) status = "active";
    else status = "visible_idle";
    perService.push({
      service: serviceId,
      profile: COVERAGE_CORE_PROFILE.includes(serviceId) ? "core" : "extended",
      requests_in_window: totalInWindow,
      production_like_in_window: productionLike,
      recent_actionable_error_count: recentActionableError,
      last_production_like_day: lastProductionLikeDay,
      class_excluded: classExcluded,
      in_denominator: inDenominator,
      status,
    });
  }

  function tierGate(profileName) {
    const tierServices = perService.filter((s) => s.profile === profileName);
    const denominator = tierServices.filter((s) => s.in_denominator);
    // Pass iff: at least one service is actively in the denominator, every
    // denominator service is production-like-ready, and none has a recent
    // actionable error (the regression-hiding guard).
    const readyCount = denominator.filter(
      (s) => s.production_like_in_window > 0 && s.recent_actionable_error_count === 0,
    ).length;
    const errored = denominator.filter((s) => s.recent_actionable_error_count > 0);
    const passed = denominator.length > 0 && readyCount === denominator.length && errored.length === 0;
    return {
      profile: profileName,
      services_total: tierServices.length,
      services_in_denominator: denominator.length,
      services_ready: readyCount,
      services_with_recent_error: errored.map((s) => s.service),
      services_idle: tierServices.filter((s) => s.status === "visible_idle").map((s) => s.service),
      services_class_excluded: tierServices.filter((s) => s.status === "traffic_class_excluded").map((s) => s.service),
      passed,
    };
  }

  return {
    window_days: windowDays,
    window_start: addDays(endDateIso, -(windowDays - 1)),
    window_end: endDateIso,
    core: tierGate("core"),
    extended: tierGate("extended"),
    services: perService,
  };
}
// --- end Q4e C+D ----------------------------------------------------------

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Greg Dogfood Measurement Readiness - ${report.window.start}..${report.window.end}`);
  lines.push("");
  lines.push("Product: **Token Efficiency Platform for Agentic IDEs**  ");
  lines.push("Technical core: **HWAI Context Router**");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push("## Status");
  lines.push("");
  lines.push(`- Internal measurement health: ${report.status.internal_measurement_health}`);
  lines.push(`- Real proof readiness: ${report.status.real_proof_readiness}`);
  lines.push(`- Public claim readiness: ${report.status.public_claim_readiness}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Days with reports: ${report.summary.days_with_reports}/${report.window.days}`);
  lines.push(`- Real-work days: ${report.summary.real_work_days}`);
  lines.push(`- Safe days: ${report.summary.safe_days}/${report.summary.days_with_reports}`);
  lines.push(`- Unknown traffic-class requests: ${report.summary.unknown_request_count}`);
  lines.push(`- Synthetic requests: ${report.summary.synthetic_request_count}`);
  lines.push(`- Real production-like requests: ${report.summary.real_production_like_request_count}`);
  lines.push(
    `- Core coverage (last ${report.coverage.window_days}d): ${report.coverage.core.services_ready}/${report.coverage.core.services_in_denominator} active core MCPs production-like-ready`,
  );
  lines.push(
    `- Extended coverage (last ${report.coverage.window_days}d, informational): ${report.coverage.extended.services_ready}/${report.coverage.extended.services_in_denominator} active extended MCPs`,
  );
  lines.push(`- Max external measurement-ready/day: ${report.summary.max_external_measurement_ready}/4`);
  lines.push(`- Feedback benchmark candidates: ${report.summary.feedback_benchmark_candidates}`);
  lines.push(`- Actionable errors: ${report.summary.actionable_error_count}`);
  lines.push(`- Actionable high-uncertainty traces: ${report.summary.actionable_high_uncertainty_count}`);
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  for (const gate of report.gates) {
    lines.push(`- ${gate.passed ? "PASS" : "WAIT"} ${gate.name}: ${gate.detail}`);
  }
  lines.push("");
  lines.push(`## Utility MCP Coverage (last ${report.coverage.window_days}d, all services stay visible)`);
  lines.push("");
  lines.push("| Service | Profile | Status | In Denominator | Prod-like (window) | Recent Actionable Errors | Last Prod-like Day |");
  lines.push("| --- | --- | --- | :---: | ---: | ---: | --- |");
  for (const svc of report.coverage.services) {
    lines.push(
      `| ${svc.service} | ${svc.profile} | ${svc.status} | ${svc.in_denominator ? "yes" : "no"} | ${svc.production_like_in_window} | ${svc.recent_actionable_error_count} | ${svc.last_production_like_day || "-"} |`,
    );
  }
  lines.push("");
  lines.push("- `active`: >=1 production-like request in the window.");
  lines.push("- `visible_idle`: catalogued, installed, simply not used in the window (idle != broken; NOT a smoke gap).");
  lines.push("- `traffic_class_excluded`: inherently benchmark/dataset infra (golden-dataset-mcp) — never in the production-like denominator, never deleted.");
  lines.push("- `force_kept_recent_error`: idle/excluded but had a recent actionable error; force-kept so a regression cannot silently leave scope.");
  lines.push("");
  lines.push("## Daily Rows");
  lines.push("");
  lines.push("| Date | Report | Safe | Real Reqs | Synthetic | Unknown | Local Svcs | External Ready | Feedback Candidates |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.rows) {
    lines.push(
      `| ${row.date} | ${row.has_report ? "yes" : "no"} | ${row.safe_for_pantheon ? "yes" : "no"} | ${row.real_production_like_request_count} | ${row.synthetic_request_count} | ${row.unknown_request_count} | ${row.local_production_like_services} | ${row.external_measurement_ready} | ${row.feedback_benchmark_candidates} |`,
    );
  }
  lines.push("");
  lines.push("## Next Action");
  lines.push("");
  lines.push(report.next_action);
  lines.push("");
  lines.push("This is internal measurement governance. It is not a public benchmark claim.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const endDate = argValue("--end-date", todayLocal());
const daysCount = Number(argValue("--days", "7"));
const minRealDays = Number(argValue("--min-real-days", "3"));
const minRealRequests = Number(argValue("--min-real-requests", "30"));
const minFixtureCandidates = Number(argValue("--min-fixture-candidates", "3"));
// Q4e: activity-window for the production-like coverage denominator. N=7 is
// data-justified — the request logs show a sharp bimodal split (the actively
// used subset has last-production-like gaps <=3d; every dormant service has a
// 13d gap to a single snapshot-frozen day). N=7 cleanly separates "in use"
// from "dormant"; N>=13 would re-include every dormant service via that one
// frozen day, defeating C. Override via --coverage-window-days.
const coverageWindowDays = Number(argValue("--coverage-window-days", "7"));
// Raw per-MCP request logs (one dir per service under ~/.hwai). Overridable
// for the measure-before-deploy A/B replay against a fixture corpus.
const coverageLogBaseDir = path.resolve(
  argValue("--coverage-log-base-dir", path.join(os.homedir(), ".hwai")),
);
const baseDir = path.resolve(
  argValue("--base-dir", path.join(os.homedir(), ".hwai", "token-efficiency-platform", "daily")),
);
const outPath = path.resolve(argValue("--out", path.join(baseDir, `greg-dogfood-measurement-readiness-${endDate}.md`)));
const jsonOut = path.resolve(
  argValue("--json-out", path.join(baseDir, `greg-dogfood-measurement-readiness-${endDate}.json`)),
);
const days = dateRange(endDate, Number.isFinite(daysCount) && daysCount > 0 ? daysCount : 7);

const rows = [];
for (const date of days) {
  const manifest = await readJson(dailyPath(baseDir, date, "hwai-utility-mcp-daily-manifest-{date}.json"));
  const coverage = await readJson(dailyPath(baseDir, date, "hwai-mcp-coverage-{date}.json"));
  rows.push(dayRow(baseDir, date, manifest, coverage));
}

const coverage = await buildCoverage(
  endDate,
  Number.isFinite(coverageWindowDays) && coverageWindowDays > 0 ? coverageWindowDays : 7,
  coverageLogBaseDir,
);

const realWorkDays = rows.filter((row) => row.real_production_like_request_count > 0).length;
const daysWithReports = rows.filter((row) => row.has_report).length;
const safeDays = rows.filter((row) => row.safe_for_pantheon).length;
const summary = {
  days_with_reports: daysWithReports,
  safe_days: safeDays,
  real_work_days: realWorkDays,
  requests: sum(rows, "requests"),
  unknown_request_count: sum(rows, "unknown_request_count"),
  synthetic_request_count: sum(rows, "synthetic_request_count"),
  real_production_like_request_count: sum(rows, "real_production_like_request_count"),
  max_local_production_like_services: max(rows, "local_production_like_services"),
  max_external_measurement_ready: max(rows, "external_measurement_ready"),
  feedback_benchmark_candidates: sum(rows, "feedback_benchmark_candidates"),
  actionable_error_count: sum(rows, "actionable_error_count"),
  actionable_high_uncertainty_count: sum(rows, "actionable_high_uncertainty_count"),
  // Q4e C+D coverage summary (activity-windowed + traffic-class-excluded).
  coverage_window_days: coverage.window_days,
  core_coverage_in_denominator: coverage.core.services_in_denominator,
  core_coverage_ready: coverage.core.services_ready,
  core_coverage_recent_error_services: coverage.core.services_with_recent_error,
  core_coverage_idle_services: coverage.core.services_idle,
  extended_coverage_in_denominator: coverage.extended.services_in_denominator,
  extended_coverage_ready: coverage.extended.services_ready,
};

function coverageDetail(tier) {
  const parts = [
    `${tier.services_ready}/${tier.services_in_denominator} active services production-like-ready`,
    `(${tier.services_total} catalogued`,
    `${tier.services_idle.length} visible_idle`,
    `${tier.services_class_excluded.length} traffic_class_excluded)`,
  ];
  if (tier.services_with_recent_error.length > 0) {
    parts.push(`recent actionable error: ${tier.services_with_recent_error.join(", ")}`);
  }
  return parts.join(" ");
}

const gates = [
  pass("safe_daily_exports", daysWithReports > 0 && safeDays === daysWithReports, `${safeDays}/${daysWithReports} report days safe`),
  pass("unknown_traffic_zero", summary.unknown_request_count === 0, `${summary.unknown_request_count} unknown requests`),
  // Q4e: replaces `local_coverage_green` (the structurally-unreachable
  // `=== 17` invariant). Blocking gate over the `core` manifest profile,
  // activity-windowed denominator + golden-dataset traffic-class exclusion +
  // regression-hiding guard. Idle / excluded services stay visible (no
  // deletion) in `report.coverage.services`.
  pass("core_profile_coverage", coverage.core.passed, coverageDetail(coverage.core)),
  pass("external_measurement_ready", summary.max_external_measurement_ready === 4, `${summary.max_external_measurement_ready}/4 external services`),
  pass("real_work_days", realWorkDays >= minRealDays, `${realWorkDays}/${minRealDays} days with real production-like requests`),
  pass(
    "real_work_volume",
    summary.real_production_like_request_count >= minRealRequests,
    `${summary.real_production_like_request_count}/${minRealRequests} real production-like requests`,
  ),
  pass(
    "fixture_candidates",
    summary.feedback_benchmark_candidates >= minFixtureCandidates,
    `${summary.feedback_benchmark_candidates}/${minFixtureCandidates} feedback benchmark candidates`,
  ),
  // Informational only — never enters the blocking health/proof slices below.
  pass("extended_utility_coverage", coverage.extended.passed, coverageDetail(coverage.extended)),
];

// Blocking slices reference gates by NAME (order-independent) so the
// informational `extended_utility_coverage` can never gate readiness.
const BLOCKING_HEALTH_GATES = ["safe_daily_exports", "unknown_traffic_zero", "core_profile_coverage", "external_measurement_ready"];
const BLOCKING_PROOF_GATES = [...BLOCKING_HEALTH_GATES, "real_work_days", "real_work_volume", "fixture_candidates"];
const gateByName = Object.fromEntries(gates.map((g) => [g.name, g]));
const internalMeasurementHealth = BLOCKING_HEALTH_GATES.every((n) => gateByName[n].passed)
  ? "green"
  : "needs_attention";
const realProofReadiness = BLOCKING_PROOF_GATES.every((n) => gateByName[n].passed)
  ? "green"
  : "collect_more_real_data";
const publicClaimReadiness = realProofReadiness === "green" ? "human_review_required" : "not_ready";

let nextAction = "- Keep collecting real Greg workflows without manual smoke; review misses at the 19:00 daily note.";
if (summary.unknown_request_count > 0) {
  nextAction = "- Fix metadata routing first: unknown traffic-class requests are present.";
} else if (!coverage.core.passed) {
  if (coverage.core.services_with_recent_error.length > 0) {
    nextAction = `- Investigate recent actionable error(s) in core coverage: ${coverage.core.services_with_recent_error.join(", ")}.`;
  } else if (coverage.core.services_in_denominator === 0) {
    nextAction = `- No core utility MCP had production-like traffic in the last ${coverage.window_days}d; resume real Greg work on the core profile (idle != broken, not a smoke gap).`;
  } else {
    nextAction = "- Some actively-used core utility MCP is not production-like-ready; review its recent traffic before evaluating product claims.";
  }
} else if (realWorkDays < minRealDays) {
  nextAction = "- Collect more real Greg work days; synthetic coverage is healthy but not proof of real ROI.";
} else if (summary.feedback_benchmark_candidates < minFixtureCandidates) {
  nextAction = "- Promote real misses/friction into reviewed fixture candidates.";
}

const report = {
  schema_version: "hwai-greg-dogfood-measurement-readiness.v1",
  generated_at: new Date().toISOString(),
  product: "Token Efficiency Platform for Agentic IDEs",
  technical_core: "HWAI Context Router",
  window: {
    start: days[0],
    end: days[days.length - 1],
    days: days.length,
  },
  thresholds: {
    min_real_days: minRealDays,
    min_real_requests: minRealRequests,
    min_fixture_candidates: minFixtureCandidates,
    coverage_window_days: coverage.window_days,
  },
  status: {
    internal_measurement_health: internalMeasurementHealth,
    real_proof_readiness: realProofReadiness,
    public_claim_readiness: publicClaimReadiness,
  },
  summary,
  gates,
  // Q4e: all 17 utility MCPs stay VISIBLE here with explicit status
  // (active / visible_idle / traffic_class_excluded / force_kept_recent_error).
  // "Descope" is a denominator semantic, never service removal.
  coverage,
  rows,
  next_action: nextAction,
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, renderMarkdown(report), "utf8");
await fs.writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ wrote: outPath, json: jsonOut, status: report.status, summary }, null, 2));
