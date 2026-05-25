/**
 * Cross-runtime equivalence test — JavaScript side.
 *
 * Loads the same fixtures as `../python/tests/test_canonical_bytes.py`
 * and asserts the same canonical-bytes + SHA-256. If JS and Python
 * disagree on a single byte, the design breaks.
 *
 * Run:
 *     cd act-receipts/js
 *     node --test canonical_bytes.test.mjs
 *
 * Requires Node 20+ (built-in test runner). License: MIT.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { canonicalBytes, canonicalSha256, cacheFriendlyScore } from "./canonical_bytes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, "tests", "fixtures_cross_runtime.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8"));

test("each fixture's canonical SHA-256 matches the Python-generated golden", () => {
  for (const fx of fixtures) {
    const sha = canonicalSha256(fx.receipt);
    assert.equal(
      sha,
      fx.expected_canonical_sha256,
      `SHA-256 mismatch for fixture ${fx.name}`,
    );
  }
});

test("each fixture's canonical UTF-8 bytes match the Python-generated golden", () => {
  for (const fx of fixtures) {
    const bytes = canonicalBytes(fx.receipt).toString("utf-8");
    assert.equal(
      bytes,
      fx.expected_canonical_bytes_utf8,
      `canonical bytes mismatch for fixture ${fx.name}`,
    );
  }
});

test("observability + dom_region_size_bytes are stripped (fixtures #1 and #2 hash same)", () => {
  const a = fixtures.find((f) => f.name === "minimal_click");
  const b = fixtures.find((f) => f.name === "click_with_observability_stripped");
  assert.ok(a && b, "both fixtures must exist");
  assert.equal(
    canonicalSha256(a.receipt),
    canonicalSha256(b.receipt),
    "Receipts differing only in observability + dom_region_size_bytes must hash same",
  );
});

test("cacheFriendlyScore returns 1.0 for identical receipts", () => {
  const r = fixtures[0].receipt;
  assert.equal(cacheFriendlyScore([r, r, r, r, r]), 1.0);
});

test("cacheFriendlyScore returns 0.8 for 4/5 identical, 1 different", () => {
  const a = fixtures[0].receipt;
  const c = fixtures[2].receipt;
  assert.equal(cacheFriendlyScore([a, a, a, a, c]), 0.8);
});

test("cacheFriendlyScore returns null for empty input", () => {
  assert.equal(cacheFriendlyScore([]), null);
});

test("cacheFriendlyScore returns 1.0 for single receipt", () => {
  const r = fixtures[0].receipt;
  assert.equal(cacheFriendlyScore([r]), 1.0);
});
