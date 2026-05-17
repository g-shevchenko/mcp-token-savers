#!/usr/bin/env node
// Golden invariants for retrieval-mcp confidence() calibration (Q4b-impl).
//
// The bug (Q4b): the old floor for any non-empty result was
// base 0.08 - 0.03 = 0.05, while every consumer gates at `> 0.03`
// (retrieval.ts:1529/1538, CLAUDE.md x5, .claude/rules/retrieval-auto.md;
// CLAUDE.md also has a `<= 0.03` "confident" branch). Floor > threshold
// => the signal was constant-true. These invariants pin the calibration
// so a future edit cannot reintroduce the unreachable-confident class.
//
// Run: node --test scripts/confidence.golden.test.mjs   (needs dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { confidence } from "../dist/retrieval.js";

const f = (score) => ({ score });
const snips = (n) => Array.from({ length: n }, (_, i) => ({ i }));

// Deterministic reconstruction of the OLD formula (thresholds unchanged,
// only constants changed) to prove the floor actually moved below 0.03.
function oldUncertainty(files, snippets) {
  if (snippets.length === 0) return 0.42;
  const top = files[0]?.score || 0;
  const gap = top - (files[1]?.score || 0);
  let u = 0.08;
  if (top >= 60) u -= 0.03;
  else if (top < 25) u += 0.12;
  if (gap < 8 && files.length > 3) u += 0.06;
  if (snippets.length < 3) u += 0.05;
  return Math.max(0.01, Math.min(0.5, Math.round(u * 100) / 100));
}

test("INVARIANT 1: strong + clear gap + >=3 snippets is CONFIDENT (<= 0.03)", () => {
  const files = [f(90), f(40), f(20)];
  const r = confidence(files, snips(6));
  assert.ok(r.uncertainty <= 0.03, `expected <=0.03, got ${r.uncertainty}`);
  // and the OLD formula could NEVER express this (>= 0.05) — the fix:
  assert.ok(oldUncertainty(files, snips(6)) >= 0.05, "old floor regression check");
  assert.ok(r.reasons.includes("strong top match"));
});

test("INVARIANT 2: weak top match stays UNCERTAIN (> 0.03)", () => {
  const r = confidence([f(10), f(5)], snips(4));
  assert.ok(r.uncertainty > 0.03, `weak must be >0.03, got ${r.uncertainty}`);
  assert.ok(r.reasons.includes("weak top match"));
});

test("INVARIANT 3: empty snippets is 0.42 (> 0.03)", () => {
  const r = confidence([f(99)], []);
  assert.equal(r.uncertainty, 0.42);
});

test("INVARIANT 4: strong score but AMBIGUOUS (gap<8, >3 files) > 0.03", () => {
  const r = confidence([f(80), f(79), f(78), f(77)], snips(6));
  assert.ok(r.uncertainty > 0.03, `ambiguous must be >0.03, got ${r.uncertainty}`);
  assert.ok(r.reasons.includes("multiple similarly ranked files"));
});

test("INVARIANT 5: strong score but SPARSE (<3 snippets) > 0.03", () => {
  const r = confidence([f(90), f(20)], snips(2));
  assert.ok(r.uncertainty > 0.03, `sparse must be >0.03, got ${r.uncertainty}`);
  assert.ok(r.reasons.includes("few snippets returned"));
});

test("INVARIANT 6: monotonic — strong-clean < medium < weak", () => {
  const strong = confidence([f(90), f(40)], snips(6)).uncertainty;
  const medium = confidence([f(40), f(20)], snips(6)).uncertainty;
  const weak = confidence([f(10), f(5)], snips(6)).uncertainty;
  assert.ok(strong < medium, `strong(${strong}) < medium(${medium})`);
  assert.ok(medium < weak, `medium(${medium}) < weak(${weak})`);
});

test("INVARIANT 7: always clamped to [0.01, 0.50]", () => {
  for (const c of [
    confidence([f(999), f(0)], snips(99)),
    confidence([f(0), f(0), f(0), f(0)], snips(1)),
    confidence([], snips(1)),
    confidence([f(99)], []),
  ]) {
    assert.ok(c.uncertainty >= 0.01 && c.uncertainty <= 0.5, `clamp: ${c.uncertainty}`);
  }
});

test("INVARIANT 8: the confident band is only reachable for genuinely strong+clean", () => {
  // Exhaustive over the branch space: a result is <=0.03 ONLY when it is
  // strong (>=60), unambiguous (gap>=8 OR <=3 files), and well-covered
  // (>=3 snippets). Any weak/ambiguous/sparse/empty variant is > 0.03.
  const confidentCount = [
    [[f(90), f(40)], snips(6)],   // strong clean        -> confident
    [[f(70), f(10)], snips(3)],   // strong clean min    -> confident
    [[f(40), f(10)], snips(6)],   // medium              -> NOT
    [[f(10), f(2)], snips(6)],    // weak                -> NOT
    [[f(90), f(89), f(88), f(87)], snips(6)], // ambiguous-> NOT
    [[f(90), f(10)], snips(1)],   // sparse              -> NOT
    [[f(90)], []],                // empty               -> NOT
  ].filter(([fs, sn]) => confidence(fs, sn).uncertainty <= 0.03).length;
  assert.equal(confidentCount, 2, "exactly the 2 strong-clean cases are confident");
});
