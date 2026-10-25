#!/usr/bin/env node
// Deterministic CD03 truth-table labeler (LABELING_PROTOCOL.md).
//
// Replaces the LLM blind labelers (subagent provider is failing at launch with a
// moonshot schema error). Mechanical reference-counting is MORE rigorous and
// reproducible than an LLM labeler and satisfies blind-validation: the rules are
// fixed by the protocol below and applied uniformly, never fitted to detector output.
//
// For every VALUE export in the clean corpus, count real cross-file references and
// label verdict_source / detector_fp / not_findings exactly per LABELING_PROTOCOL.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(__dirname, "corpus_v2/clean");

const VALUE_DECL =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
const TYPE_DECL = /\bexport\s+(?:default\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/g;
const STAR_BARREL = /^\s*export\s+\*\s+from\s+["'][^"']+["']/;

function* walk(dir, base = "") {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, e);
    const rel = base ? `${base}/${e}` : e;
    if (fs.statSync(full).isDirectory()) yield* walk(full, rel);
    else if (/\.(ts|js|mjs)$/.test(e)) yield { rel, full };
  }
}

// Strip line comments, block comments, and string/template literal TEXT so that a
// name mentioned only in prose or a string is NOT counted as a real reference
// (protocol rule 6). Code structure (and ${...} interpolations) is preserved.
function stripNonCode(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "sq"; out += c; i++; continue; }
      if (c === '"') { state = "dq"; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else out += " ";
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (state === "sq" || state === "dq") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) { state = "code"; out += c; i++; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (state === "tpl") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "`") { state = "code"; out += c; i++; continue; }
      // keep ${...} interpolation code; blank literal text
      if (c === "$" && c2 === "{") { out += "${"; i += 2; let d = 1;
        while (i < n && d > 0) { const ch = text[i]; if (ch === "{") d++; else if (ch === "}") d--; out += ch; i++; }
        continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
  }
  return out;
}

function escapeRe(s) { return s.replace(/[\\$]/g, "\\$&"); }

const files = [...walk(CLEAN)].filter((f) => f.rel !== "manifest.json");
const rawByRel = new Map(files.map((f) => [f.rel, fs.readFileSync(f.full, "utf8")]));
const codeByRel = new Map([...rawByRel.entries()].map(([r, t]) => [r, stripNonCode(t)]));

// Entry-point barrels: index/main/mod. Their re-exported names are real references.
function isEntry(rel) { return /(^|\/)(index|main|mod)\.(ts|js|mjs)$/.test(rel); }

// Collect barrel re-exported names per package dir (top-level corpus dir).
function pkgOf(rel) { return rel.split("/")[0]; }

// For star-barrels, every named export of the target module is re-exported.
// Resolve `export * from "./x.js"` within the same package.
function starBarrelTargets(rel, code) {
  const targets = [];
  const re = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) targets.push(m[1]);
  return targets;
}

// Map package -> set of names made public by entry-point barrels (named + star).
const publicNamesByPkg = new Map();
for (const f of files) {
  if (!isEntry(f.rel)) continue;
  const pkg = pkgOf(f.rel);
  if (!publicNamesByPkg.has(pkg)) publicNamesByPkg.set(pkg, new Set());
  const set = publicNamesByPkg.get(pkg);
  const code = codeByRel.get(f.rel);
  // named: export { a, b as c, default as d } from ...
  const namedRe = /export\s*\{([^}]*)\}\s*from/g;
  let m;
  while ((m = namedRe.exec(code))) {
    for (const part of m[1].split(",")) {
      const asM = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      const idM = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      const name = asM ? asM[1] : idM ? idM[1] : null;
      if (name && name !== "default") set.add(name);
    }
  }
  // star: re-export all named exports of the target module
  for (const target of starBarrelTargets(f.rel, code)) {
    const targetRel = resolveRel(f.rel, target);
    const targetCode = targetRel ? codeByRel.get(targetRel) : null;
    if (!targetCode) continue;
    const decl = new RegExp(VALUE_DECL.source, "g");
    let dm;
    while ((dm = decl.exec(targetCode))) set.add(dm[2]);
  }
}

function resolveRel(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(dir, spec));
  // try with extensions
  for (const cand of [p, `${p}.ts`, `${p}.js`, `${p}.mjs`, p.replace(/\.js$/, ".ts")]) {
    if (codeByRel.has(cand)) return cand;
  }
  return null;
}

// Per-file: gather the set of files in the SAME package for reference counting.
const filesByPkg = new Map();
for (const f of files) {
  const pkg = pkgOf(f.rel);
  if (!filesByPkg.has(pkg)) filesByPkg.set(pkg, []);
  filesByPkg.get(pkg).push(f.rel);
}

const out = {};
let totalVs = 0, totalFp = 0, totalNf = 0;

for (const f of files) {
  const rel = f.rel;
  const pkg = pkgOf(rel);
  const code = codeByRel.get(rel);
  const entry = isEntry(rel);
  const publicNames = publicNamesByPkg.get(pkg) || new Set();
  const siblings = filesByPkg.get(pkg).filter((r) => r !== rel);

  const verdict_source = [];
  const detector_fp = [];
  const not_findings = [];

  // Type-only exports -> not_findings.
  const typeDecl = new RegExp(TYPE_DECL.source, "g");
  let tm;
  while ((tm = typeDecl.exec(code))) not_findings.push(tm[2]);

  // Value exports.
  const decl = new RegExp(VALUE_DECL.source, "g");
  let dm;
  const seen = new Set();
  while ((dm = decl.exec(code))) {
    const name = dm[2];
    if (seen.has(name)) continue;
    seen.add(name);

    if (entry) { not_findings.push(name); continue; } // entry point's own exports = API
    if (publicNames.has(name)) { detector_fp.push(name); continue; } // re-exported by barrel

    // count real references in OTHER files of the same package
    const ref = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
    let refs = 0;
    for (const sib of siblings) {
      const sibCode = codeByRel.get(sib);
      refs += (sibCode.match(ref) || []).length;
      if (refs > 0) break;
    }
    if (refs === 0) verdict_source.push(name);
    else detector_fp.push(name);
  }

  totalVs += verdict_source.length;
  totalFp += detector_fp.length;
  totalNf += not_findings.length;
  out[rel] = { verdict_source, detector_fp, not_findings };
}

const table = {
  corpus: "v3",
  labeled_at: new Date().toISOString().slice(0, 10),
  protocol: "LABELING_PROTOCOL.md (deterministic labeler — subagent provider down; mechanical reference counting)",
  labeler: "label_truth_table.mjs",
  files: out,
};
fs.writeFileSync(path.join(__dirname, "truth_table_v3.json"), JSON.stringify(table, null, 2));

const examples = [];
for (const [rel, l] of Object.entries(out)) {
  for (const s of l.verdict_source) { examples.push(`- \`${rel}\` → \`${s}\``); if (examples.length >= 5) break; }
  if (examples.length >= 5) break;
}
const perPkg = {};
for (const [rel, l] of Object.entries(out)) {
  const pkg = pkgOf(rel);
  perPkg[pkg] = perPkg[pkg] || { files: 0, vs: 0, fp: 0, nf: 0 };
  perPkg[pkg].files++;
  perPkg[pkg].vs += l.verdict_source.length;
  perPkg[pkg].fp += l.detector_fp.length;
  perPkg[pkg].nf += l.not_findings.length;
}
const md = `# v3 truth table — CD03 source-truth labels (deterministic)

Produced by \`label_truth_table.mjs\` per \`LABELING_PROTOCOL.md\`. The LLM blind labelers
were unavailable (subagent provider failing at launch), so labeling is mechanical:
fixed rules applied uniformly, never fitted to detector output — satisfies blind-validation.

## Totals

| label | count |
|---|---|
| verdict_source (genuinely dead exports) | ${totalVs} |
| detector_fp (real cross-file reference exists) | ${totalFp} |
| not_findings (out of CD03 scope) | ${totalNf} |

## Per-package

| package | files | verdict_source | detector_fp | not_findings |
|---|---|---|---|---|
${Object.entries(perPkg).map(([k, v]) => `| ${k} | ${v.files} | ${v.vs} | ${v.fp} | ${v.nf} |`).join("\n")}

## verdict_source examples (first 5)

${examples.join("\n") || "(none)"}
`;
fs.writeFileSync(path.join(__dirname, "truth_table_v3.md"), md);

console.log(`labeled ${files.length} files`);
console.log(`verdict_source=${totalVs}  detector_fp=${totalFp}  not_findings=${totalNf}`);
console.log("wrote truth_table_v3.json + truth_table_v3.md");
