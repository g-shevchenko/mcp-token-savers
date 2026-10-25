// Deterministic AI-slop detectors (CD01-CD06, notes/code_diet_mcp_spec.md §4).
// Pure functions over source text: no network, no LLM, re-runnable.
// Thresholds here are GENERIC DEFAULTS (public-safe); HWAI-tuned values are the moat
// and are injected via DetectorOptions.thresholds, never committed here.

export interface Finding {
  id: "CD01" | "CD02" | "CD03" | "CD04" | "CD05" | "CD06" | "CD07" | "CD08";
  line: number;
  confidence: number;
  message: string;
  suggested_action: string;
}

export interface DetectorThresholds {
  guard_spam_min: number; // CD02: guards in one function above this is spam
  stale_file_days: number; // CD08: git last-commit age above this is stale
}

export interface DetectorOptions {
  allSources?: string[]; // other repo sources, for reference counting (CD03)
  // Sources that are PUBLIC API entry points (index/barrel files, package.json
  // `exports`/`main`). An export reachable by name from an entry point is public
  // API, not dead code — the library-code FP class measured in eval v2 (§5b).
  publicApiSources?: string[];
  // corpus entries + which indices are entry points, for 1-hop `export *` reachability (CD03).
  corpusEntry?: CorpusEntry;
  // Named corpus files (path + text) for cross-file module resolution (CD04 chain).
  corpusFiles?: CorpusFiles;
  // Git last-commit age in days per file (path -> days), computed by the CALLER from
  // `git log` (spec §8: no network/FS inside detectors). Drives CD08 staleness.
  // Injected like corpusFiles; when absent CD08 is inert.
  fileGitAges?: Record<string, number>;
  // Language-graph oracle: when provided, CD03 confirms text-based candidates against
  // the graph's cross-file reference count (eval v2 §5c decision).
  languageGraphOracle?: LanguageGraphOracle;
  thresholds?: Partial<DetectorThresholds>;
}

const DEFAULT_THRESHOLDS: DetectorThresholds = {
  guard_spam_min: 5,
  stale_file_days: 90,
};

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// CD04 — re-export plumbing: a file that ONLY re-exports (barrel), no local logic.
export function detectReExportPlumbing(text: string): Finding[] {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  if (lines.length === 0) return [];
  const reExport = /^\s*export\s*(\{[^}]*\}|\*\s*(?:as\s+\w+)?)\s*from\s*["'][^"']+["']\s*;?\s*$/;
  const allReExport = lines.every((l) => reExport.test(l));
  if (!allReExport) return [];
  return [
    {
      id: "CD04",
      line: 1,
      confidence: 0.8,
      message: `Barrel file: all ${lines.length} non-empty lines are pure re-exports with no added value.`,
      suggested_action: "Import from the concrete module directly; delete the barrel or give it a real responsibility.",
    },
  ];
}

// True when a source is itself a pure barrel (same test as detectReExportPlumbing).
function isPureBarrelText(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  if (lines.length === 0) return false;
  const reExport = /^\s*export\s*(\{[^}]*\}|\*\s*(?:as\s+\w+)?)\s*from\s*["'][^"']+["']\s*;?\s*$/;
  return lines.every((l) => reExport.test(l));
}

// CD04 — re-export CHAIN (spec §4: "chain of ≥2 pure re-exports"). A barrel that
// re-exports from ANOTHER pure barrel is two hops of indirection with no added value.
// Cross-file: the detector needs the corpus to know whether the re-export target is
// itself a barrel. The head of the chain (the file passed in) is flagged once.
export function detectReExportChain(text: string, selfFile: string, corpusFiles?: CorpusFiles): Finding[] {
  if (!corpusFiles || corpusFiles.length === 0) return [];
  if (!isPureBarrelText(text)) return []; // only a barrel can head a chain
  const selfDir = selfFile.includes("/") ? selfFile.slice(0, selfFile.lastIndexOf("/")) : "";
  const specRe = /\bexport\s*(?:\{[^}]*\}|\*\s*(?:as\s+\w+)?)\s*from\s*["']([^"']+)["']/g;
  const visited = new Set<string>([selfFile]);
  let m: RegExpExecArray | null;
  while ((m = specRe.exec(text))) {
    const target = resolveReExportTarget(selfDir, m[1], corpusFiles);
    if (!target || visited.has(target.file)) continue;
    visited.add(target.file);
    if (isPureBarrelText(target.text)) {
      return [
        {
          id: "CD04",
          line: lineOf(text, m.index),
          confidence: 0.7,
          message: `Re-export chain: this barrel re-exports from another pure barrel (${target.file}) — 2+ hops of re-export plumbing with no added value.`,
          suggested_action: "Re-export directly from the concrete module; collapse the intermediate barrel.",
        },
      ];
    }
  }
  return [];
}

// Resolve a relative re-export specifier to a corpus file. Node-style: an ESM
// `from "./x.js"` maps to the TS source `x.ts`; also handles extensionless and
// `./dir/index.*` forms. Returns null when the target is outside the corpus.
function resolveReExportTarget(selfDir: string, spec: string, corpusFiles: CorpusFiles): { file: string; text: string } | null {
  if (!spec.startsWith(".")) return null; // package specifier, not a local module
  const joined = normalizePath(selfDir ? `${selfDir}/${spec}` : spec);
  const stem = joined.replace(/\.(mjs|js|ts)$/, "");
  const candidates = [
    joined,
    `${stem}.ts`,
    `${stem}.js`,
    `${stem}.mjs`,
    `${joined}.ts`,
    `${joined}/index.ts`,
    `${joined}/index.js`,
  ];
  for (const cand of candidates) {
    const hit = corpusFiles.find((f) => f.file === cand);
    if (hit) return hit;
  }
  return null;
}

function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// CD07 — duplicate export (eval v2b, #19; knip-consistent). The SAME symbol re-exported
// from MORE THAN ONE barrel/entry path forces tools and humans to guess which path is
// canonical (knip "duplicate exports"; mcp-use #1449: "symbols re-exported from more
// than one entry"). Cross-file: needs corpusFiles to see the other barrels. The FIRST
// path in corpus order is canonical; the second-and-later paths are flagged. Only pure
// `export { name } from "..."` re-export lines are counted (a barrel re-exporting the
// SAME symbol twice is not a cross-path duplicate).
export function detectDuplicateExport(text: string, selfFile: string, corpusFiles?: CorpusFiles): Finding[] {
  if (!corpusFiles || corpusFiles.length === 0) return [];
  // First re-export path per symbol across the whole corpus (canonical).
  const canonical = new Map<string, string>();
  for (const f of corpusFiles) {
    for (const name of reExportedNames(f.text)) {
      if (!canonical.has(name)) canonical.set(name, f.file);
    }
  }
  const findings: Finding[] = [];
  const re = /\bexport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  const seenInSelf = new Set<string>();
  while ((m = re.exec(text))) {
    for (const part of m[1].split(",")) {
      const asM = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      const idM = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      const name = asM ? asM[1] : idM ? idM[1] : null;
      if (!name || name === "default" || seenInSelf.has(name)) continue;
      seenInSelf.add(name);
      const canon = canonical.get(name);
      if (canon && canon !== selfFile) {
        findings.push({
          id: "CD07",
          line: lineOf(text, m.index),
          confidence: 0.7,
          message: `Duplicate export: symbol "${name}" is re-exported from more than one path (canonical: ${canon}; this path: ${selfFile}).`,
          suggested_action: `Keep one canonical re-export path for "${name}" (${canon}); delete the duplicate path so importers stop guessing which is authoritative.`,
        });
        break; // one finding per file is enough; the file has at least one duplicate path
      }
    }
    if (findings.length) break;
  }
  return findings;
}

// Names re-exported by a file's pure `export { a, b as c } from "..."` lines.
function reExportedNames(text: string): string[] {
  const names: string[] = [];
  const re = /\bexport\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(",")) {
      const asM = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      const idM = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      const name = asM ? asM[1] : idM ? idM[1] : null;
      if (name && name !== "default") names.push(name);
    }
  }
  return names;
}

// CD02 — guard-clause / fallback spam: a function body packed with defensive early returns.
// Window = one function body (to the closing brace at the same indent), not a fixed char
// slice — a fixed window leaks guards from sibling functions and flags parsers as spam.
export function detectGuardSpam(text: string, min: number): Finding[] {
  const findings: Finding[] = [];
  const fnStart = /(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnStart.exec(text))) {
    const bodyStart = m.index + m[0].length - 1; // at the opening brace
    const body = extractBracedBody(text, bodyStart);
    if (!body) continue;
    const guards = (body.match(/if\s*\([^)]*\)\s*(?:return|throw)\b/g) || []).length;
    if (guards >= min) {
      findings.push({
        id: "CD02",
        line: lineOf(text, m.index),
        confidence: 0.7,
        message: `${guards} defensive guard/throw clauses in one function (threshold ${min}).`,
        suggested_action: "Collapse guards; validate once at the boundary; let the happy path read first.",
      });
    }
  }
  return findings;
}

// Return the text inside the braces starting at `openIndex` (which must be '{').
// Balanced-brace scan; returns null if unbalanced.
function extractBracedBody(text: string, openIndex: number): string | null {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

// Blank out the LITERAL TEXT portions of template literals (backtick strings), replacing
// every non-newline character with a space so string length and line numbers are unchanged.
// CD03 (task 7, dogfood): a bare `\bexport ...\b` regex over raw text cannot tell code
// from text a backtick string merely *contains* — reproduced against real prod files
// (repo-quality-gate-mcp/scripts/benchmark-local.mjs) where a fixture-generator builds
// `.ts` source via template literals; code-diet flagged the generated NAME text as an
// unrequested export of the script, which never declares it.
//
// `${...}` interpolations are NOT blanked: they are real, executed JS expressions, not
// string text (reproduced against corpus_v2/clean/zod/errors.ts's
// `` `  -> at ${toDotPath(issue.path)}` ``, a genuine call — naively blanking the whole
// backtick string turned that real reference into a new v2a clean FP, 0.100 -> 0.110;
// see detectors.test.mjs "a call inside a template literal's ${...} interpolation").
// A full parser is out of scope for a regex-based detector, so this is a conservative
// single-level scan (matches the project's stated text-based-analysis limits): nested
// template literals *inside* an interpolation are passed through as-is rather than
// re-parsed, and a `}` inside a nested string/regex within an interpolation can under-count
// brace depth in rare cases.
function blankTemplateLiterals(text: string): string {
  let out = "";
  let inTemplate = false;
  let interpDepth = 0; // >0 while inside a `${...}` interpolation (real code, left untouched)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inTemplate && interpDepth === 0 && ch === "\\") {
      // escaped char inside template literal TEXT (e.g. \` or \\): blank both, don't toggle state.
      out += " ";
      const next = text[i + 1];
      if (next !== undefined) {
        out += next === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (inTemplate && interpDepth === 0 && ch === "$" && text[i + 1] === "{") {
      interpDepth = 1;
      out += "${";
      i++;
      continue;
    }
    if (inTemplate && interpDepth > 0) {
      // pass interpolated code through unchanged; it's real code and may reference exports.
      if (ch === "{") interpDepth++;
      else if (ch === "}") interpDepth--;
      out += ch;
      continue;
    }
    if (ch === "`" && interpDepth === 0) {
      inTemplate = !inTemplate;
      out += ch;
      continue;
    }
    out += inTemplate && ch !== "\n" ? " " : ch;
  }
  return out;
}

function exportedNames(text: string): string[] {
  // CD03 measures RUNTIME references. TS type-only exports (interface / type) have no
  // runtime refs, so a text-grep always misses them -> false positive (eval v2, Category D).
  // Only value exports (function/class/const/let/var/enum) are checked for dead refs.
  const names = new Set<string>();
  const decl = /\bexport\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(blankTemplateLiterals(text)))) names.add(m[2]);
  return [...names];
}

// map each corpus file's text to whether it is a public entry point (index/main/mod).
// Resolved once per analyzeSource call and passed in.
export interface CorpusEntry {
  texts: string[];
  entryIdx: Set<number>;
}

// Named corpus files (path + text) for cross-file detectors that need to resolve
// module specifiers (CD04 re-export chain). Optional; when absent, cross-file
// path-resolution detectors are inert.
export interface CorpusFile {
  file: string;
  text: string;
}
export type CorpusFiles = CorpusFile[];

// Language-graph oracle: when provided, CD03 confirms its text-based candidates
// against the graph's cross-file reference count (eval v2 §5c decision). Text-based
// analysis cannot resolve JS module reachability; the graph can.
export interface LanguageGraphOracle {
  hasCrossFileReference(symbolName: string, selfFile: string): Promise<boolean>;
  // Texts of the files the graph actually indexed. When present, a graph "dead"
  // answer is only upgraded to a verdict if this corpus also shows no textual
  // reference outside the declaration — guards against the graph indexing a
  // partial slice where a reference exists in a file the graph never saw.
  indexedTexts?: string[];
}

// CD03 — unrequested export: exported symbol never referenced anywhere in the corpus.
// A name re-exported by a public entry point (index/barrel) is PUBLIC API, not dead.
//
// MEASURED scope limit (eval v2 §5b / dogfood Category D): text-based cross-file reference
// counting cannot resolve JS module reachability. On library code (zod: star-barrels +
// namespace imports + locale name collisions) and on internal modules used via namespace
// (`import * as mod`), a bare/naive ref count both over- and under-reports. We therefore
// (a) count references across the provided corpus, (b) skip names re-exported by an entry
// point barrel, and (c) skip the entry point's own exports. CD03 is a HIGH-RECALL candidate
// generator, not a deletion verdict — every hit MUST be confirmed with language-graph
// (find_references) before removal. Precision on library-heavy corpora is intentionally
// not the target; recall + human/graph confirmation is.
//
// When a LanguageGraphOracle is provided, CD03 queries the graph for each candidate
// and only reports findings the graph confirms as having no cross-file references.
// This eliminates the text-based FP classes (locale collisions, namespace imports,
// star-barrels) at the cost of an async oracle call per candidate.
export async function detectUnusedExports(
  text: string,
  allSources: string[],
  publicApiSources: string[] = [],
  _corpusEntry?: CorpusEntry,
  oracle?: LanguageGraphOracle,
  selfFile = "<input>",
): Promise<Finding[]> {
  const findings: Finding[] = [];
  // Cross-file text reference counting and the language-graph oracle disagree in
  // scope on partial package slices: the text corpus may be complete while the
  // graph index only covers the slice's own files (or vice versa). When both
  // signals are available, run text-based reference counting on the same
  // corpus the oracle indexed so that a reference invisible to the text pass
  // is not silently "confirmed dead" by an equally blind graph. The oracle's
  // indexed texts are authoritative for the verdict tier; the full corpus stays
  // for the candidate tier.
  const corpus = allSources.length ? allSources : [text];
  // A name that only appears as text inside a template literal elsewhere (e.g. a doc
  // string mentioning the symbol) is not a real reference either — see blankTemplateLiterals.
  const corpusForRefs = corpus.map(blankTemplateLiterals);
  // names made public by an entry-point barrel: `export { foo }` / `export { default as foo }`.
  const publicNames = new Set<string>();
  const barrelRe = /\bexport\s*\{([^}]*)\}\s*from\b/g;
  for (const src of publicApiSources) {
    let bm: RegExpExecArray | null;
    while ((bm = barrelRe.exec(src))) {
      for (const part of bm[1].split(",")) {
        const asM = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        const idM = part.trim().match(/^([A-Za-z_$][\w$]*)/);
        const name = asM ? asM[1] : idM ? idM[1] : null;
        if (name && name !== "default") publicNames.add(name);
      }
    }
  }
  const isEntryPoint = publicApiSources.includes(text);
  for (const name of exportedNames(text)) {
    if (publicNames.has(name)) continue; // re-exported by a barrel elsewhere
    if (isEntryPoint) continue; // the entry point's own exports are the API
    const ref = new RegExp(`\\b${name.replace(/[\\$]/g, "\\$&")}\\b`, "g");
    let count = 0;
    for (const src of corpusForRefs) count += (src.match(ref) || []).length;
    // 1 occurrence = the declaration itself; >1 means referenced somewhere.
    if (count <= 1) {
      // Text-based candidate: confirm with the language-graph oracle when available.
      // Oracle failure degrades to the conservative text-candidate mode — never
      // escalate to a verdict on an unavailable graph. A graph "dead" answer is
      // upgraded to a verdict only when the graph's own indexed corpus agrees
      // that the name has no textual reference outside its declaration —
      // otherwise the graph is blind in exactly the same direction as the text
      // pass (partial slice), and the finding stays a candidate.
      let oracleAnswer = null;
      let verdictEligible = false;
      if (oracle) {
        try {
          oracleAnswer = await oracle.hasCrossFileReference(name, selfFile);
          if (oracleAnswer === false && oracle.indexedTexts) {
            let graphCorpusCount = 0;
            for (const src of oracle.indexedTexts.map(blankTemplateLiterals)) {
              graphCorpusCount += (src.match(ref) || []).length;
            }
            verdictEligible = graphCorpusCount <= 1;
          } else if (oracleAnswer === false) {
            verdictEligible = true; // oracle cannot expose its corpus; trust the graph verdict
          }
        } catch {
          oracleAnswer = null;
        }
      }
      if (oracleAnswer === true) continue; // graph says the name is referenced cross-file — not dead.
      const confirmed = oracleAnswer === false && verdictEligible;
      findings.push({
        id: "CD03",
        line: lineOf(text, text.indexOf(name)),
        confidence: confirmed ? 0.85 : 0.5,
        message: confirmed
          ? `Exported symbol "${name}" has no cross-file references (language-graph confirmed).`
          : `Exported symbol "${name}" has no references in the scanned corpus (candidate — confirm with language-graph).`,
        suggested_action: confirmed
          ? "Un-export it (keep it module-local) or delete it. Verified with language-graph."
          : "Confirm with language-graph find_references; then un-export (module-local) or delete. Do NOT delete on this signal alone.",
      });
    }
  }
  return findings;
}

// CD01 — abstraction bloat: interface with exactly 1 implementation and no
// polymorphic usage (the interface is never used as a TYPE elsewhere). A 1:1
// interface adds an indirection layer with no abstraction payoff.
export function detectAbstractionBloat(text: string, allSources: string[]): Finding[] {
  const findings: Finding[] = [];
  const corpus = allSources.length ? allSources : [text];
  const ifaceRe = /\binterface\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = ifaceRe.exec(text))) {
    const name = m[1];
    let implCount = 0;
    let typeUseCount = 0;
    for (const src of corpus) {
      implCount += (src.match(new RegExp(`\\bimplements\\s+${name}\\b`, "g")) || []).length;
      // polymorphic use = the interface name appears as a type annotation / generic arg
      typeUseCount += (src.match(new RegExp(`[:<(,]\\s*${name}\\b`, "g")) || []).length;
    }
    if (implCount === 1 && typeUseCount === 0) {
      findings.push({
        id: "CD01",
        line: lineOf(text, m.index),
        confidence: 0.55,
        message: `Interface "${name}" has exactly 1 implementation and no polymorphic type usage.`,
        suggested_action: "Inline the interface into its single implementor, or add a second implementation to justify the abstraction.",
      });
    }
  }
  return findings;
}

// CD05 — reinvention: helper duplicating a stdlib capability. Conservative allowlist
// of well-known "reinvented" helpers (left-pad class). Named-match on the function +
// a manual-loop body heuristic to keep FP low.
const REINVENTION_PATTERNS: { re: RegExp; stdlib: string }[] = [
  { re: /\b(?:export\s+)?function\s+(leftPad|padLeft)\s*\(/, stdlib: "String.prototype.padStart" },
  { re: /\b(?:export\s+)?function\s+(rightPad|padRight)\s*\(/, stdlib: "String.prototype.padEnd" },
];

export function detectReinvention(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { re, stdlib } of REINVENTION_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    findings.push({
      id: "CD05",
      line: lineOf(text, m.index),
      confidence: 0.65,
      message: `Helper "${m[1]}" reinvents ${stdlib}.`,
      suggested_action: `Replace with ${stdlib} (stdlib, no new dependency).`,
    });
  }
  return findings;
}

// CD06 — dead code: never-true condition (constant-false guard) makes a branch
// unreachable. Conservative: only constant / self-inequality patterns.
const NEVER_TRUE = [
  /\bif\s*\(\s*false\s*\)/,
  /\bif\s*\(\s*0\s*\)/,
  /\bif\s*\(\s*null\s*\)/,
  /\bif\s*\(\s*undefined\s*\)/,
  /\bif\s*\(\s*""\s*\)/,
  /\bif\s*\(\s*''\s*\)/,
  /\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*!==\s*\1\s*\)/, // x !== x (NaN check done wrong)
];

export function detectDeadCode(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const re of NEVER_TRUE) {
    const m = re.exec(text);
    if (!m) continue;
    findings.push({
      id: "CD06",
      line: lineOf(text, m.index),
      confidence: 0.7,
      message: `Never-true condition "${m[0]}" makes the branch unreachable.`,
      suggested_action: "Remove the dead branch, or fix the condition if it was meant to be reachable.",
    });
  }
  return findings;
}

// CD08 — stale file (detect_drift, #17). A file whose last git commit is older than the
// staleness threshold is likely abandoned code that drifts out of sync with the rest of
// the repo. Per spec §8 (no network/FS inside detectors) the git signal is INJECTED as
// fileGitAges (path -> days since last commit) by the caller, which computes it from
// `git log`. The detector stays a pure function; without injected ages it is inert.
// Research basis: git last-commit is the authoritative staleness signal (mtime lies
// under touch/checkout/formatter); repowise `index_age_days`/`stale_warning` and
// git-branch aging use HEAD-divergence/commit-age, not mtime. CD08 is a WARN (low
// confidence), not a deletion verdict — a stale file may still be load-bearing.
export function detectStaleFile(selfFile: string, fileGitAges?: Record<string, number>, thresholdDays = 90): Finding[] {
  if (!fileGitAges) return [];
  const age = fileGitAges[selfFile];
  if (age === undefined || age <= thresholdDays) return [];
  return [
    {
      id: "CD08",
      line: 1,
      confidence: 0.5,
      message: `Stale file: last git commit ${age}d ago (threshold ${thresholdDays}d). Likely abandoned — it may have drifted out of sync.`,
      suggested_action: "Review whether this file is still load-bearing; if abandoned, delete or refresh it. Warn only — confirm before removing.",
    },
  ];
}

export async function analyzeSource(text: string, _path = "<input>", options: DetectorOptions = {}): Promise<Finding[]> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const allSources = options.allSources || [text];
  const publicApiSources = options.publicApiSources || [];
  return [
    ...detectReExportPlumbing(text),
    ...detectReExportChain(text, _path, options.corpusFiles),
    ...detectDuplicateExport(text, _path, options.corpusFiles),
    ...detectGuardSpam(text, thresholds.guard_spam_min),
    ...(await detectUnusedExports(text, allSources, publicApiSources, options.corpusEntry, options.languageGraphOracle, _path)),
    ...detectAbstractionBloat(text, allSources),
    ...detectReinvention(text),
    ...detectDeadCode(text),
    ...detectStaleFile(_path, options.fileGitAges, thresholds.stale_file_days),
  ];
}
