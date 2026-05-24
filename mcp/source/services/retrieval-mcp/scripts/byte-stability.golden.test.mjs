#!/usr/bin/env node
// Golden invariant: retrieveContext is byte-deterministic across runs.
//
// The bug — `findRelatedFiles` in src/retrieval.ts had two ordering leaks:
//
//   1. `rg --files-with-matches` returns hits in non-deterministic order
//      (directory traversal + internal parallelism can race), and the
//      first 8 hits were sliced WITHOUT sorting — so the SET of related
//      files (not just their order) varied between runs.
//
//   2. The `related` Map was iterated in insertion order, which inherited
//      rg's non-determinism, and the first 20 entries were sliced without
//      sorting by path.
//
// Both leak into the compact_context "Related files" section → identical
// query, identical workspace → different md5 across runs → defeats
// provider prefix-cache reuse. A compressor that varies its byte output
// on the same input pays full prefill every turn, even when its
// single-shot byte saving is excellent.
//
// Fix — two surgical sorts in src/retrieval.ts:
//   * sort rg hits before `.slice(0, 8)`  (~ line 1238)
//   * sort Map entries by path before `.slice(0, 20)`  (~ line 1263)
//
// These tests pin the invariant so a future refactor cannot reintroduce
// the bug class.
//
// Run: node --test scripts/byte-stability.golden.test.mjs   (needs dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { retrieveContext } from "../dist/retrieval.js";
import { getRetrievalConfig } from "../dist/config.js";

// scripts/<file>.mjs → REPO_ROOT lives 3 levels up at mcp/source/
// (where services/retrieval-mcp/ and services/context-prep-mcp/ are direct
// children).
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const md5 = (s) => createHash("md5").update(s).digest("hex");

async function runQuery(query, includeGlobs, intent = "implementation") {
  const config = getRetrievalConfig();
  const result = await retrieveContext(query, config, {
    root_path: REPO_ROOT,
    include_globs: includeGlobs,
    task_intent: intent,
  });
  return result.compact_context || "";
}

test("INVARIANT: compact_context is byte-identical across N=5 runs (retrieval-mcp scope)", async () => {
  const md5s = new Set();
  for (let i = 0; i < 5; i++) {
    const c = await runQuery(
      "where is retrieveContext implemented",
      ["services/retrieval-mcp/**"],
    );
    md5s.add(md5(c));
  }
  assert.equal(
    md5s.size,
    1,
    `expected unique_md5_count=1, got ${md5s.size}. ` +
      `retrieveContext must be byte-deterministic across runs of the same ` +
      `query on the same workspace state — otherwise downstream prefix-cache ` +
      `is defeated.`,
  );
});

test("INVARIANT: compact_context is byte-identical across N=3 runs (context-prep-mcp scope)", async () => {
  const md5s = new Set();
  for (let i = 0; i < 3; i++) {
    const c = await runQuery(
      "where is context-prep request logging implemented",
      ["services/context-prep-mcp/**"],
    );
    md5s.add(md5(c));
  }
  assert.equal(
    md5s.size,
    1,
    `expected unique_md5_count=1, got ${md5s.size}`,
  );
});
