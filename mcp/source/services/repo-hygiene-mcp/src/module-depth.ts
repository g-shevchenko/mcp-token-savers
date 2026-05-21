// Deterministic deep-module scorer — an Ousterhout depth proxy.
//
// A DEEP module has a SMALL interface hiding a LARGE implementation.
// depth_ratio = impl_complexity / interface_surface. High = deep (good);
// low = shallow (a thin wrapper or a wide-interface utils bag = a deepening
// candidate). This is the deterministic "expert toolset" half of the iSMELL
// pattern (LLM judgment + deterministic detector): it gives a reusable metric
// for before/after refactor deltas and an independent cross-check on a
// reviewer's depth judgment.
//
// Validated against unit tests + cross-validation fixtures: the metric
// separates deep modules (small interface, large cohesive impl) from shallow
// thin wrappers and wide-interface utils bags.
//
// SCOPE LIMIT (do not over-trust): this measures interface÷implementation,
// NOT "hidden missing-abstraction seam" — a module can score `deep` and still
// have a real extract-seam opportunity (use scan_duplicate_code for that).
// v0.1 nesting is indentation-based and over-counts on multi-line literals;
// the band is ratio-driven and unaffected.

import fs from "node:fs/promises";
import path from "node:path";
import { RepoHygieneConfig } from "./config.js";

const GOD_FUNCTION_LINES = 25;
const DEEP_NESTING_LEVEL = 3;
const MANY_PARAMS = 4;
const SHALLOW_BELOW = 3;
const DEEP_AT_OR_ABOVE = 8;

const W_PUBLIC_SYMBOL = 2;
const W_PUBLIC_PARAM = 0.5;
const W_IMPL_LINE = 1;
const W_FUNCTION = 2;
const W_BRANCH = 1;
const W_EXCESS_NESTING = 3;

export type DepthLang = "python" | "ts";
export type DepthBand = "shallow" | "balanced" | "deep";

export interface ModuleDepthScore {
  interface_surface: number;
  impl_complexity: number;
  depth_ratio: number;
  band: DepthBand;
  public_symbols: number;
  loc: number;
  factors: string[];
}

export interface ModuleDepthCompare {
  direction: "deeper" | "shallower" | "flat";
  depth_ratio_delta: number;
  band_before: DepthBand;
  band_after: DepthBand;
  interface_surface_delta: number;
  impl_complexity_delta: number;
}

interface FuncDecl {
  indent: number;
  name: string;
  kind: "def" | "class" | "function" | "arrow";
  params: number;
  startIdx: number;
  isPublic: boolean;
}

function langFromExt(filename = ""): DepthLang {
  if (/\.(py|pyi)$/.test(filename)) return "python";
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filename)) return "ts";
  return "python";
}

function isComment(line: string, lang: DepthLang): boolean {
  const t = line.trim();
  if (!t) return false;
  if (lang === "python") return t.startsWith("#");
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function leadingSpaces(line: string): number {
  const expanded = line.replace(/\t/g, "    ");
  const m = expanded.match(/^( *)/);
  return m ? m[1].length : 0;
}

function countParams(sig: string): number {
  const inner = sig.trim();
  if (!inner) return 0;
  return inner
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && p !== "self" && p !== "cls" && p !== "*" && p !== "/").length;
}

function extractSignatureParams(line: string): number {
  const open = line.indexOf("(");
  if (open === -1) return 0;
  let depth = 0;
  let end = -1;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === "(") depth += 1;
    else if (line[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return 0;
  return countParams(line.slice(open + 1, end));
}

function detectIndentUnit(lines: string[]): number {
  let unit = Infinity;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    if (!line.trim()) continue;
    const ind = leadingSpaces(line);
    if (ind > 0 && ind < unit) unit = ind;
  }
  return Number.isFinite(unit) ? unit : 4;
}

function functionMatch(line: string, lang: DepthLang): { indent: number; name: string; kind: FuncDecl["kind"] } | null {
  if (lang === "python") {
    const m = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (m) return { indent: m[1].length, name: m[2], kind: "def" };
    const c = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/);
    if (c) return { indent: c[1].length, name: c[2], kind: "class" };
    return null;
  }
  const fn = line.match(/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (fn) return { indent: fn[1].length, name: fn[2], kind: "function" };
  const cls = line.match(/^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (cls) return { indent: cls[1].length, name: cls[2], kind: "class" };
  const arrow = line.match(/^(\s*)(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>/);
  if (arrow) return { indent: arrow[1].length, name: arrow[2], kind: "arrow" };
  return null;
}

function tsTopLevelIsExported(line: string): boolean {
  return /^\s*export\b/.test(line);
}

export function scoreModule(source: string, opts: { lang?: DepthLang; filename?: string } = {}): ModuleDepthScore {
  const lang = opts.lang || langFromExt(opts.filename || "");
  const rawLines = String(source).split("\n");
  const unit = detectIndentUnit(rawLines);

  let implLines = 0;
  let branches = 0;
  let maxNesting = 0;
  let functions = 0;
  let publicSymbols = 0;
  let publicParams = 0;
  const factors: string[] = [];
  const funcDecls: FuncDecl[] = [];

  rawLines.forEach((raw, idx) => {
    const line = raw.replace(/\t/g, "    ");
    if (!line.trim() || isComment(line, lang)) return;
    const indent = leadingSpaces(line);
    const level = Math.round(indent / unit);
    if (level > maxNesting) maxNesting = level;
    if (indent > 0) implLines += 1;
    const branchMatches = line.match(/\b(if|elif|else|for|while|except|case|catch|and|or)\b/g) || [];
    branches += branchMatches.length;
    const decl = functionMatch(line, lang);
    if (decl) {
      const params = decl.kind === "class" ? 0 : extractSignatureParams(line);
      const isPublic =
        lang === "python"
          ? decl.indent === 0 && !decl.name.startsWith("_")
          : decl.indent === 0 && tsTopLevelIsExported(line);
      funcDecls.push({ ...decl, params, startIdx: idx, isPublic });
      if (decl.kind !== "class") functions += 1;
      if (isPublic) {
        publicSymbols += 1;
        publicParams += params;
        if (params > MANY_PARAMS) factors.push(`many_params:${decl.name}:${params}`);
      }
    }
  });

  for (const fn of funcDecls) {
    if (fn.kind === "class") continue;
    let bodyLen = 0;
    for (let j = fn.startIdx + 1; j < rawLines.length; j += 1) {
      const line = rawLines[j].replace(/\t/g, "    ");
      if (!line.trim() || isComment(line, lang)) continue;
      if (leadingSpaces(line) <= fn.indent) break;
      bodyLen += 1;
    }
    if (bodyLen > GOD_FUNCTION_LINES) factors.push(`god_function:${fn.name}:${bodyLen}`);
  }

  if (maxNesting > DEEP_NESTING_LEVEL) factors.push(`deep_nesting:${maxNesting}`);

  const excessNesting = Math.max(0, maxNesting - 1);
  const impl_complexity =
    implLines * W_IMPL_LINE + functions * W_FUNCTION + branches * W_BRANCH + excessNesting * W_EXCESS_NESTING;
  const interface_surface = publicSymbols * W_PUBLIC_SYMBOL + publicParams * W_PUBLIC_PARAM;
  const depth_ratio = Number((impl_complexity / Math.max(interface_surface, 1)).toFixed(2));

  let band: DepthBand;
  if (depth_ratio < SHALLOW_BELOW) band = "shallow";
  else if (depth_ratio >= DEEP_AT_OR_ABOVE) band = "deep";
  else band = "balanced";

  return {
    interface_surface: Number(interface_surface.toFixed(2)),
    impl_complexity,
    depth_ratio,
    band,
    public_symbols: publicSymbols,
    loc: implLines,
    factors,
  };
}

export function compareDepth(before: ModuleDepthScore, after: ModuleDepthScore): ModuleDepthCompare {
  const depth_ratio_delta = Number((after.depth_ratio - before.depth_ratio).toFixed(2));
  let direction: ModuleDepthCompare["direction"] = "flat";
  if (depth_ratio_delta > 0.5) direction = "deeper";
  else if (depth_ratio_delta < -0.5) direction = "shallower";
  return {
    direction,
    depth_ratio_delta,
    band_before: before.band,
    band_after: after.band,
    interface_surface_delta: Number((after.interface_surface - before.interface_surface).toFixed(2)),
    impl_complexity_delta: after.impl_complexity - before.impl_complexity,
  };
}

// --- MCP wrapper ---

export interface ModuleDepthArgs {
  repo_root?: string;
  path?: string; // file to score (the "after"), relative to repo_root or absolute-within-root
  compare_to?: string; // optional second file treated as the "before"
  lang?: DepthLang;
  metadata?: unknown;
}

function resolveWithinRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes repo_root");
  }
  return abs;
}

async function readBoundedSource(config: RepoHygieneConfig, absPath: string): Promise<string> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error("path is not a file");
  if (stat.size > config.maxFileBytes) {
    throw new Error(`file too large to score (${stat.size} > ${config.maxFileBytes} bytes)`);
  }
  return fs.readFile(absPath, "utf8");
}

export async function scoreModuleDepth(config: RepoHygieneConfig, args: ModuleDepthArgs) {
  const root = path.resolve(args.repo_root || process.cwd());
  if (typeof args.path !== "string" || !args.path.trim()) {
    throw new Error("path is required");
  }
  const afterAbs = resolveWithinRoot(root, args.path);
  const afterSource = await readBoundedSource(config, afterAbs);
  const afterScore = scoreModule(afterSource, { lang: args.lang, filename: afterAbs });

  const result: Record<string, unknown> = {
    status: "ok",
    schema_version: "repo-hygiene-module-depth.v0.1",
    file: path.relative(root, afterAbs).split(path.sep).join("/"),
    ...afterScore,
    band: afterScore.band, // explicit (also surfaced for log aggregate)
    depth_ratio: afterScore.depth_ratio,
  };

  if (typeof args.compare_to === "string" && args.compare_to.trim()) {
    const beforeAbs = resolveWithinRoot(root, args.compare_to);
    const beforeSource = await readBoundedSource(config, beforeAbs);
    const beforeScore = scoreModule(beforeSource, { lang: args.lang, filename: beforeAbs });
    result.before = {
      file: path.relative(root, beforeAbs).split(path.sep).join("/"),
      ...beforeScore,
    };
    result.after = { file: result.file, ...afterScore };
    result.compare = compareDepth(beforeScore, afterScore);
  }

  return result;
}
