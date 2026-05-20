#!/usr/bin/env bash
# Smoke test for test-results-mcp v0.2.0 — validates all 4 implemented tools.
# Zero deps beyond what package.json declares.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --silent --no-fund --no-audit
[ -d dist ] || npm run build --silent

node --input-type=module -e "
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initFeatureList, markPass, listFailing, getFeature } from './dist/index.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-results-mcp-smoke-'));
try {
  // ===== initFeatureList =====
  const list = await initFeatureList('demo-task', [
    { id: 'AC1', description: 'first criterion' },
    { id: 'AC2', description: 'second criterion' },
    { id: 'AC3', description: 'third', evidence_required: ['test passes'] },
  ], tmpDir);
  assert.equal(list.task_id, 'demo-task');
  assert.equal(list.schema_version, 1);
  assert.equal(list.features.length, 3);
  assert.equal(list.features[0].passes, false);
  assert.match(list.created_at, /^\\d{4}-\\d{2}-\\d{2}T/);
  console.log('  PASS  init_feature_list — creates ledger');

  // ===== file written =====
  const file = path.join(tmpDir, '.agent/tasks/demo-task/feature_list.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.equal(parsed.features[2].evidence_required[0], 'test passes');
  console.log('  PASS  feature_list.json — written to .agent/tasks/<id>/');

  // ===== init immutability =====
  try {
    await initFeatureList('demo-task', [{ id: 'X', description: 'overwrite' }], tmpDir);
    assert.fail('expected throw');
  } catch (e) { assert.match(e.message, /already exists/); }
  console.log('  PASS  init_feature_list — immutability lock');

  // ===== markPass — happy path =====
  const after = await markPass('demo-task', 'AC1', 'tests/foo.test.ts:42', tmpDir);
  const ac1 = after.features.find(f => f.id === 'AC1');
  assert.equal(ac1.passes, true);
  assert.equal(ac1.evidence_ref, 'tests/foo.test.ts:42');
  assert.match(ac1.passed_at, /^\\d{4}-\\d{2}-\\d{2}T/);
  // other features untouched
  assert.equal(after.features.find(f => f.id === 'AC2').passes, false);
  console.log('  PASS  mark_pass — flips false→true with evidence, untouched siblings');

  // ===== markPass — error cases =====
  try {
    await markPass('demo-task', 'AC1', 'second-proof', tmpDir);
    assert.fail('expected throw on re-mark');
  } catch (e) { assert.match(e.message, /already marked pass/); }
  console.log('  PASS  mark_pass — immutability (re-mark blocked)');

  try {
    await markPass('nonexistent', 'AC1', 'p', tmpDir);
    assert.fail('expected throw on missing task');
  } catch (e) { assert.match(e.message, /not found/); }
  console.log('  PASS  mark_pass — missing task rejected');

  try {
    await markPass('demo-task', 'AC1', '', tmpDir);
    assert.fail('expected throw on empty evidence');
  } catch (e) { assert.match(e.message, /evidence/); }
  console.log('  PASS  mark_pass — empty evidence_ref rejected');

  // ===== listFailing =====
  const failing = await listFailing('demo-task', tmpDir);
  assert.equal(failing.length, 2);
  assert.deepEqual(failing.map(f => f.id).sort(), ['AC2', 'AC3']);
  // compact shape — no passes/passed_at/evidence_ref
  assert.ok(!('passes' in failing[0]));
  assert.ok(!('passed_at' in failing[0]));
  console.log('  PASS  list_failing — returns compact failing list');

  // ===== getFeature =====
  const f1 = await getFeature('demo-task', 'AC1', tmpDir);
  assert.equal(f1.passes, true);
  assert.equal(f1.evidence_ref, 'tests/foo.test.ts:42');
  const f3 = await getFeature('demo-task', 'AC3', tmpDir);
  assert.deepEqual(f3.evidence_required, ['test passes']);
  console.log('  PASS  get_feature — single drill-down');

  try {
    await getFeature('demo-task', 'AC99', tmpDir);
    assert.fail('expected throw on missing feature');
  } catch (e) { assert.match(e.message, /AC99/); }
  console.log('  PASS  get_feature — missing feature_id rejected');

  // ===== end-to-end: mark all → listFailing empty =====
  await markPass('demo-task', 'AC2', 'proof-2', tmpDir);
  await markPass('demo-task', 'AC3', 'proof-3', tmpDir);
  const noFailing = await listFailing('demo-task', tmpDir);
  assert.deepEqual(noFailing, []);
  console.log('  PASS  end-to-end — all marked, list_failing returns []');

  console.log('\\nAll 11 smoke checks PASSED.');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
"
