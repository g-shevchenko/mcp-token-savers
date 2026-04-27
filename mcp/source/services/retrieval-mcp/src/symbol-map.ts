import fs from "node:fs/promises";
import path from "node:path";
import { classifyFilteredPath, displayPath } from "./path-policy.js";

export interface SymbolEntry {
  kind: string;
  line: number;
  name: string;
  path: string;
  signature?: string;
}

export interface ImportEdge {
  kind: "import" | "export" | "require" | "route";
  line: number;
  path: string;
  target: string;
}

export interface SymbolScan {
  imports: ImportEdge[];
  path: string;
  symbols: SymbolEntry[];
}

const SYMBOL_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
]);

const SYMBOL_STOP_WORDS = new Set([
  "where",
  "are",
  "and",
  "for",
  "the",
  "use",
  "this",
  "that",
  "before",
  "after",
  "when",
  "what",
  "when",
  "which",
  "does",
  "with",
  "from",
  "into",
  "file",
  "code",
  "implemented",
  "implementation",
  "documented",
  "documents",
  "rules",
]);

function splitIdentifier(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2);
}

function termVariants(term: string): string[] {
  const lower = term.toLowerCase();
  const variants = new Set([lower]);
  if (lower.endsWith("ing") && lower.length > 5) {
    const stem = lower.slice(0, -3);
    variants.add(stem);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
      variants.add(stem.slice(0, -1));
    }
  }
  if (lower.endsWith("ies") && lower.length > 5) {
    variants.add(`${lower.slice(0, -3)}y`);
  }
  if (lower.endsWith("es") && lower.length > 4) {
    variants.add(lower.slice(0, -2));
  }
  if (lower.endsWith("s") && lower.length > 4) {
    variants.add(lower.slice(0, -1));
  }
  return Array.from(variants).filter((item) => item.length >= 3 && !SYMBOL_STOP_WORDS.has(item));
}

function normalizedQueryTerms(terms: string[]): string[] {
  return Array.from(new Set(terms.flatMap(termVariants))).slice(0, 32);
}

function shouldScan(relativePath: string): boolean {
  return !classifyFilteredPath(relativePath) && SYMBOL_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function addSymbol(
  symbols: SymbolEntry[],
  relativePath: string,
  kind: string,
  name: string | undefined,
  line: number,
  signature?: string,
): void {
  if (!name || symbols.length >= 120) {
    return;
  }
  symbols.push({
    path: displayPath(relativePath),
    kind,
    name,
    line,
    signature: signature?.trim().slice(0, 220),
  });
}

function addImport(
  imports: ImportEdge[],
  relativePath: string,
  kind: ImportEdge["kind"],
  target: string | undefined,
  line: number,
): void {
  if (!target || imports.length >= 120) {
    return;
  }
  imports.push({
    path: displayPath(relativePath),
    kind,
    target,
    line,
  });
}

function parseCodeSymbols(relativePath: string, lines: string[]): SymbolScan {
  const symbols: SymbolEntry[] = [];
  const imports: ImportEdge[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    const routeMatch = trimmed.match(
      /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/,
    );
    if (routeMatch) {
      addSymbol(symbols, relativePath, "route", `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, lineNumber, trimmed);
      addImport(imports, relativePath, "route", `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`, lineNumber);
    }

    const toolMatch = trimmed.match(/\bname:\s*["']([A-Za-z0-9_.:-]+)["']/);
    if (toolMatch) {
      addSymbol(symbols, relativePath, "tool", toolMatch[1], lineNumber, trimmed);
    }

    const functionMatch = trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)/,
    );
    if (functionMatch) {
      addSymbol(symbols, relativePath, "function", functionMatch[1], lineNumber, trimmed);
    }

    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (classMatch) {
      addSymbol(symbols, relativePath, "class", classMatch[1], lineNumber, trimmed);
    }

    const typeMatch = trimmed.match(/^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (typeMatch) {
      addSymbol(symbols, relativePath, "type", typeMatch[1], lineNumber, trimmed);
    }

    const constFunctionMatch = trimmed.match(
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/,
    );
    if (constFunctionMatch) {
      addSymbol(symbols, relativePath, "function", constFunctionMatch[1], lineNumber, trimmed);
    }

    const importMatch = trimmed.match(/\bimport\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/);
    if (importMatch) {
      addImport(imports, relativePath, "import", importMatch[1], lineNumber);
    }

    const exportMatch = trimmed.match(/\bexport\s+[^"']+\s+from\s+["']([^"']+)["']/);
    if (exportMatch) {
      addImport(imports, relativePath, "export", exportMatch[1], lineNumber);
    }

    const requireMatch = trimmed.match(/\brequire\(\s*["']([^"']+)["']\s*\)/);
    if (requireMatch) {
      addImport(imports, relativePath, "require", requireMatch[1], lineNumber);
    }

    const pythonFunctionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (pythonFunctionMatch) {
      addSymbol(symbols, relativePath, "function", pythonFunctionMatch[1], lineNumber, trimmed);
    }

    const pythonClassMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (pythonClassMatch) {
      addSymbol(symbols, relativePath, "class", pythonClassMatch[1], lineNumber, trimmed);
    }

    const pythonImportMatch = trimmed.match(/^(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/);
    if (pythonImportMatch) {
      addImport(imports, relativePath, "import", pythonImportMatch[1] || pythonImportMatch[2], lineNumber);
    }

    const shellFunctionMatch = trimmed.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/);
    if (shellFunctionMatch) {
      addSymbol(symbols, relativePath, "function", shellFunctionMatch[1], lineNumber, trimmed);
    }
  }

  return { path: displayPath(relativePath), symbols, imports };
}

function parseMarkdownSymbols(relativePath: string, lines: string[]): SymbolScan {
  const symbols: SymbolEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (match) {
      addSymbol(symbols, relativePath, `heading${match[1].length}`, match[2].trim().slice(0, 120), index + 1, line.trim());
    }
  }
  return { path: displayPath(relativePath), symbols, imports: [] };
}

function parseYamlSymbols(relativePath: string, lines: string[]): SymbolScan {
  const symbols: SymbolEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^([A-Za-z0-9_.-][A-Za-z0-9_.-]*):\s*/);
    if (match) {
      addSymbol(symbols, relativePath, "key", match[1], index + 1, line.trim());
    }
  }
  return { path: displayPath(relativePath), symbols, imports: [] };
}

function parseSymbols(relativePath: string, text: string): SymbolScan {
  const lines = text.split(/\r?\n/);
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".md" || ext === ".mdx") {
    return parseMarkdownSymbols(relativePath, lines);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return parseYamlSymbols(relativePath, lines);
  }
  return parseCodeSymbols(relativePath, lines);
}

async function readTextFile(root: string, relativePath: string, maxFileBytes: number): Promise<string | null> {
  if (!shouldScan(relativePath)) {
    return null;
  }
  const absolutePath = path.join(root, relativePath);
  const info = await fs.stat(absolutePath);
  if (!info.isFile() || info.size > maxFileBytes) {
    return null;
  }
  const buffer = await fs.readFile(absolutePath);
  if (buffer.includes(0)) {
    return null;
  }
  return buffer.toString("utf8");
}

export async function extractSymbolMap(
  root: string,
  files: string[],
  maxFileBytes: number,
): Promise<Map<string, SymbolScan>> {
  const uniqueFiles = Array.from(new Set(files)).filter(shouldScan);
  const entries = await Promise.all(
    uniqueFiles.map(async (relativePath) => {
      try {
        const text = await readTextFile(root, relativePath, maxFileBytes);
        if (!text) {
          return null;
        }
        return [relativePath, parseSymbols(relativePath, text)] as const;
      } catch {
        return null;
      }
    }),
  );

  return new Map(entries.filter((entry): entry is readonly [string, SymbolScan] => Boolean(entry)));
}

export function symbolMatchScore(scan: SymbolScan, terms: string[]): { reasons: string[]; score: number } {
  const queryTerms = normalizedQueryTerms(terms);
  const reasons = new Set<string>();
  let score = 0;

  for (const symbol of scan.symbols) {
    const symbolParts = new Set([...splitIdentifier(symbol.name), symbol.name.toLowerCase()]);
    const signature = symbol.signature?.toLowerCase() || "";
    for (const term of queryTerms) {
      if (symbolParts.has(term) || symbol.name.toLowerCase().includes(term)) {
        score += symbol.kind === "route" || symbol.kind === "tool" ? 18 : 14;
        reasons.add(`symbol ${symbol.kind} "${symbol.name}" matches "${term}"`);
      } else if (signature.includes(term)) {
        score += 4;
        reasons.add(`symbol signature mentions "${term}"`);
      }
    }
  }

  for (const edge of scan.imports) {
    const target = edge.target.toLowerCase();
    for (const term of queryTerms) {
      if (target.includes(term)) {
        score += 3;
        reasons.add(`${edge.kind} target mentions "${term}"`);
      }
    }
  }

  return { score: Math.min(score, 60), reasons: Array.from(reasons).slice(0, 6) };
}

export function buildSymbolContext(
  scans: Map<string, SymbolScan>,
  terms: string[],
  related: Array<{ path: string; reason: string }>,
) {
  const queryTerms = normalizedQueryTerms(terms);
  const allSymbols = Array.from(scans.values()).flatMap((scan) => scan.symbols);
  const allImports = Array.from(scans.values()).flatMap((scan) => scan.imports);
  const definitions = allSymbols.filter((symbol) => {
    const name = symbol.name.toLowerCase();
    const parts = new Set([...splitIdentifier(symbol.name), name]);
    return queryTerms.some((term) => parts.has(term) || name.includes(term) || symbol.signature?.toLowerCase().includes(term));
  });

  return {
    symbols: allSymbols.slice(0, 80),
    definitions: definitions.slice(0, 30),
    import_edges: allImports.slice(0, 60),
    test_counterparts: related
      .filter((item) => item.reason.startsWith("test/spec counterpart"))
      .slice(0, 20),
  };
}
