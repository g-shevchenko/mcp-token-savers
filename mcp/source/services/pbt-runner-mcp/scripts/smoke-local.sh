#!/usr/bin/env bash
# Smoke test for pbt-runner-mcp v0.1.0 — validates parsers + suggester + recorder.
# Skips runProperty integration (requires hypothesis or fast-check installed in host env).
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --silent --no-fund --no-audit
[ -d dist ] || npm run build --silent

node --input-type=module -e "
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseHypothesisOutput,
  parseFastCheckOutput,
  suggestStrategies,
  recordPropertyRun,
} from './dist/index.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pbt-runner-mcp-smoke-'));
try {
  // ===== parseHypothesisOutput =====
  const ph1 = parseHypothesisOutput('Hypothesis: 100 examples passed.', '', 0);
  assert.equal(ph1.outcome, 'passed');
  assert.equal(ph1.examples_tried, 100);
  console.log('  PASS  parseHypothesisOutput — passed + examples_tried parsed');

  const ph2 = parseHypothesisOutput('', 'Falsifying example: _test_property(\n    x=42,\n)', 1);
  assert.equal(ph2.outcome, 'falsified');
  assert.ok(ph2.counterexample && ph2.counterexample.includes('x=42'));
  console.log('  PASS  parseHypothesisOutput — falsified + counterexample extracted');

  const ph3 = parseHypothesisOutput('', 'ImportError: No module named hypothesis', 1);
  assert.equal(ph3.outcome, 'error');
  console.log('  PASS  parseHypothesisOutput — ImportError → error');

  // ===== parseFastCheckOutput =====
  const pf1 = parseFastCheckOutput('', '', 0);
  assert.equal(pf1.outcome, 'passed');
  console.log('  PASS  parseFastCheckOutput — passed');

  const pf2 = parseFastCheckOutput('Property failed after 17 tests\nCounterexample: [42, -1]', '', 1);
  assert.equal(pf2.outcome, 'falsified');
  assert.ok(pf2.counterexample && pf2.counterexample.includes('[42, -1]'));
  assert.equal(pf2.examples_tried, 17);
  console.log('  PASS  parseFastCheckOutput — falsified + counterexample + examples_tried');

  // ===== suggestStrategies =====
  const ss1 = suggestStrategies('python', 'positive integer');
  assert.match(ss1.strategies_code, /st\.integers\(min_value=1\)/);
  console.log('  PASS  suggest_strategies — python positive integer');

  const ss2 = suggestStrategies('typescript', 'list of strings');
  assert.match(ss2.strategies_code, /fc\.array\(\s*fc\.string\(\)\s*\)/);
  console.log('  PASS  suggest_strategies — typescript list of strings');

  const ss3 = suggestStrategies('python', 'boolean');
  assert.match(ss3.strategies_code, /st\.booleans\(\)/);
  console.log('  PASS  suggest_strategies — python boolean');

  const ss4 = suggestStrategies('typescript', 'non-empty string');
  assert.match(ss4.strategies_code, /fc\.string\(\{\s*minLength:\s*1\s*\}\)/);
  console.log('  PASS  suggest_strategies — typescript non-empty string');

  // ===== recordPropertyRun =====
  const sampleResult = {
    outcome: 'passed',
    counterexample: null,
    shrunk_input: null,
    examples_tried: 100,
    raw_output: 'Hypothesis: 100 examples passed.',
    exit_code: 0,
    exec_ms: 1234,
    error_message: null,
  };
  const rec1 = await recordPropertyRun('commutativity', 'invariant', sampleResult, { rootDir: tmpDir });
  assert.equal(rec1.recorded, true);
  assert.ok(rec1.run_id.startsWith('run_'));
  console.log('  PASS  record_property_run — new run recorded with run_id');

  const file = path.join(tmpDir, '.agent/pbt/runs.jsonl');
  const raw = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.property_name, 'commutativity');
  assert.equal(parsed.archetype, 'invariant');
  assert.ok(parsed.recorded_at);
  console.log('  PASS  record_property_run — persisted to .agent/pbt/runs.jsonl');

  try {
    await recordPropertyRun('p', 'banana', sampleResult, { rootDir: tmpDir });
    assert.fail('expected throw on invalid archetype');
  } catch (e) {
    assert.match(e.message, /archetype/);
  }
  console.log('  PASS  record_property_run — invalid archetype rejected');

  console.log('\\nAll 11 smoke checks PASSED.');
  console.log('Note: run_property integration not smoke-tested (requires hypothesis or fast-check installed).');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
"
