// TDD verify-red: detectors do not exist yet. This test MUST fail first
// (assertion failure), then we implement src/detectors.ts to make it pass.
// Anti-pattern classes CD01-CD06 from notes/code_diet_mcp_spec.md.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSource } from "../dist/detectors.js";

test("CD04 re-export plumbing: pure barrel file is flagged", async () => {
  const src = `export { foo } from "./foo.js";\nexport { bar } from "./bar.js";\n`;
  const findings = await analyzeSource(src, "index.ts");
  const cd04 = findings.filter((f) => f.id === "CD04");
  assert.ok(cd04.length >= 1, "expected a CD04 barrel-file finding");
});

// CD04 extension (spec §4 CD04 row: "chain of ≥2 pure re-exports"). A barrel that
// re-exports from ANOTHER barrel (which itself only re-exports) is a plumbing chain —
// two hops of indirection with no added value. Cross-file: needs the corpus.
test("CD04 re-export chain: barrel re-exporting from another pure barrel is flagged", async () => {
  const leaf = `export function foo() { return 1; }\n`;
  const midBarrel = `export { foo } from "./leaf.js";\n`; // pure barrel (1 hop)
  const topBarrel = `export { foo } from "./mid.js";\n`; // re-exports the barrel -> chain of 2
  const findings = await analyzeSource(topBarrel, "index.ts", {
    allSources: [topBarrel, midBarrel, leaf],
    corpusFiles: [
      { file: "index.ts", text: topBarrel },
      { file: "mid.ts", text: midBarrel },
      { file: "leaf.ts", text: leaf },
    ],
  });
  const cd04 = findings.filter((f) => f.id === "CD04" && /chain/i.test(f.message));
  assert.ok(cd04.length >= 1, `expected a CD04 re-export-chain finding, got ${JSON.stringify(findings)}`);
});

test("CD04 re-export chain: barrel re-exporting from a REAL module (not a barrel) is NOT a chain", async () => {
  const realModule = `export function foo() { return 1; }\nexport function bar() { return 2; }\n`;
  const topBarrel = `export { foo } from "./real.js";\n`; // 1 hop only, leaf has real logic
  const findings = await analyzeSource(topBarrel, "index.ts", {
    allSources: [topBarrel, realModule],
    corpusFiles: [
      { file: "index.ts", text: topBarrel },
      { file: "real.ts", text: realModule },
    ],
  });
  const cd04chain = findings.filter((f) => f.id === "CD04" && /chain/i.test(f.message));
  assert.equal(cd04chain.length, 0, `single-hop barrel into a real module is not a chain, got ${JSON.stringify(findings)}`);
});

test("CD02 guard-clause spam: function with many defensive guards is flagged", async () => {
  const guards = Array.from({ length: 7 }, (_, i) => `  if (!a${i}) return null;`).join("\n");
  const src = `export function f(a0,a1,a2,a3,a4,a5,a6) {\n${guards}\n  return a0;\n}\n`;
  const findings = await analyzeSource(src, "f.ts");
  assert.ok(findings.some((f) => f.id === "CD02"), "expected a CD02 guard-spam finding");
});

test("CD03 unrequested export: exported symbol with zero references is flagged", async () => {
  const src = `export function neverUsed() { return 1; }\n`;
  const findings = await analyzeSource(src, "u.ts", { allSources: [src] });
  assert.ok(findings.some((f) => f.id === "CD03"), "expected a CD03 unused-export finding");
});

test("clean referenced code yields no findings (false-positive floor)", async () => {
  const lib = `export function add(a: number, b: number): number { return a + b; }\n`;
  const caller = `import { add } from "./lib.js";\nexport const total = add(1, 2);\n`;
  const findings = await analyzeSource(lib, "lib.ts", { allSources: [lib, caller] });
  assert.equal(findings.length, 0, `expected 0 findings, got ${JSON.stringify(findings)}`);
});

test("CD03 does NOT flag TS types/interfaces (compile-time, no runtime refs)", async () => {
  // Types are compile-time only; a text-grep for runtime refs always misses them.
  // Flagging them is the Category-D false positive found in dogfooding.
  const src = [
    `export interface OptimizeOptions { width?: number; }`,
    `export type OptimizationResult = { ok: boolean };`,
    `export interface TraceMetadata { id: string };`,
  ].join("\n");
  const findings = await analyzeSource(src, "types.ts", { allSources: [src] });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.equal(cd03.length, 0, `expected 0 CD03 on type-only exports, got ${JSON.stringify(cd03)}`);
});

test("CD01 abstraction bloat: interface with exactly 1 impl and no polymorphic use is flagged", async () => {
  const src = [
    `export interface Shape { area(): number }`,
    `class Square implements Shape { area() { return 1; } }`,
    `const s = new Square(); s.area();`,
  ].join("\n");
  const findings = await analyzeSource(src, "s.ts", { allSources: [src] });
  assert.ok(findings.some((f) => f.id === "CD01"), "expected a CD01 single-impl-interface finding");
});

test("CD01 clean: interface with 2+ implementations is NOT flagged", async () => {
  const src = [
    `interface Shape { area(): number }`,
    `class Square implements Shape { area() { return 1; } }`,
    `class Circle implements Shape { area() { return 2; } }`,
    `function render(x: Shape) { return x.area(); }`,
  ].join("\n");
  const findings = await analyzeSource(src, "s.ts", { allSources: [src] });
  assert.ok(!findings.some((f) => f.id === "CD01"), "expected no CD01 for polymorphic interface");
});

test("CD05 reinvention: helper duplicating stdlib padStart is flagged", async () => {
  const src = [
    `export function leftPad(s: string, n: number, ch: string): string {`,
    `  let out = s; while (out.length < n) out = ch + out; return out;`,
    `}`,
    `const x = leftPad("5", 3, "0");`,
  ].join("\n");
  const findings = await analyzeSource(src, "p.ts", { allSources: [src] });
  assert.ok(findings.some((f) => f.id === "CD05"), "expected a CD05 left-pad reinvention finding");
});

test("CD06 dead code: never-true condition is flagged", async () => {
  const src = [
    `function f(x: number): number {`,
    `  if (x !== x) return -1;`,
    `  return x;`,
    `}`,
    `f(1);`,
  ].join("\n");
  const findings = await analyzeSource(src, "d.ts", { allSources: [src] });
  assert.ok(findings.some((f) => f.id === "CD06"), "expected a CD06 never-true-condition finding");
});

test("CD06 dead code: if (false) constant branch is flagged", async () => {
  const src = `function g() {\n  if (false) { doThing(); }\n  return 1;\n}\ng();`;
  const findings = await analyzeSource(src, "d.ts", { allSources: [src] });
  assert.ok(findings.some((f) => f.id === "CD06"), "expected a CD06 if(false) finding");
});

// eval v2 §5b: library-code FP class. An export re-exported by a public entry-point
// barrel is PUBLIC API, not dead. CD03 must NOT flag it.
test("CD03 does NOT flag names re-exported by a public entry-point barrel", async () => {
  const lib = `export function assertIs(x) {}\nexport function helper() { return 1; }\n`;
  const barrel = `export { assertIs } from "./lib.js";\n`; // entry point
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib, barrel],
    publicApiSources: [barrel],
  });
  const cd03 = findings.filter((f) => f.id === "CD03" && f.message.includes("assertIs"));
  assert.equal(cd03.length, 0, `public-API name must not be CD03, got ${JSON.stringify(cd03)}`);
  // helper is NOT re-exported and unreferenced -> still flagged
  const helperHit = findings.filter((f) => f.id === "CD03" && f.message.includes("helper"));
  assert.ok(helperHit.length >= 1, "non-public unused export must still be flagged");
});

test("CD03 default-as-alias re-export (export { default as ar }) is public API", async () => {
  const locale = `export default function ar() { return {}; }\n`;
  const barrel = `export { default as ar } from "./ar.js";\n`;
  const findings = await analyzeSource(locale, "ar.ts", {
    allSources: [locale, barrel],
    publicApiSources: [barrel],
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.equal(cd03.length, 0, `default-as-alias public API must not be CD03, got ${JSON.stringify(cd03)}`);
});

// eval v2 §5c: language-graph oracle. Text-based CD03 cannot resolve module
// reachability (star-barrels, namespace imports, name collisions). The oracle
// confirms or rejects each text-based candidate with the graph's cross-file
// reference count. When the oracle reports a cross-file reference, CD03 must
// NOT flag the symbol — the text-only FP class is eliminated.
test("CD03 oracle: a text-candidate with a graph-confirmed cross-file ref is NOT flagged", async () => {
  // `util` looks unused by text count (only its own declaration), but the oracle
  // knows another file references `ns.util` via a namespace import.
  const lib = `export function util() { return 1; }\n`;
  const oracle = {
    async hasCrossFileReference(symbolName, _selfFile) {
      return symbolName === "util"; // graph: `import * as mod; mod.util()` elsewhere
    },
  };
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib],
    languageGraphOracle: oracle,
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.equal(cd03.length, 0, `oracle-confirmed ref must not be CD03, got ${JSON.stringify(cd03)}`);
});

test("CD03 oracle: a text-candidate with NO graph refs IS flagged (high confidence)", async () => {
  const lib = `export function dead() { return 1; }\n`;
  const oracle = {
    indexedTexts: [lib],
    async hasCrossFileReference(_symbolName, _selfFile) {
      return false; // graph confirms zero cross-file refs
    },
  };
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib],
    languageGraphOracle: oracle,
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.ok(cd03.length >= 1, "oracle-confirmed dead export must be flagged");
  assert.ok(cd03[0].confidence >= 0.8, `oracle-confirmed finding should have high confidence, got ${cd03[0].confidence}`);
  assert.ok(
    cd03[0].message.includes("language-graph"),
    `oracle-confirmed finding should cite language-graph, got "${cd03[0].message}"`,
  );
});

// eval v2 §5e: the graph oracle can index a partial slice. A name referenced in a
// file the graph never saw must NOT be upgraded to a verdict, even when the graph
// reports zero cross-file refs — the graph is blind in the same direction as the
// text pass. The finding stays a candidate (low confidence).
// eval v2 §5e: the graph oracle can index a partial slice. When the oracle exposes
// its indexed corpus, a graph "dead" answer is only upgraded to a verdict if that
// corpus textually agrees (name appears only at its declaration). If the oracle
// exposes no indexed corpus (older adapters), the graph verdict is trusted as-is.
test("CD03 oracle: graph 'dead' + indexed corpus AGREES (name only declared) => verdict (0.85)", async () => {
  const lib = `export function dead2() { return 1; }\n`;
  const oracle = {
    indexedTexts: [lib], // indexed corpus agrees: only the declaration
    async hasCrossFileReference(_symbolName, _selfFile) {
      return false;
    },
  };
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib],
    languageGraphOracle: oracle,
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.ok(cd03[0].confidence >= 0.85, `fully-confirmed dead export must be a verdict, got ${cd03[0].confidence}`);
});

test("CD03 oracle: graph 'dead' + indexed corpus DISAGREES (name referenced) => candidate (0.5)", async () => {
  const lib = `export function helper() { return 1; }\n`;
  const consumer = `export const x = helper();\n`;
  const oracle = {
    // Graph claims no cross-file refs, but its own indexed corpus shows the name
    // referenced in consumer.ts — a contradiction (stale/partial index). The text
    // signal must veto the verdict upgrade.
    indexedTexts: [lib, consumer],
    async hasCrossFileReference(_symbolName, _selfFile) {
      return false;
    },
  };
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib], // main corpus is partial — count stays 1, text-candidate reached
    languageGraphOracle: oracle,
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.ok(cd03.length >= 1, "finding should still be reported as a candidate");
  assert.ok(
    cd03[0].confidence < 0.85,
    `contradicted graph 'dead' must NOT become a verdict, got confidence ${cd03[0].confidence}`,
  );
});

// Task 7 (pre-registered, dogfood regression gate): a text-based regex over raw source
// cannot tell "code" from "text inside a backtick string". Reproduced against real prod
// files (mcp/source/services/repo-quality-gate-mcp/scripts/benchmark-local.mjs) — a
// fixture-generator script builds .ts source via template literals
// (`` `export const generated${index} = ${index};` ``); code-diet scanned the .mjs
// script itself and flagged "generated$" etc. as unrequested exports of the SCRIPT,
// which never declares them — the text only exists inside a string it writes elsewhere.
test("CD03 does NOT flag an export declared only inside a template literal (dogfood FP: fixture-generator scripts)", async () => {
  const src = [
    'import fs from "node:fs";',
    "await fs.writeFile(",
    '  "out.ts",',
    "  `export const generated = 1;`,",
    '  "utf8",',
    ");",
  ].join("\n");
  const findings = await analyzeSource(src, "gen.mjs", { allSources: [src] });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.equal(
    cd03.length,
    0,
    `export text inside a template literal is not a real declaration, got ${JSON.stringify(cd03)}`,
  );
});

// The mirror case: an export name that appears elsewhere ONLY as text inside a template
// literal (e.g. a doc string mentioning the symbol) must not count as a real reference —
// otherwise the template-literal fix above would trade a false positive for a false
// negative (a genuinely dead export hidden by an incidental string mention).
test("CD03: a name mentioned only inside a template literal does not count as a reference", async () => {
  const src = [
    "export function realDeadExport() { return 1; }",
    "const note = `see realDeadExport in the docs`;",
  ].join("\n");
  const findings = await analyzeSource(src, "d.ts", { allSources: [src] });
  const cd03 = findings.filter((f) => f.id === "CD03" && f.message.includes("realDeadExport"));
  assert.ok(
    cd03.length >= 1,
    `a mention inside a template literal must not suppress a true CD03, got ${JSON.stringify(findings)}`,
  );
});

// Regression on the template-literal fix itself: a call inside a `${...}` interpolation
// is REAL executed code, not string text — reproduced against corpus_v2/clean/zod/errors.ts
// (`` `  → at ${toDotPath(issue.path)}` ``), which surfaced as a NEW v2a clean FP
// (0.100 -> 0.110) after the naive blank-the-whole-backtick-string fix landed, because it
// blanked the `${toDotPath(...)}` call along with the surrounding string text.
test("CD03: a call inside a template literal's ${...} interpolation DOES count as a reference", async () => {
  const src = [
    "export function toDotPath(path) { return path.join('.'); }",
    "function prettifyError(issue) {",
    "  return `  -> at ${toDotPath(issue.path)}`;",
    "}",
    "export { prettifyError };",
  ].join("\n");
  const findings = await analyzeSource(src, "d.ts", { allSources: [src] });
  const cd03 = findings.filter((f) => f.id === "CD03" && f.message.includes("toDotPath"));
  assert.equal(
    cd03.length,
    0,
    `a call inside a template-literal interpolation is a real reference, got ${JSON.stringify(cd03)}`,
  );
});

test("CD03 oracle: oracle failure degrades to text-candidate mode (conservative)", async () => {
  const lib = `export function maybe() { return 1; }\n`;
  const oracle = {
    async hasCrossFileReference(_symbolName, _selfFile) {
      throw new Error("graph unavailable");
    },
  };
  // Must not throw; degrades to text-candidate with low confidence.
  const findings = await analyzeSource(lib, "lib.ts", {
    allSources: [lib],
    languageGraphOracle: oracle,
  });
  const cd03 = findings.filter((f) => f.id === "CD03");
  assert.ok(cd03.length >= 1, "oracle failure must still yield a candidate");
  assert.ok(cd03[0].confidence <= 0.5, `degraded candidate should keep low confidence, got ${cd03[0].confidence}`);
});

// CD07 duplicate export (eval v2b, #19; knip-consistent). The SAME symbol re-exported
// from MORE THAN ONE barrel/entry path forces tools and humans to guess which path is
// canonical. Cross-file: needs corpusFiles to see the other barrels. The detector flags
// the NON-canonical (second and later) re-export paths; the first path seen is canonical.
test("CD07 duplicate export: same symbol re-exported from two barrels is flagged on the non-canonical path", async () => {
  const leaf = `export function foo() { return 1; }\n`;
  const barrelA = `export { foo } from "./leaf.js";\n`; // canonical (first path)
  const barrelB = `export { foo } from "./leaf.js";\n`; // duplicate path -> flagged
  const findings = await analyzeSource(barrelB, "b.ts", {
    allSources: [leaf, barrelA, barrelB],
    corpusFiles: [
      { file: "leaf.ts", text: leaf },
      { file: "a.ts", text: barrelA },
      { file: "b.ts", text: barrelB },
    ],
  });
  const cd07 = findings.filter((f) => f.id === "CD07");
  assert.ok(cd07.length >= 1, `expected a CD07 duplicate-export finding, got ${JSON.stringify(findings)}`);
  assert.ok(/foo/.test(cd07[0].message), `CD07 message must name the duplicated symbol, got "${cd07[0].message}"`);
});

test("CD07 duplicate export: a symbol re-exported from only ONE path is NOT flagged", async () => {
  const leaf = `export function foo() { return 1; }\nexport function bar() { return 2; }\n`;
  const barrelA = `export { foo } from "./leaf.js";\nexport { bar } from "./leaf.js";\n`; // each once
  const findings = await analyzeSource(barrelA, "a.ts", {
    allSources: [leaf, barrelA],
    corpusFiles: [
      { file: "leaf.ts", text: leaf },
      { file: "a.ts", text: barrelA },
    ],
  });
  const cd07 = findings.filter((f) => f.id === "CD07");
  assert.equal(cd07.length, 0, `single-path re-export must not be CD07, got ${JSON.stringify(cd07)}`);
});

// CD08 stale file (detect_drift, #17). A file whose last git commit is older than the
// staleness threshold AND that is not a live/catalogued service is "stale" — likely
// abandoned code that drifts. Per spec §8 (no network/FS inside detectors), the git
// signal is INJECTED as fileGitAges (path -> days since last commit), computed by the
// caller from git log; the detector itself stays a pure function.
test("CD08 stale file: a file with git age above the threshold is flagged (warn)", async () => {
  const src = `export function old() { return 1; }\nexport const used = old();\n`;
  const findings = await analyzeSource(src, "legacy.ts", {
    allSources: [src],
    fileGitAges: { "legacy.ts": 200 }, // last commit 200 days ago
  });
  const cd08 = findings.filter((f) => f.id === "CD08");
  assert.ok(cd08.length >= 1, `expected a CD08 stale-file finding, got ${JSON.stringify(findings)}`);
  assert.ok(cd08[0].confidence < 0.7, `CD08 is a warn, not a deletion verdict, got ${cd08[0].confidence}`);
});

test("CD08 stale file: a recently-committed file is NOT flagged", async () => {
  const src = `export function fresh() { return 1; }\nexport const used = fresh();\n`;
  const findings = await analyzeSource(src, "active.ts", {
    allSources: [src],
    fileGitAges: { "active.ts": 5 }, // committed 5 days ago
  });
  const cd08 = findings.filter((f) => f.id === "CD08");
  assert.equal(cd08.length, 0, `a fresh file must not be CD08, got ${JSON.stringify(cd08)}`);
});

test("CD08 stale file: no git-age signal -> detector is inert (spec §8 no FS)", async () => {
  const src = `export function f() { return 1; }\nexport const u = f();\n`;
  const findings = await analyzeSource(src, "x.ts", { allSources: [src] });
  const cd08 = findings.filter((f) => f.id === "CD08");
  assert.equal(cd08.length, 0, `without injected git ages CD08 must be inert, got ${JSON.stringify(cd08)}`);
});

// CodeQL js/incomplete-sanitization (#36): the reference regex is built from an
// export name. `$` is a legal identifier character, so names with `$` anywhere —
// including the first position, where `\b` has no word character to anchor on —
// must still be counted as referenced.
test("CD03 counts references to export names containing $", async () => {
  const lib = `export function foo$bar() {}\nexport const $store = 1;\nexport function $dead() {}\n`;
  const user = `import { foo$bar, $store } from "./lib.js";\nfoo$bar($store);\n`;
  const findings = await analyzeSource(lib, "lib.ts", { allSources: [lib, user] });
  const flagged = (n) => findings.some((f) => f.id === "CD03" && f.message.includes(n));
  assert.equal(flagged("foo$bar"), false, "referenced foo$bar must not be flagged");
  assert.equal(flagged("$store"), false, "referenced $store must not be flagged");
  assert.equal(flagged("$dead"), true, "unreferenced $dead must still be flagged");
});
