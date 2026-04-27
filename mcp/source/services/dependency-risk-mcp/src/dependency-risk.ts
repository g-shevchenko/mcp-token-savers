import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readArtifact, writeJsonArtifact } from "./artifact-store.js";
import {
  DEPENDENCY_RISK_PIPELINE_VERSION,
  DEPENDENCY_RISK_SCHEMA_VERSION,
  DependencyRiskConfig,
} from "./config.js";
import { estimateTokens, round, stableHash } from "./text-utils.js";

const execFileAsync = promisify(execFile);

export interface DependencyRiskArgs {
  allow_network?: boolean;
  audit_fix_json?: unknown;
  audit_fix_output?: string;
  audit_fix_output_path?: string;
  audit_json?: unknown;
  audit_json_path?: string;
  baseline?: unknown;
  baseline_lockfile_path?: string;
  current?: unknown;
  current_lockfile_path?: string;
  disallowed_licenses?: string[];
  lockfile_path?: string;
  max_findings?: number;
  metadata?: unknown;
  osv_json?: unknown;
  osv_json_path?: string;
  package_json_path?: string;
  package_lock_only?: boolean;
  registry_metadata?: unknown;
  registry_metadata_path?: string;
  repo_root?: string;
}

interface DependencyRow {
  dependency_type: string;
  dev: boolean;
  direct: boolean;
  has_install_script: boolean;
  has_integrity: boolean;
  license?: string;
  optional: boolean;
  package_hash: string;
  package_name: string;
  resolved_host_hash?: string;
  resolved_kind: string;
  version?: string;
}

interface LockfileIndex {
  dependency_count: number;
  dependencies: DependencyRow[];
  direct_dependency_count: number;
  lockfile_hash: string;
  lockfile_path: string;
  package_files: number;
  raw_chars: number;
}

function repoRoot(args: DependencyRiskArgs): string {
  return path.resolve(args.repo_root || process.cwd());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function maxFindings(config: DependencyRiskConfig, args: DependencyRiskArgs): number {
  const value = args.max_findings;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : config.maxFindings;
}

function baseResult(toolKind: string, root: string) {
  return {
    schema_version: DEPENDENCY_RISK_SCHEMA_VERSION,
    pipeline_version: DEPENDENCY_RISK_PIPELINE_VERSION,
    repo: {
      repo_name: path.basename(root),
      repo_root_hash: stableHash(root),
    },
    tool_kind: toolKind,
    status: "ok",
    data_policy:
      "Advisory local dependency evidence only. Request logs store counts/hashes, not raw lockfiles, audit JSON, local paths, or package manager output.",
  };
}

function attachStats<T extends object>(payload: T, rawChars: number): T & {
  compact_tokens_estimate: number;
  raw_tokens_estimate: number;
  saved_tokens_estimate: number;
  savings_pct: number;
} {
  const compactTokens = estimateTokens(JSON.stringify(payload));
  const rawTokens = estimateTokens(rawChars);
  const savedTokens = Math.max(0, rawTokens - compactTokens);
  return {
    ...payload,
    raw_tokens_estimate: rawTokens,
    compact_tokens_estimate: compactTokens,
    saved_tokens_estimate: savedTokens,
    savings_pct: rawTokens > 0 ? round((savedTokens / rawTokens) * 100) : 0,
  };
}

async function withArtifact<T extends object>(
  config: DependencyRiskConfig,
  prefix: string,
  payload: T,
): Promise<T & { artifact_file: string; artifact_url: string }> {
  const artifact = await writeJsonArtifact(config, prefix, payload);
  return {
    ...payload,
    ...artifact,
  };
}

function safeRel(root: string, value: string): string {
  const abs = path.resolve(root, value);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${value}`);
  }
  return toPosix(rel);
}

async function readJsonFile(root: string, relPath: string, maxBytes: number): Promise<{ json: any; raw: string; relPath: string }> {
  const safe = safeRel(root, relPath);
  const abs = path.join(root, safe);
  const stat = await fs.stat(abs);
  if (stat.size > maxBytes) {
    throw new Error(`JSON file exceeds max_json_bytes: ${safe}`);
  }
  const raw = await fs.readFile(abs, "utf8");
  return { json: JSON.parse(raw), raw, relPath: safe };
}

async function readTextFile(root: string, relPath: string, maxBytes: number): Promise<{ raw: string; relPath: string }> {
  const safe = safeRel(root, relPath);
  const abs = path.join(root, safe);
  const stat = await fs.stat(abs);
  if (stat.size > maxBytes) {
    throw new Error(`text file exceeds max_json_bytes: ${safe}`);
  }
  const raw = await fs.readFile(abs, "utf8");
  return { raw, relPath: safe };
}

async function readOptionalJsonFile(root: string, relPath: string | undefined, fallback: string, maxBytes: number) {
  return readJsonFile(root, relPath || fallback, maxBytes);
}

function parseJsonWithOptionalPrelude(raw: string): { json: any; leading_chars: number; leading_lines: number } {
  try {
    return { json: JSON.parse(raw), leading_chars: 0, leading_lines: 0 };
  } catch {
    const objectIndex = raw.indexOf("{");
    const arrayIndex = raw.indexOf("[");
    const candidates = [objectIndex, arrayIndex].filter((index) => index >= 0);
    const start = candidates.length > 0 ? Math.min(...candidates) : -1;
    if (start < 0) {
      throw new Error("npm audit fix dry-run output did not contain JSON");
    }
    const prelude = raw.slice(0, start);
    return {
      json: JSON.parse(raw.slice(start)),
      leading_chars: start,
      leading_lines: prelude.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
    };
  }
}

function normalizeLicense(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" OR ") || undefined;
  }
  if (value && typeof value === "object") {
    const type = (value as Record<string, unknown>).type;
    return typeof type === "string" && type.trim() ? type.trim() : undefined;
  }
  return undefined;
}

function packageNameFromLockPath(lockPath: string, pkg: any): string {
  if (typeof pkg?.name === "string" && pkg.name) {
    return pkg.name;
  }
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) {
    return lockPath;
  }
  return lockPath.slice(index + marker.length);
}

function classifyResolved(value: unknown): { hostHash?: string; kind: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { kind: "missing" };
  }
  const resolved = value.trim();
  if (resolved.startsWith("git+") || resolved.startsWith("git://") || resolved.startsWith("ssh://")) {
    return { kind: "git" };
  }
  if (resolved.startsWith("file:")) {
    return { kind: "file" };
  }
  if (resolved.startsWith("link:")) {
    return { kind: "link" };
  }
  try {
    const url = new URL(resolved);
    const hostHash = stableHash(url.host);
    if (url.protocol === "http:") {
      return { hostHash, kind: "insecure_http" };
    }
    if (url.protocol === "https:" && (url.host === "registry.npmjs.org" || url.host.endsWith(".npmjs.org"))) {
      return { hostHash, kind: "npm_registry" };
    }
    if (url.protocol === "https:") {
      return { hostHash, kind: "external_https" };
    }
  } catch {
    // Fall through to opaque source labels without returning the raw value.
  }
  return { kind: "other" };
}

function dependencyRow(packageName: string, pkg: any, directTypes: Map<string, string>): DependencyRow {
  const resolved = classifyResolved(pkg?.resolved);
  return {
    dependency_type: directTypes.get(packageName) || "transitive",
    dev: pkg?.dev === true,
    direct: directTypes.has(packageName),
    has_install_script: pkg?.hasInstallScript === true,
    has_integrity: typeof pkg?.integrity === "string" && pkg.integrity.trim().length > 0,
    license: normalizeLicense(pkg?.license),
    optional: pkg?.optional === true,
    package_hash: stableHash(packageName),
    package_name: packageName,
    resolved_host_hash: resolved.hostHash,
    resolved_kind: resolved.kind,
    version: typeof pkg?.version === "string" ? pkg.version : undefined,
  };
}

function directDependencyTypes(packageJson: any): Map<string, string> {
  const rows = new Map<string, string>();
  const groups: Array<[string, string]> = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ];
  for (const [field, type] of groups) {
    const deps = packageJson?.[field];
    if (!deps || typeof deps !== "object") {
      continue;
    }
    for (const name of Object.keys(deps).sort()) {
      if (!rows.has(name)) {
        rows.set(name, type);
      }
    }
  }
  return rows;
}

function indexPackageLock(lockfile: any, packageJson: any, sourcePath: string, rawChars: number): LockfileIndex {
  const directTypes = directDependencyTypes(packageJson);
  const rows: DependencyRow[] = [];
  const packages = lockfile?.packages && typeof lockfile.packages === "object" ? lockfile.packages : null;
  if (packages) {
    for (const [lockPath, pkg] of Object.entries(packages as Record<string, any>)) {
      if (!lockPath || lockPath === "" || !lockPath.includes("node_modules/")) {
        continue;
      }
      const packageName = packageNameFromLockPath(lockPath, pkg);
      rows.push(dependencyRow(packageName, pkg, directTypes));
    }
  } else if (lockfile?.dependencies && typeof lockfile.dependencies === "object") {
    for (const [packageName, pkg] of Object.entries(lockfile.dependencies as Record<string, any>)) {
      rows.push(dependencyRow(packageName, pkg, directTypes));
    }
  }
  rows.sort((a, b) => a.package_name.localeCompare(b.package_name));
  return {
    dependency_count: rows.length,
    dependencies: rows,
    direct_dependency_count: rows.filter((row) => row.direct).length,
    lockfile_hash: stableHash(JSON.stringify(lockfile)),
    lockfile_path: sourcePath,
    package_files: 1,
    raw_chars: rawChars,
  };
}

async function loadLockfileIndex(config: DependencyRiskConfig, args: DependencyRiskArgs, lockfilePath?: string, lockfileObject?: unknown) {
  const root = repoRoot(args);
  const packageFile = await readOptionalJsonFile(root, args.package_json_path, "package.json", config.maxJsonBytes).catch(() => ({
    json: {},
    raw: "",
    relPath: "package.json",
  }));
  if (lockfileObject && typeof lockfileObject === "object") {
    return indexPackageLock(lockfileObject, packageFile.json, "input-lockfile", JSON.stringify(lockfileObject).length);
  }
  const lockfile = await readOptionalJsonFile(root, lockfilePath || args.lockfile_path, "package-lock.json", config.maxJsonBytes);
  return indexPackageLock(lockfile.json, packageFile.json, lockfile.relPath, lockfile.raw.length + packageFile.raw.length);
}

function majorOf(version: string | undefined): number | null {
  const match = /^(\d+)/.exec(version || "");
  return match ? Number(match[1]) : null;
}

function disallowedSet(config: DependencyRiskConfig, args: DependencyRiskArgs): Set<string> {
  const values = Array.isArray(args.disallowed_licenses) && args.disallowed_licenses.length > 0
    ? args.disallowed_licenses
    : config.defaultDisallowedLicenses;
  return new Set(values.map((item) => item.toLowerCase()));
}

function licenseIsDisallowed(license: string | undefined, disallowed: Set<string>): boolean {
  if (!license) {
    return false;
  }
  const normalized = license.toLowerCase();
  for (const value of disallowed) {
    if (normalized.includes(value)) {
      return true;
    }
  }
  return false;
}

export async function summarizeLockfileDiff(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  const baseline = await loadLockfileIndex(config, args, args.baseline_lockfile_path, args.baseline);
  const current = await loadLockfileIndex(config, args, args.current_lockfile_path || args.lockfile_path, args.current);
  const baselineMap = new Map(baseline.dependencies.map((row) => [row.package_name, row]));
  const currentMap = new Map(current.dependencies.map((row) => [row.package_name, row]));
  const added = current.dependencies.filter((row) => !baselineMap.has(row.package_name));
  const removed = baseline.dependencies.filter((row) => !currentMap.has(row.package_name));
  const changed = current.dependencies
    .filter((row) => baselineMap.has(row.package_name) && baselineMap.get(row.package_name)?.version !== row.version)
    .map((row) => {
      const previous = baselineMap.get(row.package_name);
      const previousMajor = majorOf(previous?.version);
      const nextMajor = majorOf(row.version);
      return {
        package_name: row.package_name,
        package_hash: row.package_hash,
        from_version: previous?.version,
        to_version: row.version,
        direct: row.direct || previous?.direct === true,
        major_bump: previousMajor !== null && nextMajor !== null && nextMajor > previousMajor,
      };
    });
  const result = attachStats(
    {
      ...baseResult("lockfile_diff", root),
      baseline_dependency_count: baseline.dependency_count,
      current_dependency_count: current.dependency_count,
      dependency_count: current.dependency_count,
      direct_dependency_count: current.direct_dependency_count,
      added_dependencies_count: added.length,
      removed_dependencies_count: removed.length,
      changed_dependencies_count: changed.length,
      major_bumps_count: changed.filter((row) => row.major_bump).length,
      added_dependencies: added.slice(0, maxFindings(config, args)),
      removed_dependencies: removed.slice(0, maxFindings(config, args)),
      changed_dependencies: changed.slice(0, maxFindings(config, args)),
      lockfile_hashes: {
        baseline: baseline.lockfile_hash,
        current: current.lockfile_hash,
      },
      truncated: added.length + removed.length + changed.length > maxFindings(config, args) * 3,
    },
    baseline.raw_chars + current.raw_chars,
  );
  return withArtifact(config, "lockfile-diff", result);
}

export async function checkLicenses(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  const index = await loadLockfileIndex(config, args);
  const disallowed = disallowedSet(config, args);
  const unknown = index.dependencies.filter((row) => !row.license);
  const disallowedRows = index.dependencies.filter((row) => licenseIsDisallowed(row.license, disallowed));
  const byLicense: Record<string, number> = {};
  for (const row of index.dependencies) {
    const license = row.license || "UNKNOWN";
    byLicense[license] = (byLicense[license] || 0) + 1;
  }
  const result = attachStats(
    {
      ...baseResult("license_check", root),
      dependency_count: index.dependency_count,
      direct_dependency_count: index.direct_dependency_count,
      unknown_license_count: unknown.length,
      disallowed_license_count: disallowedRows.length,
      license_counts: Object.fromEntries(Object.entries(byLicense).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      unknown_license_packages: unknown.slice(0, maxFindings(config, args)),
      disallowed_license_packages: disallowedRows.slice(0, maxFindings(config, args)),
      lockfile_hash: index.lockfile_hash,
      truncated: unknown.length + disallowedRows.length > maxFindings(config, args) * 2,
    },
    index.raw_chars,
  );
  return withArtifact(config, "license-check", result);
}

function supplyChainFlags(row: DependencyRow): string[] {
  const flags: string[] = [];
  if (row.has_install_script) {
    flags.push("install_script");
  }
  if (!row.has_integrity && row.resolved_kind !== "file" && row.resolved_kind !== "link") {
    flags.push("missing_integrity");
  }
  if (row.resolved_kind === "insecure_http") {
    flags.push("insecure_http_resolved");
  }
  if (row.resolved_kind === "external_https") {
    flags.push("external_https_resolved");
  }
  if (row.resolved_kind === "git") {
    flags.push("git_resolved");
  }
  if (row.resolved_kind === "file") {
    flags.push("file_resolved");
  }
  if (row.resolved_kind === "link") {
    flags.push("link_dependency");
  }
  if (row.resolved_kind === "other") {
    flags.push("opaque_resolved");
  }
  return flags;
}

export async function summarizeSupplyChainRisk(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  const index = await loadLockfileIndex(config, args);
  const findings = index.dependencies
    .map((row) => ({ row, risk_flags: supplyChainFlags(row) }))
    .filter((item) => item.risk_flags.length > 0)
    .map((item) => ({
      dependency_type: item.row.dependency_type,
      direct: item.row.direct,
      package_hash: item.row.package_hash,
      package_name: item.row.package_name,
      resolved_host_hash: item.row.resolved_host_hash,
      resolved_kind: item.row.resolved_kind,
      risk_flags: item.risk_flags,
      version: item.row.version,
    }));
  const resolvedKindCounts: Record<string, number> = {};
  for (const row of index.dependencies) {
    resolvedKindCounts[row.resolved_kind] = (resolvedKindCounts[row.resolved_kind] || 0) + 1;
  }
  const result = attachStats(
    {
      ...baseResult("supply_chain_risk", root),
      dependency_count: index.dependency_count,
      direct_dependency_count: index.direct_dependency_count,
      external_resolved_count: index.dependencies.filter((row) =>
        ["external_https", "git", "file", "link", "other"].includes(row.resolved_kind),
      ).length,
      git_resolved_count: index.dependencies.filter((row) => row.resolved_kind === "git").length,
      insecure_resolved_count: index.dependencies.filter((row) => row.resolved_kind === "insecure_http").length,
      install_script_packages_count: index.dependencies.filter((row) => row.has_install_script).length,
      missing_integrity_count: index.dependencies.filter((row) => !row.has_integrity && row.resolved_kind !== "file" && row.resolved_kind !== "link").length,
      npm_registry_resolved_count: index.dependencies.filter((row) => row.resolved_kind === "npm_registry").length,
      resolved_kind_counts: Object.fromEntries(Object.entries(resolvedKindCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      supply_chain_risk_count: findings.length,
      supply_chain_findings: findings.slice(0, maxFindings(config, args)),
      lockfile_hash: index.lockfile_hash,
      truncated: findings.length > maxFindings(config, args),
    },
    index.raw_chars,
  );
  return withArtifact(config, "supply-chain-risk", result);
}

function summarizeNpmAudit(root: string, audit: any, rawChars: number, config: DependencyRiskConfig, args: DependencyRiskArgs) {
  const vulnerabilities = audit?.vulnerabilities && typeof audit.vulnerabilities === "object" ? audit.vulnerabilities : {};
  const rows = Object.entries(vulnerabilities as Record<string, any>).map(([packageName, value]) => ({
    package_name: packageName,
    package_hash: stableHash(packageName),
    severity: typeof value?.severity === "string" ? value.severity : "unknown",
    via_count: Array.isArray(value?.via) ? value.via.length : 0,
    effects_count: Array.isArray(value?.effects) ? value.effects.length : 0,
    range: typeof value?.range === "string" ? value.range : undefined,
    fix_available: Boolean(value?.fixAvailable),
  }));
  const metadata = audit?.metadata?.vulnerabilities || {};
  const result = attachStats(
    {
      ...baseResult("npm_audit_summary", root),
      vulnerability_count: rows.length,
      critical_vulnerability_count: Number(metadata.critical || rows.filter((row) => row.severity === "critical").length || 0),
      high_vulnerability_count: Number(metadata.high || rows.filter((row) => row.severity === "high").length || 0),
      moderate_vulnerability_count: Number(metadata.moderate || rows.filter((row) => row.severity === "moderate").length || 0),
      low_vulnerability_count: Number(metadata.low || rows.filter((row) => row.severity === "low").length || 0),
      vulnerable_packages: rows.slice(0, maxFindings(config, args)),
      truncated: rows.length > maxFindings(config, args),
    },
    rawChars,
  );
  return result;
}

export async function runNpmAudit(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  if (args.audit_json && typeof args.audit_json === "object") {
    return withArtifact(config, "npm-audit-summary", summarizeNpmAudit(root, args.audit_json, JSON.stringify(args.audit_json).length, config, args));
  }
  if (args.audit_json_path) {
    const audit = await readJsonFile(root, args.audit_json_path, config.maxJsonBytes);
    return withArtifact(config, "npm-audit-summary", summarizeNpmAudit(root, audit.json, audit.raw.length, config, args));
  }
  if (!args.allow_network) {
    const result = attachStats(
      {
        ...baseResult("npm_audit_summary", root),
        status: "skipped",
        npm_audit_skipped_count: 1,
        skipped_reason: "allow_network=false and no audit_json/audit_json_path was provided",
        vulnerability_count: 0,
        critical_vulnerability_count: 0,
        high_vulnerability_count: 0,
        moderate_vulnerability_count: 0,
        low_vulnerability_count: 0,
      },
      0,
    );
    return withArtifact(config, "npm-audit-summary", result);
  }
  const { stdout } = await execFileAsync("npm", ["audit", "--json"], {
    cwd: root,
    maxBuffer: config.maxJsonBytes,
    timeout: config.toolTimeoutMs,
  }).catch((error: any) => ({ stdout: error?.stdout || "{}" }));
  const parsed = JSON.parse(stdout || "{}");
  return withArtifact(config, "npm-audit-summary", summarizeNpmAudit(root, parsed, stdout.length, config, args));
}

function buildNpmAuditFixPlanSummary(
  root: string,
  fixPlan: any,
  rawChars: number,
  parseStats: { leading_chars: number; leading_lines: number },
  config: DependencyRiskConfig,
  args: DependencyRiskArgs,
) {
  const audit = fixPlan?.audit && typeof fixPlan.audit === "object" ? fixPlan.audit : fixPlan;
  const vulnerabilities = audit?.vulnerabilities && typeof audit.vulnerabilities === "object" ? audit.vulnerabilities : {};
  const rows = Object.entries(vulnerabilities as Record<string, any>).map(([packageName, value]) => {
    const fixAvailable = value?.fixAvailable;
    const fixObject = fixAvailable && typeof fixAvailable === "object" ? fixAvailable as Record<string, unknown> : undefined;
    return {
      package_name: packageName,
      package_hash: stableHash(packageName),
      severity: typeof value?.severity === "string" ? value.severity : "unknown",
      direct: value?.isDirect === true,
      via_count: Array.isArray(value?.via) ? value.via.length : 0,
      effects_count: Array.isArray(value?.effects) ? value.effects.length : 0,
      range: typeof value?.range === "string" ? value.range : undefined,
      fix_available: Boolean(fixAvailable),
      fix_package_name: typeof fixObject?.name === "string" ? fixObject.name : undefined,
      fix_version: typeof fixObject?.version === "string" ? fixObject.version : undefined,
      fix_semver_major: fixObject?.isSemVerMajor === true,
    };
  });
  const metadata = audit?.metadata?.vulnerabilities || {};
  const added = Number(fixPlan?.added || 0);
  const removed = Number(fixPlan?.removed || 0);
  const changed = Number(fixPlan?.changed || 0);
  const result = attachStats(
    {
      ...baseResult("npm_audit_fix_plan", root),
      dry_run_added_count: Number.isFinite(added) ? added : 0,
      dry_run_removed_count: Number.isFinite(removed) ? removed : 0,
      dry_run_changed_count: Number.isFinite(changed) ? changed : 0,
      dry_run_net_package_delta: (Number.isFinite(added) ? added : 0) - (Number.isFinite(removed) ? removed : 0),
      audited_package_count: Number(fixPlan?.audited || 0),
      funding_package_count: Number(fixPlan?.funding || 0),
      action_prelude_chars: parseStats.leading_chars,
      action_prelude_lines_count: parseStats.leading_lines,
      parse_mode: parseStats.leading_chars > 0 ? "json_with_action_prelude" : "json",
      vulnerability_count: rows.length,
      critical_vulnerability_count: Number(metadata.critical || rows.filter((row) => row.severity === "critical").length || 0),
      high_vulnerability_count: Number(metadata.high || rows.filter((row) => row.severity === "high").length || 0),
      moderate_vulnerability_count: Number(metadata.moderate || rows.filter((row) => row.severity === "moderate").length || 0),
      low_vulnerability_count: Number(metadata.low || rows.filter((row) => row.severity === "low").length || 0),
      fix_available_count: rows.filter((row) => row.fix_available).length,
      semver_major_fix_count: rows.filter((row) => row.fix_semver_major).length,
      vulnerable_packages: rows.slice(0, maxFindings(config, args)),
      truncated: rows.length > maxFindings(config, args),
    },
    rawChars,
  );
  return result;
}

export async function summarizeNpmAuditFixPlan(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  if (args.audit_fix_json && typeof args.audit_fix_json === "object") {
    return withArtifact(
      config,
      "npm-audit-fix-plan",
      buildNpmAuditFixPlanSummary(root, args.audit_fix_json, JSON.stringify(args.audit_fix_json).length, { leading_chars: 0, leading_lines: 0 }, config, args),
    );
  }
  if (typeof args.audit_fix_output === "string") {
    const parsed = parseJsonWithOptionalPrelude(args.audit_fix_output);
    return withArtifact(
      config,
      "npm-audit-fix-plan",
      buildNpmAuditFixPlanSummary(root, parsed.json, args.audit_fix_output.length, parsed, config, args),
    );
  }
  if (args.audit_fix_output_path) {
    const output = await readTextFile(root, args.audit_fix_output_path, config.maxJsonBytes);
    const parsed = parseJsonWithOptionalPrelude(output.raw);
    return withArtifact(config, "npm-audit-fix-plan", buildNpmAuditFixPlanSummary(root, parsed.json, output.raw.length, parsed, config, args));
  }
  if (!args.allow_network) {
    const result = attachStats(
      {
        ...baseResult("npm_audit_fix_plan", root),
        status: "skipped",
        npm_audit_fix_skipped_count: 1,
        skipped_reason: "allow_network=false and no audit_fix_json/audit_fix_output/audit_fix_output_path was provided",
        vulnerability_count: 0,
        critical_vulnerability_count: 0,
        high_vulnerability_count: 0,
        moderate_vulnerability_count: 0,
        low_vulnerability_count: 0,
        fix_available_count: 0,
        semver_major_fix_count: 0,
      },
      0,
    );
    return withArtifact(config, "npm-audit-fix-plan", result);
  }
  const commandArgs = ["audit", "fix", "--dry-run", "--json"];
  if (args.package_lock_only) {
    commandArgs.push("--package-lock-only");
  }
  const { stdout } = await execFileAsync("npm", commandArgs, {
    cwd: root,
    maxBuffer: config.maxJsonBytes,
    timeout: config.toolTimeoutMs,
  }).catch((error: any) => ({ stdout: error?.stdout || "{}" }));
  const parsed = parseJsonWithOptionalPrelude(stdout || "{}");
  return withArtifact(config, "npm-audit-fix-plan", buildNpmAuditFixPlanSummary(root, parsed.json, stdout.length, parsed, config, args));
}

function summarizeOsv(root: string, osv: any, rawChars: number, config: DependencyRiskConfig, args: DependencyRiskArgs) {
  const results = Array.isArray(osv?.results) ? osv.results : [];
  const rows: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const packages = Array.isArray(result?.packages) ? result.packages : [];
    for (const pkg of packages) {
      const packageName = pkg?.package?.name || pkg?.name;
      const vulnerabilities = Array.isArray(pkg?.vulnerabilities) ? pkg.vulnerabilities : [];
      for (const vuln of vulnerabilities) {
        if (typeof packageName !== "string" || !packageName) {
          continue;
        }
        rows.push({
          package_name: packageName,
          package_hash: stableHash(packageName),
          vulnerability_id: typeof vuln?.id === "string" ? vuln.id : undefined,
          severity_count: Array.isArray(vuln?.severity) ? vuln.severity.length : 0,
          aliases_count: Array.isArray(vuln?.aliases) ? vuln.aliases.length : 0,
          fixed_versions_count: Array.isArray(vuln?.affected?.[0]?.ranges?.[0]?.events)
            ? vuln.affected[0].ranges[0].events.filter((event: any) => event.fixed).length
            : 0,
        });
      }
    }
  }
  const result = attachStats(
    {
      ...baseResult("osv_summary", root),
      osv_vulnerability_count: rows.length,
      vulnerability_count: rows.length,
      vulnerable_packages_count: new Set(rows.map((row) => row.package_name)).size,
      vulnerabilities: rows.slice(0, maxFindings(config, args)),
      truncated: rows.length > maxFindings(config, args),
    },
    rawChars,
  );
  return result;
}

export async function runOsvScanner(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  if (args.osv_json && typeof args.osv_json === "object") {
    return withArtifact(config, "osv-summary", summarizeOsv(root, args.osv_json, JSON.stringify(args.osv_json).length, config, args));
  }
  if (args.osv_json_path) {
    const osv = await readJsonFile(root, args.osv_json_path, config.maxJsonBytes);
    return withArtifact(config, "osv-summary", summarizeOsv(root, osv.json, osv.raw.length, config, args));
  }
  if (!args.allow_network) {
    const result = attachStats(
      {
        ...baseResult("osv_summary", root),
        status: "skipped",
        osv_scanner_skipped_count: 1,
        skipped_reason: "allow_network=false and no osv_json/osv_json_path was provided",
        osv_vulnerability_count: 0,
        vulnerability_count: 0,
      },
      0,
    );
    return withArtifact(config, "osv-summary", result);
  }
  await execFileAsync("osv-scanner", ["--version"], { timeout: 5_000 }).catch(() => {
    throw new Error("osv-scanner is not installed; provide osv_json_path or install the local binary");
  });
  const lockfile = safeRel(root, args.lockfile_path || "package-lock.json");
  const { stdout } = await execFileAsync("osv-scanner", ["--format=json", `--lockfile=${lockfile}`], {
    cwd: root,
    maxBuffer: config.maxJsonBytes,
    timeout: config.toolTimeoutMs,
  }).catch((error: any) => ({ stdout: error?.stdout || "{}" }));
  const parsed = JSON.parse(stdout || "{}");
  return withArtifact(config, "osv-summary", summarizeOsv(root, parsed, stdout.length, config, args));
}

function metadataMap(value: unknown): Map<string, any> {
  const map = new Map<string, any>();
  const source = (value as any)?.packages || value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return map;
  }
  for (const [name, metadata] of Object.entries(source as Record<string, any>)) {
    map.set(name, metadata);
  }
  return map;
}

function daysAgo(dateValue: unknown): number | null {
  if (typeof dateValue !== "string") {
    return null;
  }
  const time = Date.parse(dateValue);
  if (!Number.isFinite(time)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

export async function packageAgeReport(config: DependencyRiskConfig, args: DependencyRiskArgs = {}) {
  const root = repoRoot(args);
  const index = await loadLockfileIndex(config, args);
  let rawChars = index.raw_chars;
  let metadataInput = args.registry_metadata;
  if (!metadataInput && args.registry_metadata_path) {
    const metadataFile = await readJsonFile(root, args.registry_metadata_path, config.maxJsonBytes);
    metadataInput = metadataFile.json;
    rawChars += metadataFile.raw.length;
  }
  const registry = metadataMap(metadataInput);
  const rows = index.dependencies
    .filter((row) => row.direct)
    .map((row) => {
      const metadata = registry.get(row.package_name) || {};
      const latestVersion = metadata.latest_version || metadata.latest || metadata?.["dist-tags"]?.latest;
      const deprecated = Boolean(metadata.deprecated);
      const modifiedDaysAgo = daysAgo(metadata.modified || metadata.time?.modified);
      const createdDaysAgo = daysAgo(metadata.created || metadata.time?.created);
      return {
        package_name: row.package_name,
        package_hash: row.package_hash,
        current_version: row.version,
        latest_version: typeof latestVersion === "string" ? latestVersion : undefined,
        stale: typeof latestVersion === "string" && row.version !== latestVersion,
        deprecated,
        created_days_ago: createdDaysAgo,
        modified_days_ago: modifiedDaysAgo,
        age_known: createdDaysAgo !== null || modifiedDaysAgo !== null,
      };
    });
  const result = attachStats(
    {
      ...baseResult("package_age_report", root),
      dependency_count: index.dependency_count,
      direct_dependency_count: index.direct_dependency_count,
      package_age_unknown_count: rows.filter((row) => !row.age_known).length,
      stale_package_count: rows.filter((row) => row.stale).length,
      deprecated_package_count: rows.filter((row) => row.deprecated).length,
      registry_metadata_packages: registry.size,
      packages: rows.slice(0, maxFindings(config, args)),
      truncated: rows.length > maxFindings(config, args),
    },
    rawChars,
  );
  return withArtifact(config, "package-age-report", result);
}
