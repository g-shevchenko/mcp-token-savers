/**
 * mcp-token-router routing decision tests — TDD verify-red first.
 *
 * The router's core value is the deterministic mapping from
 * (input_chars, budget_chars, task_type) → compressor choice + reason.
 * Routing rules are data-backed by the 2026-05-24 measurement program
 * (see notes/c2_bench_hwai_v0_1_wins_2026-05-24.md).
 *
 * Production routing rules under test:
 *   input < 1000 chars            → "none" (inflation in any compressor)
 *   budget ≤ 1000c output         → "hwai_v0_1_600c"  (67% quality, 94% saving)
 *   budget 1000-2500c output      → "hwai_v0_1_2000c" (87% quality, 92% saving)
 *   budget ≥ 2500c output         → "contextprep_7000c" (93% quality, 60% saving)
 *
 * Task-type overrides (advanced):
 *   task_type=summarize           → prefer contextprep at any budget
 *   task_type=extract             → require hwai (fact-extraction critical)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { routeForBudget, ROUTING_RULES } from '../dist/router.js';

// ---------------------------------------------------------------------------
// Inflation guard — short inputs skip compression
// ---------------------------------------------------------------------------

test('short input under 1000 chars routes to none', () => {
  const r = routeForBudget({ inputChars: 500, budgetChars: 600 });
  assert.equal(r.compressor, 'none');
  assert.match(r.reason, /inflation|short input/i);
});

test('exactly 1000 chars input still routes to none (boundary)', () => {
  const r = routeForBudget({ inputChars: 999, budgetChars: 600 });
  assert.equal(r.compressor, 'none');
});

test('1000+ char input does NOT route to none', () => {
  const r = routeForBudget({ inputChars: 1500, budgetChars: 600 });
  assert.notEqual(r.compressor, 'none');
});

// ---------------------------------------------------------------------------
// Budget tier — hwai_v0_1_600c for tight
// ---------------------------------------------------------------------------

test('budget 600c → hwai_v0_1_600c (tight tier)', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 600 });
  assert.equal(r.compressor, 'hwai_v0_1_600c');
  assert.match(r.reason, /tight|94%|aggressive/i);
});

test('budget 1000c → hwai_v0_1_600c (still tight tier upper boundary)', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 1000 });
  assert.equal(r.compressor, 'hwai_v0_1_600c');
});

// ---------------------------------------------------------------------------
// Budget tier — hwai_v0_1_2000c for medium
// ---------------------------------------------------------------------------

test('budget 1500c → hwai_v0_1_2000c (medium tier)', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 1500 });
  assert.equal(r.compressor, 'hwai_v0_1_2000c');
  assert.match(r.reason, /medium|pareto|87%|92%/i);
});

test('budget 2500c → hwai_v0_1_2000c (medium tier upper boundary)', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 2500 });
  assert.equal(r.compressor, 'hwai_v0_1_2000c');
});

// ---------------------------------------------------------------------------
// Budget tier — contextprep for generous
// ---------------------------------------------------------------------------

test('budget 3000c → contextprep_7000c (generous tier)', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 3000 });
  assert.equal(r.compressor, 'contextprep_7000c');
  assert.match(r.reason, /generous|93%|extractive/i);
});

test('budget 7000c → contextprep_7000c', () => {
  const r = routeForBudget({ inputChars: 20000, budgetChars: 7000 });
  assert.equal(r.compressor, 'contextprep_7000c');
});

// ---------------------------------------------------------------------------
// Task type overrides
// ---------------------------------------------------------------------------

test('task_type=extract forces hwai even at generous budget', () => {
  const r = routeForBudget({
    inputChars: 10000,
    budgetChars: 5000,
    taskType: 'extract',
  });
  // hwai's fact extraction is critical for find-specific-fact queries
  assert.ok(
    r.compressor.startsWith('hwai_'),
    `expected hwai_*, got ${r.compressor}`,
  );
});

test('task_type=summarize prefers contextprep even at tight budget', () => {
  const r = routeForBudget({
    inputChars: 10000,
    budgetChars: 1500,
    taskType: 'summarize',
  });
  assert.ok(
    r.compressor.startsWith('contextprep'),
    `expected contextprep_*, got ${r.compressor}`,
  );
});

// ---------------------------------------------------------------------------
// Default budget — if caller didn't specify, use measured Pareto sweet-spot
// ---------------------------------------------------------------------------

test('no budget specified → defaults to hwai_v0_1_2000c (Pareto sweet-spot)', () => {
  const r = routeForBudget({ inputChars: 5000 });
  assert.equal(r.compressor, 'hwai_v0_1_2000c');
  assert.match(r.reason, /default|pareto|sweet/i);
});

// ---------------------------------------------------------------------------
// Contract — return shape
// ---------------------------------------------------------------------------

test('return shape contains compressor + reason + budget_used', () => {
  const r = routeForBudget({ inputChars: 5000, budgetChars: 1500 });
  assert.ok(typeof r.compressor === 'string');
  assert.ok(typeof r.reason === 'string');
  assert.ok(typeof r.budgetUsed === 'number');
  assert.ok(r.reason.length > 0);
});

// ---------------------------------------------------------------------------
// ROUTING_RULES is exposed (auditable) and matches the measured frontier
// ---------------------------------------------------------------------------

test('ROUTING_RULES tier table is exposed for auditing', () => {
  assert.ok(Array.isArray(ROUTING_RULES));
  assert.ok(ROUTING_RULES.length >= 3);  // at least 3 tiers: tight/medium/generous
  for (const rule of ROUTING_RULES) {
    assert.ok(typeof rule.compressor === 'string');
    assert.ok(typeof rule.budgetMin === 'number');
    assert.ok(typeof rule.budgetMax === 'number');
    assert.ok(typeof rule.measuredQuality === 'number');
    assert.ok(typeof rule.measuredSaving === 'number');
    // Measurements should be in [0, 1]
    assert.ok(rule.measuredQuality >= 0 && rule.measuredQuality <= 1);
    assert.ok(rule.measuredSaving >= 0 && rule.measuredSaving <= 1);
  }
});
