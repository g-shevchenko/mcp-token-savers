#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dependency-risk-mcp-benchmark-"));
process.env.DEPENDENCY_RISK_CACHE_DIR = path.join(tempDir, "cache");
const fixture = path.join(tempDir, "fixture");
await fs.mkdir(fixture, { recursive: true });

const packageJson = {
  name: "dependency-risk-fixture",
  version: "1.0.0",
  dependencies: {
    leftpad: "^1.0.0",
    "risky-lib": "^1.0.0",
  },
  devDependencies: {
    vitest: "^1.0.0",
  },
};
const baselineLock = {
  name: "dependency-risk-fixture",
  lockfileVersion: 3,
  packages: {
    "": { name: "dependency-risk-fixture", version: "1.0.0" },
    "node_modules/leftpad": { name: "leftpad", version: "1.0.0", license: "MIT", resolved: "https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz", integrity: "sha512-leftpad" },
    "node_modules/risky-lib": { name: "risky-lib", version: "1.0.0", license: "MIT", resolved: "https://registry.npmjs.org/risky-lib/-/risky-lib-1.0.0.tgz", integrity: "sha512-risky" },
    "node_modules/vitest": { name: "vitest", version: "1.0.0", dev: true, license: "MIT", resolved: "https://registry.npmjs.org/vitest/-/vitest-1.0.0.tgz", integrity: "sha512-vitest" },
  },
};
const currentLock = {
  name: "dependency-risk-fixture",
  lockfileVersion: 3,
  packages: {
    "": { name: "dependency-risk-fixture", version: "1.0.0" },
    "node_modules/leftpad": { name: "leftpad", version: "2.0.0", license: "MIT", resolved: "https://registry.npmjs.org/leftpad/-/leftpad-2.0.0.tgz", integrity: "sha512-leftpad2" },
    "node_modules/risky-lib": { name: "risky-lib", version: "1.1.0", license: "AGPL-3.0", resolved: "http://packages.example/risky-lib-1.1.0.tgz", hasInstallScript: true },
    "node_modules/new-lib": { name: "new-lib", version: "1.0.0", resolved: "git+ssh://git.example/new-lib.git" },
    "node_modules/vitest": { name: "vitest", version: "1.0.0", dev: true, license: "MIT", resolved: "https://registry.npmjs.org/vitest/-/vitest-1.0.0.tgz", integrity: "sha512-vitest" },
  },
};
const auditJson = {
  vulnerabilities: {
    "risky-lib": {
      name: "risky-lib",
      severity: "high",
      via: [{ source: 100, name: "risky-lib", severity: "high" }],
      effects: [],
      range: "<1.2.0",
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
};
const auditFixOutput = `add optional-platform 1.0.0
{
  "added": 1,
  "removed": 0,
  "changed": 1,
  "audited": 4,
  "funding": 1,
  "audit": {
    "vulnerabilities": {
      "risky-lib": {
        "name": "risky-lib",
        "severity": "high",
        "isDirect": true,
        "via": [{ "source": 100, "name": "risky-lib", "severity": "high" }],
        "effects": [],
        "range": "<1.2.0",
        "fixAvailable": { "name": "risky-lib", "version": "2.0.0", "isSemVerMajor": true }
      }
    },
    "metadata": { "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0, "total": 1 } }
  }
}
`;
const osvJson = {
  results: [
    {
      packages: [
        {
          package: { name: "risky-lib", version: "1.1.0" },
          vulnerabilities: [{ id: "GHSA-risky", aliases: ["CVE-2026-0001"], severity: [{ type: "CVSS_V3", score: "8.0" }] }],
        },
      ],
    },
  ],
};
const registryMetadata = {
  packages: {
    leftpad: { latest_version: "2.0.0", created: "2015-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" },
    "risky-lib": { latest_version: "2.0.0", created: "2017-01-01T00:00:00.000Z", modified: "2024-01-01T00:00:00.000Z", deprecated: true },
    vitest: { latest_version: "1.0.0", created: "2020-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" },
  },
};

await fs.writeFile(path.join(fixture, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(fixture, "baseline-lock.json"), `${JSON.stringify(baselineLock, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(fixture, "package-lock.json"), `${JSON.stringify(currentLock, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(fixture, "audit.json"), `${JSON.stringify(auditJson, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(fixture, "audit-fix-output.txt"), auditFixOutput, "utf8");
await fs.writeFile(path.join(fixture, "osv.json"), `${JSON.stringify(osvJson, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(fixture, "registry.json"), `${JSON.stringify(registryMetadata, null, 2)}\n`, "utf8");

const { getDependencyRiskConfig } = await import("../dist/config.js");
const {
  checkLicenses,
  packageAgeReport,
  runNpmAudit,
  runOsvScanner,
  summarizeNpmAuditFixPlan,
  summarizeSupplyChainRisk,
  summarizeLockfileDiff,
} = await import("../dist/dependency-risk.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");

const config = getDependencyRiskConfig();
const args = { repo_root: fixture, max_findings: 20, metadata: { source: "benchmark-local" } };
const diff = await summarizeLockfileDiff(config, { ...args, baseline_lockfile_path: "baseline-lock.json", current_lockfile_path: "package-lock.json" });
const licenses = await checkLicenses(config, args);
const audit = await runNpmAudit(config, { ...args, audit_json_path: "audit.json" });
const auditFix = await summarizeNpmAuditFixPlan(config, { ...args, audit_fix_output_path: "audit-fix-output.txt" });
const osv = await runOsvScanner(config, { ...args, osv_json_path: "osv.json" });
const skippedAudit = await runNpmAudit(config, args);
const age = await packageAgeReport(config, { ...args, registry_metadata_path: "registry.json" });
const supply = await summarizeSupplyChainRisk(config, args);
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combined = JSON.stringify({ diff, licenses, audit, osv, skippedAudit, age, supply, measurement });

const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

assert("lockfile-added", diff.added_dependencies_count === 1, diff);
assert("lockfile-changed", diff.changed_dependencies_count === 2 && diff.major_bumps_count === 1, diff);
assert("license-disallowed", licenses.disallowed_license_count === 1 && licenses.unknown_license_count === 1, licenses);
assert("npm-audit-high", audit.vulnerability_count === 1 && audit.high_vulnerability_count === 1, audit);
assert(
  "npm-audit-fix-plan",
  auditFix.vulnerability_count === 1
    && auditFix.dry_run_added_count === 1
    && auditFix.dry_run_changed_count === 1
    && auditFix.semver_major_fix_count === 1
    && auditFix.action_prelude_lines_count === 1,
  auditFix,
);
assert("osv-vulnerability", osv.osv_vulnerability_count === 1, osv);
assert("network-skipped", skippedAudit.status === "skipped" && skippedAudit.npm_audit_skipped_count === 1, skippedAudit);
assert("package-age", age.stale_package_count >= 1 && age.deprecated_package_count === 1, age);
assert(
  "supply-chain-lockfile-risk",
  supply.supply_chain_risk_count >= 2
    && supply.install_script_packages_count === 1
    && supply.insecure_resolved_count === 1
    && supply.git_resolved_count === 1
    && supply.missing_integrity_count >= 2
    && !combined.includes("packages.example/risky-lib-1.1.0.tgz"),
  supply,
);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("no-raw-fixture-path", !combined.includes(tempDir), {});

const result = {
  benchmark: "dependency-risk-local-golden",
  cases: 11,
  failures,
  rows: [
    { name: "added-dependencies", value: diff.added_dependencies_count },
    { name: "major-bumps", value: diff.major_bumps_count },
    { name: "disallowed-licenses", value: licenses.disallowed_license_count },
    { name: "unknown-licenses", value: licenses.unknown_license_count },
    { name: "npm-vulnerabilities", value: audit.vulnerability_count },
    { name: "npm-audit-fix-plan-vulnerabilities", value: auditFix.vulnerability_count },
    { name: "npm-audit-fix-plan-semver-major", value: auditFix.semver_major_fix_count },
    { name: "osv-vulnerabilities", value: osv.osv_vulnerability_count },
    { name: "stale-packages", value: age.stale_package_count },
    { name: "deprecated-packages", value: age.deprecated_package_count },
    { name: "supply-chain-risks", value: supply.supply_chain_risk_count },
    { name: "install-script-packages", value: supply.install_script_packages_count },
    { name: "measurement-calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
