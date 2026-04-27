#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getStaticAnalysisConfig } from "../dist/config.js";
import {
  getCommandPolicy,
  runEslint,
  runGitleaks,
  runSemgrepLocal,
  runTestsChanged,
  runTsc,
  summarizeSarif,
} from "../dist/analyzers.js";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function assert(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

async function writeFixture(dir, fileName, content) {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

const config = getStaticAnalysisConfig();
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "static-analysis-bench-"));
const missingTscRoot = await fs.mkdtemp(path.join(os.tmpdir(), "static-analysis-missing-tsc-"));
const failures = [];

const fakeTsc = await writeFixture(
  tmpRoot,
  "fake-tsc.mjs",
  "console.error(\"src/broken.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.\"); process.exit(2);",
);
const fakeEslint = await writeFixture(
  tmpRoot,
  "fake-eslint.mjs",
  `console.log(JSON.stringify([
  {
    filePath: "${path.join(tmpRoot, "src", "bad.ts").replace(/\\/g, "\\\\")}",
    messages: [
      { line: 4, column: 9, severity: 2, message: "Unexpected any.", ruleId: "@typescript-eslint/no-explicit-any" }
    ]
  }
])); process.exit(1);`,
);
const fakeGitleaks = await writeFixture(
  tmpRoot,
  "fake-gitleaks.mjs",
  `console.log(JSON.stringify([
  { File: "${path.join(tmpRoot, "config.env").replace(/\\/g, "\\\\")}", StartLine: 1, RuleID: "generic-api-key", Description: "Generic API key", Secret: "REDACTED" }
])); process.exit(1);`,
);
await writeFixture(
  tmpRoot,
  "fake-tests.mjs",
  "console.error(\"FAIL src/example.test.ts > saves the record\"); process.exit(1);",
);
await writeFixture(
  tmpRoot,
  "fake-semgrep.mjs",
  `console.log(JSON.stringify({
  results: [
    {
      path: "src/unsafe.ts",
      start: { line: 5, col: 11 },
      check_id: "typescript.lang.security.audit.prototype-pollution",
      extra: { severity: "ERROR", message: "Possible prototype pollution." }
    },
    {
      path: "src/noisy.ts",
      start: { line: 9, col: 3 },
      check_id: "typescript.lang.best-practice.no-console",
      extra: { severity: "WARNING", message: "Avoid console logging in committed code." }
    }
  ]
})); process.exit(1);`,
);
await writeFixture(
  tmpRoot,
  "static-analysis.policy.json",
  JSON.stringify({
    schema_version: "static-analysis-command-policy.v1",
    default_preset: "bench",
    presets: {
      bench: {
        commands: {
          tsc: ["node", "fake-tsc.mjs"],
          eslint: ["node", "fake-eslint.mjs"],
          tests: ["node", "fake-tests.mjs"],
          semgrep: ["node", "fake-semgrep.mjs"],
          gitleaks: ["node", "fake-gitleaks.mjs"],
        },
      },
    },
  }, null, 2),
);
await writeFixture(
  missingTscRoot,
  "package.json",
  JSON.stringify({
    name: "missing-local-tsc-fixture",
    version: "0.0.0",
    type: "module",
    devDependencies: {
      typescript: "^5.3.0",
    },
  }, null, 2),
);
await writeFixture(
  missingTscRoot,
  "tsconfig.json",
  JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }, null, 2),
);

const policy = await getCommandPolicy(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const missingTscPolicy = await getCommandPolicy(config, {
  root_path: missingTscRoot,
  metadata: { source: "benchmark-local" },
});
const tsc = await runTsc(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const missingTsc = await runTsc(config, {
  root_path: missingTscRoot,
  metadata: { source: "benchmark-local" },
});
const eslint = await runEslint(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const tests = await runTestsChanged(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const semgrep = await runSemgrepLocal(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const gitleaks = await runGitleaks(config, {
  root_path: tmpRoot,
  command_policy_preset: "bench",
  metadata: { source: "benchmark-local" },
});
const sarif = await summarizeSarif(config, {
  root_path: tmpRoot,
  sarif_json: JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "bench-sarif" } },
        results: [
          {
            ruleId: "bench-rule",
            level: "error",
            message: { text: "Bench SARIF error" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/sarif.ts" },
                  region: { startLine: 8, startColumn: 3 },
                },
              },
            ],
          },
          {
            ruleId: "bench-warning",
            level: "warning",
            message: { text: "Bench SARIF warning" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/warn.ts" },
                  region: { startLine: 11, startColumn: 7 },
                },
              },
            ],
          },
        ],
      },
    ],
  }),
});

assert(policy.tools.tsc.source === "policy_file", "command policy should use policy file for tsc", failures);
assert(policy.tools.tests.source === "policy_file", "command policy should use policy file for tests", failures);
assert(missingTscPolicy.tools.tsc.source === "unavailable", "command policy should not suggest npx tsc when local binary is missing", failures);
assert(missingTsc.status === "skipped", "tsc should skip when local TypeScript binary is missing", failures);
assert(missingTsc.command_policy?.source === "unavailable", "missing tsc should report unavailable command source", failures);
assert(tsc.status === "failed", "tsc fixture should fail", failures);
assert(tsc.finding_counts.errors === 1, "tsc fixture should return one error", failures);
assert(tsc.findings[0]?.rule_id === "TS2322", "tsc fixture should parse TS2322", failures);
assert(tsc.command_policy?.source === "policy_file", "tsc should report policy file command source", failures);
assert(eslint.status === "failed", "eslint fixture should fail", failures);
assert(eslint.finding_counts.errors === 1, "eslint fixture should return one error", failures);
assert(eslint.findings[0]?.rule_id === "@typescript-eslint/no-explicit-any", "eslint fixture should parse rule id", failures);
assert(tests.status === "failed", "tests fixture should fail", failures);
assert(tests.finding_counts.errors === 1, "tests fixture should return one error", failures);
assert(semgrep.status === "failed", "semgrep fixture should fail", failures);
assert(semgrep.finding_counts.total === 2, "semgrep fixture should return two findings", failures);
assert(semgrep.finding_counts.errors === 1, "semgrep fixture should return one error", failures);
assert(semgrep.finding_counts.warnings === 1, "semgrep fixture should return one warning", failures);
assert(semgrep.findings[0]?.rule_id === "typescript.lang.security.audit.prototype-pollution", "semgrep fixture should parse rule id", failures);
assert(semgrep.findings[1]?.file === "src/noisy.ts", "semgrep fixture should preserve second file path", failures);
assert(gitleaks.status === "failed", "gitleaks fixture should fail", failures);
assert(gitleaks.finding_counts.errors === 1, "gitleaks fixture should return one error", failures);
assert(gitleaks.findings[0]?.rule_id === "generic-api-key", "gitleaks fixture should parse rule id", failures);
assert(sarif.status === "failed", "sarif fixture should fail on error-level finding", failures);
assert(sarif.finding_counts.total === 2, "sarif fixture should return two findings", failures);
assert(sarif.finding_counts.errors === 1, "sarif fixture should return one error", failures);
assert(sarif.finding_counts.warnings === 1, "sarif fixture should return one warning", failures);
assert(sarif.findings[0]?.rule_id === "bench-rule", "sarif fixture should parse rule id", failures);
assert(sarif.findings[1]?.rule_id === "bench-warning", "sarif fixture should parse warning rule id", failures);

const summary = {
  benchmark: "static-analysis-local-golden",
  cases: 8,
  failures,
  rows: [
    { name: "command-policy", tsc_source: policy.tools.tsc.source, tests_source: policy.tools.tests.source },
    { name: "missing-local-tsc", status: missingTsc.status, tsc_source: missingTscPolicy.tools.tsc.source },
    { name: "tsc-error", status: tsc.status, findings: tsc.finding_counts, savings_pct: tsc.input_stats.savings_pct },
    { name: "eslint-json", status: eslint.status, findings: eslint.finding_counts, savings_pct: eslint.input_stats.savings_pct },
    { name: "tests-failure", status: tests.status, findings: tests.finding_counts, savings_pct: tests.input_stats.savings_pct },
    { name: "semgrep-json", status: semgrep.status, findings: semgrep.finding_counts, savings_pct: semgrep.input_stats.savings_pct },
    { name: "gitleaks-redacted-json", status: gitleaks.status, findings: gitleaks.finding_counts, savings_pct: gitleaks.input_stats.savings_pct },
    { name: "sarif-error", status: sarif.status, findings: sarif.finding_counts, savings_pct: sarif.input_stats.savings_pct },
  ],
};

const outPath = argValue("--out", "");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  process.exit(1);
}
