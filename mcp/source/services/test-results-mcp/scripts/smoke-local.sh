#!/usr/bin/env bash
# Smoke test for test-results-mcp v0.1.0 — validates initFeatureList tool
# Zero dependencies (no vitest required). Uses node + assert.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --silent --no-fund --no-audit
[ -d dist ] || npm run build --silent

node --input-type=module -e "
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initFeatureList } from './dist/index.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-results-mcp-smoke-'));
try {
  // Case 1: basic creation
  const list = await initFeatureList('demo-task', [
    { id: 'AC1', description: 'first criterion' },
    { id: 'AC2', description: 'second criterion' },
  ], tmpDir);
  assert.equal(list.task_id, 'demo-task');
  assert.equal(list.schema_version, 1);
  assert.equal(list.features.length, 2);
  assert.equal(list.features[0].passes, false);
  assert.equal(list.features[0].passed_at, null);
  assert.match(list.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  console.log('  PASS  init_feature_list creates ledger with defaults');

  // Case 2: file written
  const file = path.join(tmpDir, '.agent/tasks/demo-task/feature_list.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
  assert.equal(parsed.task_id, 'demo-task');
  console.log('  PASS  feature_list.json written to .agent/tasks/<id>/');

  // Case 3: evidence_required preserved
  const list2 = await initFeatureList('demo2', [
    { id: 'AC1', description: 'with evidence', evidence_required: ['test passes', 'screenshot ok'] },
  ], tmpDir);
  assert.deepEqual(list2.features[0].evidence_required, ['test passes', 'screenshot ok']);
  console.log('  PASS  evidence_required preserved when provided');

  // Case 4: immutability lock
  try {
    await initFeatureList('demo-task', [{ id: 'AC1', description: 'overwrite attempt' }], tmpDir);
    assert.fail('expected throw on already-exists');
  } catch (e) {
    assert.match(e.message, /already exists/);
  }
  console.log('  PASS  immutability lock throws on re-init');

  // Case 5: empty features rejected
  try {
    await initFeatureList('empty-task', [], tmpDir);
    assert.fail('expected throw on empty features');
  } catch (e) {
    assert.match(e.message, /at least one feature/);
  }
  console.log('  PASS  rejects empty features array');

  // Case 6: invalid task_id rejected
  try {
    await initFeatureList('not/valid', [{ id: 'AC1', description: 'x' }], tmpDir);
    assert.fail('expected throw on bad task_id');
  } catch (e) {
    assert.match(e.message, /task_id/);
  }
  console.log('  PASS  rejects invalid task_id (kebab-case enforced)');

  console.log('\\nAll 6 smoke checks PASSED.');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
"
