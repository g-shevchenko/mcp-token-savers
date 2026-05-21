#!/usr/bin/env bash
# Smoke test for tdd-gate-mcp v0.1.0 — validates all 4 tools.
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
  checkEditAllowed,
  checkTestImmutability,
  verifyRedStatus,
  registerTestToImplLink,
} from './dist/index.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdd-gate-mcp-smoke-'));
try {
  // ===== checkEditAllowed =====
  const r1 = await checkEditAllowed(path.join(tmpDir, 'notes/foo.md'), { rootDir: tmpDir });
  assert.equal(r1.allowed, true);
  assert.match(r1.reason, /extension/i);
  console.log('  PASS  check_edit_allowed — .md bypass');

  await fs.mkdir(path.join(tmpDir, 'services/legacy/src'), { recursive: true });
  const r2 = await checkEditAllowed(path.join(tmpDir, 'services/legacy/src/foo.py'), { rootDir: tmpDir });
  assert.equal(r2.allowed, true);
  assert.match(r2.reason, /legacy|no tests/i);
  console.log('  PASS  check_edit_allowed — legacy bypass (no tests/ dir)');

  await fs.mkdir(path.join(tmpDir, 'services/foo/src'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'services/foo/tests'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'services/foo/tests/test_bar.py'), '# test');
  const r3 = await checkEditAllowed(path.join(tmpDir, 'services/foo/src/bar.py'), { rootDir: tmpDir });
  assert.equal(r3.allowed, true);
  assert.match(r3.reason, /test found/i);
  console.log('  PASS  check_edit_allowed — matching test allows');

  const r4 = await checkEditAllowed(path.join(tmpDir, 'services/foo/src/nonexistent.py'), { rootDir: tmpDir });
  assert.equal(r4.allowed, false);
  assert.ok(r4.suggestion);
  console.log('  PASS  check_edit_allowed — no matching test blocks');

  // ===== checkTestImmutability =====
  const im1 = await checkTestImmutability('tests/foo.test.ts',
    'test(\"a\", () => { expect(x).toBe(1); });',
    'test(\"a\", () => { expect(x).toBe(1); });\ntest(\"b\", () => { expect(y).toBe(2); });');
  assert.equal(im1.allowed, true);
  console.log('  PASS  check_test_immutability — pure additions allowed');

  const im2 = await checkTestImmutability('tests/foo.test.ts',
    'expect(x).toBe(1);\nexpect(y).toBe(2);',
    'expect(x).toBe(1);');
  assert.equal(im2.allowed, false);
  assert.ok(im2.violations.some(v => v.type === 'removed_assertion'));
  console.log('  PASS  check_test_immutability — removed expect detected');

  const im3 = await checkTestImmutability('tests/foo.test.ts',
    'test(\"a\", () => { expect(x).toBe(1); });',
    'test.skip(\"a\", () => { expect(x).toBe(1); });');
  assert.ok(im3.violations.some(v => v.type === 'skip_marker_added'));
  console.log('  PASS  check_test_immutability — .skip() marker detected');

  // ===== verifyRedStatus =====
  const vr1 = await verifyRedStatus('node -e \"process.exit(0)\"', { timeoutMs: 5000 });
  assert.equal(vr1.error_type, 'passed');
  assert.equal(vr1.is_red, false);
  console.log('  PASS  verify_red_status — exit 0 → passed (BAD for TDD)');

  // Write failing snippets to temp files and run via 'node <file>'. A shell-safe
  // path (JSON.stringify) avoids nesting 'node -e \"...\"' inside this outer
  // 'node --input-type=module -e', which collapsed the inner quotes into a
  // malformed command and made Node emit a real SyntaxError (false syntax_error).
  const failAssert = path.join(tmpDir, 'fail_assert.cjs');
  await fs.writeFile(failAssert, 'console.error(\"AssertionError: x\"); process.exit(1);');
  const vr2 = await verifyRedStatus('node ' + JSON.stringify(failAssert), { timeoutMs: 5000 });
  assert.equal(vr2.error_type, 'assertion');
  assert.equal(vr2.is_red, true);
  console.log('  PASS  verify_red_status — AssertionError → is_red:true');

  const failImport = path.join(tmpDir, 'fail_import.cjs');
  await fs.writeFile(failImport, 'console.error(\"ImportError: foo\"); process.exit(1);');
  const vr3 = await verifyRedStatus('node ' + JSON.stringify(failImport), { timeoutMs: 5000 });
  assert.equal(vr3.error_type, 'import_error');
  assert.equal(vr3.is_red, false);
  console.log('  PASS  verify_red_status — ImportError → broken setup');

  const vr4 = await verifyRedStatus('node -e \"setTimeout(() => {}, 10000)\"', { timeoutMs: 200 });
  assert.equal(vr4.error_type, 'other');
  assert.match(vr4.message.toLowerCase(), /timeout|killed/);
  console.log('  PASS  verify_red_status — timeout handled');

  // ===== registerTestToImplLink =====
  const rl1 = await registerTestToImplLink('tests/foo.test.ts', 'src/foo.ts', { rootDir: tmpDir });
  assert.equal(rl1.registered, true);
  console.log('  PASS  register_test_to_impl_link — new pair registered');

  const rl2 = await registerTestToImplLink('tests/foo.test.ts', 'src/foo.ts', { rootDir: tmpDir });
  assert.equal(rl2.registered, false);
  assert.ok(rl2.existing);
  console.log('  PASS  register_test_to_impl_link — idempotent on duplicate');

  const linksFile = path.join(tmpDir, '.agent/tdd-links/links.json');
  const parsed = JSON.parse(await fs.readFile(linksFile, 'utf-8'));
  assert.equal(parsed.schema_version, 1);
  assert.ok(parsed.links.length >= 1);
  console.log('  PASS  register_test_to_impl_link — persisted to .agent/tdd-links/links.json');

  console.log('\\nAll 12 smoke checks PASSED.');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
"
