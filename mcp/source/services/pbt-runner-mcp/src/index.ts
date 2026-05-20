#!/usr/bin/env node
// services/pbt-runner-mcp/src/index.ts
//
// Property-based testing runner MCP. Wraps hypothesis (Python) + fast-check (TS)
// with structured counterexample parsing. Three property archetypes:
// invariant, inverse, idempotence.
//
// Research-backed:
//   - PGS (arxiv:2506.18315, 2026): +23-37% pass@1 over example-based TDD
//   - Anthropic Agentic PBT (arxiv:2510.09907, Oct 2025): 56% valid bug rate
//
// 3 tools:
//   - run_property: spawns subprocess with hypothesis/fast-check, parses counterexample
//   - suggest_strategies: maps input descriptions to strategy code
//   - record_property_run: durable run history in .agent/pbt/runs.jsonl

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyArchetype = "invariant" | "inverse" | "idempotence";
export type SupportedLanguage = "python" | "typescript";

export interface RunPropertyResult {
  outcome: "passed" | "falsified" | "error" | "timeout";
  counterexample: string | null;
  shrunk_input: string | null;
  examples_tried: number | null;
  raw_output: string;
  exit_code: number;
  exec_ms: number;
  error_message: string | null;
}

export interface SuggestStrategiesResult {
  strategies_code: string;
  example_usage: string;
}

export interface RecordPropertyRunResult {
  recorded: boolean;
  run_id: string;
}

// ─── Parser: Hypothesis (Python) ─────────────────────────────────────────────

const HYPO_FALSIFY_RE = /Falsifying example:/i;
// ReDoS-safe: bounded digit + whitespace quantifiers (see CodeQL js/redos)
const HYPO_EXAMPLES_RE = /(\d{1,9})\s{1,10}examples?\s{1,10}(?:passed|tried)/i;
const PY_IMPORT_ERROR_RE = /\b(ImportError|ModuleNotFoundError|No module named)\b/;
const PY_SYNTAX_ERROR_RE = /\bSyntaxError\b/;

export function parseHypothesisOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): RunPropertyResult {
  const raw_output = stdout + stderr;

  // Error path: import or syntax error in stderr
  if (PY_IMPORT_ERROR_RE.test(stderr)) {
    return makeResult({
      outcome: "error",
      raw_output,
      exit_code: exitCode,
      error_message: "ImportError: hypothesis not installed or test setup broken",
    });
  }
  if (PY_SYNTAX_ERROR_RE.test(stderr)) {
    return makeResult({
      outcome: "error",
      raw_output,
      exit_code: exitCode,
      error_message: "SyntaxError in generated property script",
    });
  }

  // Falsification
  if (HYPO_FALSIFY_RE.test(stderr)) {
    const block = extractFalsifyingBlock(stderr);
    const assignments = extractAssignments(block);
    return makeResult({
      outcome: "falsified",
      counterexample: block,
      shrunk_input: assignments,
      raw_output,
      exit_code: exitCode,
    });
  }

  // Examples count (passed path)
  const examplesMatch = HYPO_EXAMPLES_RE.exec(raw_output);
  const examples_tried = examplesMatch ? parseInt(examplesMatch[1], 10) : null;

  if (exitCode === 0) {
    return makeResult({
      outcome: "passed",
      raw_output,
      exit_code: exitCode,
      examples_tried,
    });
  }

  return makeResult({
    outcome: "error",
    raw_output,
    exit_code: exitCode,
    error_message: `Property runner exited ${exitCode} without recognized output pattern`,
  });
}

function extractFalsifyingBlock(stderr: string): string {
  const startIdx = stderr.indexOf("Falsifying example:");
  if (startIdx === -1) return "";
  const tail = stderr.slice(startIdx + "Falsifying example:".length);
  const endIdx = tail.indexOf("\n\n");
  const block = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
  return block.trim();
}

// ReDoS-safe: split-based parser. Bounded name + value lengths.
const NAME_RE = /^[a-zA-Z_]\w{0,99}$/;
function extractAssignments(block: string): string | null {
  const parts = block.split(/[,\n)]/);
  const assignments: string[] = [];
  for (const rawPart of parts) {
    if (assignments.length >= 50) break; // bound output
    const part = rawPart.slice(0, 500); // bound input
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (NAME_RE.test(name) && value.length > 0 && value.length <= 400) {
      assignments.push(`${name}=${value}`);
    }
  }
  return assignments.length > 0 ? assignments.join(", ") : null;
}

// ─── Parser: fast-check (TypeScript) ─────────────────────────────────────────

// ReDoS-safe: bounded digit + whitespace; FC counterexample uses indexOf, not regex
const FC_TESTS_RE = /after\s{1,10}(\d{1,9})\s{1,10}tests?/i;
const TS_MODULE_NOT_FOUND_RE = /\b(Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/;

function extractFastCheckCounterexample(text: string): string | null {
  // indexOf-based instead of regex with alternation + lazy match (CodeQL js/redos safe)
  const idx = text.toLowerCase().indexOf("counterexample:");
  if (idx < 0) return null;
  const tail = text.slice(idx + "counterexample:".length);
  // Take only the rest of the current line (cap to 500 chars for safety)
  const newlineIdx = tail.indexOf("\n");
  const line = (newlineIdx >= 0 ? tail.slice(0, newlineIdx) : tail).slice(0, 500);
  const trimmed = line.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseFastCheckOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): RunPropertyResult {
  const raw_output = stdout + stderr;

  // Error path: module resolution failure
  if (TS_MODULE_NOT_FOUND_RE.test(raw_output)) {
    return makeResult({
      outcome: "error",
      raw_output,
      exit_code: exitCode,
      error_message: "Cannot find module — fast-check not installed in project",
    });
  }

  // Counterexample (indexOf-based extractor — ReDoS-safe)
  const counterexample = extractFastCheckCounterexample(raw_output);
  if (counterexample) {
    const testsMatch = FC_TESTS_RE.exec(raw_output);
    return makeResult({
      outcome: "falsified",
      counterexample,
      shrunk_input: counterexample,
      examples_tried: testsMatch ? parseInt(testsMatch[1], 10) : null,
      raw_output,
      exit_code: exitCode,
    });
  }

  if (exitCode === 0) {
    return makeResult({
      outcome: "passed",
      raw_output,
      exit_code: exitCode,
    });
  }

  return makeResult({
    outcome: "error",
    raw_output,
    exit_code: exitCode,
    error_message: `fast-check runner exited ${exitCode} without recognized output pattern`,
  });
}

function makeResult(overrides: Partial<RunPropertyResult>): RunPropertyResult {
  return {
    outcome: "error",
    counterexample: null,
    shrunk_input: null,
    examples_tried: null,
    raw_output: "",
    exit_code: -1,
    exec_ms: 0,
    error_message: null,
    ...overrides,
  };
}

// ─── suggestStrategies ───────────────────────────────────────────────────────

interface StrategyMapping {
  match: RegExp;
  python: string;
  typescript: string;
}

const STRATEGY_MAP: StrategyMapping[] = [
  // Most-specific first
  {
    match: /non-empty\s+string/i,
    python: "st.text(min_size=1)",
    typescript: "fc.string({ minLength: 1 })",
  },
  {
    match: /positive\s+integer/i,
    python: "st.integers(min_value=1)",
    typescript: "fc.integer({ min: 1 })",
  },
  {
    match: /negative\s+integer/i,
    python: "st.integers(max_value=-1)",
    typescript: "fc.integer({ max: -1 })",
  },
  {
    match: /non-negative\s+integer/i,
    python: "st.integers(min_value=0)",
    typescript: "fc.integer({ min: 0 })",
  },
  {
    match: /list\s+of\s+integers?/i,
    python: "st.lists(st.integers())",
    typescript: "fc.array(fc.integer())",
  },
  {
    match: /list\s+of\s+strings?|list\s+of\s+text/i,
    python: "st.lists(st.text())",
    typescript: "fc.array(fc.string())",
  },
  { match: /\binteger\b|\bint\b/i, python: "st.integers()", typescript: "fc.integer()" },
  { match: /\bstring\b|\btext\b/i, python: "st.text()", typescript: "fc.string()" },
  {
    match: /\bfloat\b|\bdouble\b|\bnumber\b/i,
    python: "st.floats(allow_nan=False, allow_infinity=False)",
    typescript: "fc.float({ noNaN: true })",
  },
  { match: /\bboolean\b|\bbool\b/i, python: "st.booleans()", typescript: "fc.boolean()" },
  {
    match: /\blist\b|\barray\b/i,
    python: "st.lists(st.integers())",
    typescript: "fc.array(fc.integer())",
  },
  {
    match: /\bdict\b|\bdictionary\b|\bmap\b|\bobject\b/i,
    python: "st.dictionaries(st.text(), st.integers())",
    typescript: "fc.dictionary(fc.string(), fc.integer())",
  },
];

const FALLBACK_PYTHON = "st.integers()  # fallback — caller should refine for actual input type";
const FALLBACK_TS = "fc.integer()  // fallback — caller should refine for actual input type";

export function suggestStrategies(
  language: SupportedLanguage,
  inputDescription: string,
): SuggestStrategiesResult {
  for (const mapping of STRATEGY_MAP) {
    if (mapping.match.test(inputDescription)) {
      return {
        strategies_code: language === "python" ? mapping.python : mapping.typescript,
        example_usage: exampleUsageFor(language, language === "python" ? mapping.python : mapping.typescript),
      };
    }
  }
  const fallback = language === "python" ? FALLBACK_PYTHON : FALLBACK_TS;
  return {
    strategies_code: fallback,
    example_usage: exampleUsageFor(language, fallback),
  };
}

function exampleUsageFor(language: SupportedLanguage, strategies: string): string {
  if (language === "python") {
    return `from hypothesis import given, strategies as st\n\n@given(${strategies})\ndef test_property(x):\n    # invariant / inverse / idempotence assertion\n    assert ...`;
  }
  return `import * as fc from 'fast-check';\n\nfc.assert(\n  fc.property(${strategies}, (x) => {\n    // invariant / inverse / idempotence assertion\n  })\n);`;
}

// ─── recordPropertyRun ───────────────────────────────────────────────────────

const VALID_ARCHETYPES: PropertyArchetype[] = ["invariant", "inverse", "idempotence"];

export async function recordPropertyRun(
  propertyName: string,
  archetype: PropertyArchetype,
  runResult: RunPropertyResult,
  options?: { rootDir?: string; codeUnderTestRef?: string },
): Promise<RecordPropertyRunResult> {
  if (!propertyName || typeof propertyName !== "string") {
    throw new Error("recordPropertyRun requires a non-empty property_name");
  }
  if (!VALID_ARCHETYPES.includes(archetype as PropertyArchetype)) {
    throw new Error(
      `Invalid archetype "${archetype}" — must be one of: ${VALID_ARCHETYPES.join(", ")}`,
    );
  }

  const rootDir = options?.rootDir ?? process.cwd();
  const dir = path.join(rootDir, ".agent", "pbt");
  const file = path.join(dir, "runs.jsonl");

  await fs.mkdir(dir, { recursive: true });

  const run_id = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const entry = {
    run_id,
    property_name: propertyName,
    archetype,
    outcome: runResult.outcome,
    counterexample: runResult.counterexample,
    shrunk_input: runResult.shrunk_input,
    examples_tried: runResult.examples_tried,
    exit_code: runResult.exit_code,
    exec_ms: runResult.exec_ms,
    error_message: runResult.error_message,
    code_under_test_ref: options?.codeUnderTestRef ?? null,
    recorded_at: new Date().toISOString(),
  };

  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");

  return { recorded: true, run_id };
}

// ─── runProperty (integration — spawns hypothesis/fast-check) ────────────────

export interface RunPropertyArgs {
  language: SupportedLanguage;
  archetype: PropertyArchetype;
  strategies_code: string;
  property_code: string;
  param_names?: string[];
  max_examples?: number;
  timeout_ms?: number;
  module_path?: string;
  import_alias?: string;
  cwd?: string;
}

export async function runProperty(args: RunPropertyArgs): Promise<RunPropertyResult> {
  if (!VALID_ARCHETYPES.includes(args.archetype as PropertyArchetype)) {
    throw new Error(
      `Invalid archetype "${args.archetype}" — must be one of: ${VALID_ARCHETYPES.join(", ")}`,
    );
  }
  if (args.language !== "python" && args.language !== "typescript") {
    throw new Error(`Invalid language "${args.language}" — must be 'python' or 'typescript'`);
  }

  const maxExamples = args.max_examples ?? 100;
  const timeoutMs = args.timeout_ms ?? 30000;
  const paramNames = args.param_names ?? ["x"];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pbt-runner-"));
  const startMs = Date.now();
  try {
    const scriptPath = path.join(tmpDir, args.language === "python" ? "prop.py" : "prop.mjs");
    const scriptBody = args.language === "python"
      ? buildPythonScript(args, maxExamples, paramNames)
      : buildTypeScriptScript(args, maxExamples, paramNames);
    await fs.writeFile(scriptPath, scriptBody, "utf-8");

    const command = args.language === "python" ? "python3" : "node";
    const result = await spawnWithTimeout(command, [scriptPath], {
      cwd: args.cwd,
      timeoutMs,
    });

    const parsed = args.language === "python"
      ? parseHypothesisOutput(result.stdout, result.stderr, result.exitCode)
      : parseFastCheckOutput(result.stdout, result.stderr, result.exitCode);

    if (result.timedOut) {
      return {
        ...parsed,
        outcome: "timeout",
        error_message: `Killed after ${timeoutMs}ms`,
        exec_ms: Date.now() - startMs,
      };
    }
    return { ...parsed, exec_ms: Date.now() - startMs };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildPythonScript(
  args: RunPropertyArgs,
  maxExamples: number,
  paramNames: string[],
): string {
  const moduleImport = args.module_path && args.import_alias
    ? `import sys\nsys.path.insert(0, ${JSON.stringify(path.dirname(args.module_path))})\nimport ${args.import_alias}\n`
    : "";
  return `${moduleImport}from hypothesis import given, strategies as st, settings

@given(${args.strategies_code})
@settings(max_examples=${maxExamples}, deadline=None, derandomize=False)
def _test_property(${paramNames.join(", ")}):
    ${args.property_code}

_test_property()
print(f"Hypothesis: {${maxExamples}} examples passed.")
`;
}

function buildTypeScriptScript(
  args: RunPropertyArgs,
  maxExamples: number,
  paramNames: string[],
): string {
  const moduleImport = args.module_path && args.import_alias
    ? `import ${args.import_alias} from ${JSON.stringify(args.module_path)};\n`
    : "";
  const destructured = paramNames.length === 1 ? paramNames[0] : `(${paramNames.join(", ")})`;
  return `import * as fc from 'fast-check';
${moduleImport}
fc.assert(
  fc.property(${args.strategies_code}, (${destructured}) => {
    ${args.property_code}
  }),
  { numRuns: ${maxExamples} }
);
console.log("fast-check: ${maxExamples} tests passed.");
`;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function spawnWithTimeout(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        exitCode: -1,
        timedOut: false,
      });
    });
  });
}

// ─── MCP server: tool definitions ────────────────────────────────────────────

const RUN_PROPERTY_TOOL: Tool = {
  name: "run_property",
  description:
    "Spawn hypothesis (Python) or fast-check (TypeScript) with caller-supplied strategies + property check. Returns structured {outcome, counterexample, shrunk_input, examples_tried, raw_output, exec_ms}. Requires hypothesis or fast-check installed in the host env. Three archetypes: invariant (output property holds for all inputs), inverse (f(g(x)) == x), idempotence (f(f(x)) == f(x)).",
  inputSchema: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["python", "typescript"] },
      archetype: { type: "string", enum: ["invariant", "inverse", "idempotence"] },
      strategies_code: {
        type: "string",
        description: "Comma-separated strategies (e.g. 'st.integers(), st.text()' for Python, 'fc.integer(), fc.string()' for TS).",
      },
      property_code: {
        type: "string",
        description: "The property assertion body. Receives parameters named per param_names.",
      },
      param_names: {
        type: "array",
        items: { type: "string" },
        description: "Parameter names matching strategies positionally. Default: ['x'].",
      },
      max_examples: { type: "number", description: "Number of examples to try. Default 100." },
      timeout_ms: { type: "number", description: "Process timeout. Default 30000." },
      module_path: { type: "string", description: "Optional absolute path to user module to import." },
      import_alias: { type: "string", description: "Required if module_path: alias to import as." },
      cwd: { type: "string", description: "Optional working directory for the spawned process." },
    },
    required: ["language", "archetype", "strategies_code", "property_code"],
  },
};

const SUGGEST_STRATEGIES_TOOL: Tool = {
  name: "suggest_strategies",
  description:
    "Maps a natural-language input description (e.g. 'positive integer', 'non-empty string', 'list of integers') to hypothesis (Python) or fast-check (TypeScript) strategy code. Helper for agents to bootstrap PBT quickly without memorizing the strategy API. Returns {strategies_code, example_usage}.",
  inputSchema: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["python", "typescript"] },
      input_description: {
        type: "string",
        description: "Natural-language description of the input type (e.g. 'list of strings').",
      },
    },
    required: ["language", "input_description"],
  },
};

const RECORD_PROPERTY_RUN_TOOL: Tool = {
  name: "record_property_run",
  description:
    "Append a property run result to .agent/pbt/runs.jsonl for durable audit/history. Returns generated run_id. Used for tracking regressions, comparing runs across time, and providing the verifier with proof that a property was checked.",
  inputSchema: {
    type: "object",
    properties: {
      property_name: { type: "string" },
      archetype: { type: "string", enum: ["invariant", "inverse", "idempotence"] },
      run_result: {
        type: "object",
        description: "The RunPropertyResult object returned by run_property.",
      },
      code_under_test_ref: {
        type: "string",
        description: "Optional file path / git SHA / artifact ID identifying what was tested.",
      },
      root_dir: { type: "string" },
    },
    required: ["property_name", "archetype", "run_result"],
  },
};

// ─── MCP server: handler ─────────────────────────────────────────────────────

export function createPbtRunnerServer(): Server {
  const server = new Server(
    { name: "pbt-runner-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [RUN_PROPERTY_TOOL, SUGGEST_STRATEGIES_TOOL, RECORD_PROPERTY_RUN_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "run_property") {
      const result = await runProperty({
        language: a.language as SupportedLanguage,
        archetype: a.archetype as PropertyArchetype,
        strategies_code: String(a.strategies_code),
        property_code: String(a.property_code),
        param_names: Array.isArray(a.param_names) ? (a.param_names as string[]) : undefined,
        max_examples: typeof a.max_examples === "number" ? a.max_examples : undefined,
        timeout_ms: typeof a.timeout_ms === "number" ? a.timeout_ms : undefined,
        module_path: typeof a.module_path === "string" ? a.module_path : undefined,
        import_alias: typeof a.import_alias === "string" ? a.import_alias : undefined,
        cwd: typeof a.cwd === "string" ? a.cwd : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "suggest_strategies") {
      const result = suggestStrategies(
        a.language as SupportedLanguage,
        String(a.input_description),
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "record_property_run") {
      const result = await recordPropertyRun(
        String(a.property_name),
        a.archetype as PropertyArchetype,
        a.run_result as RunPropertyResult,
        {
          rootDir: typeof a.root_dir === "string" ? a.root_dir : undefined,
          codeUnderTestRef:
            typeof a.code_under_test_ref === "string" ? a.code_under_test_ref : undefined,
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

// ─── Main entry: run stdio server when invoked directly ──────────────────────

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:${process.argv[1]}`;

if (isMain) {
  const server = createPbtRunnerServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "pbt-runner-mcp v0.1.0 stdio ready (tools: run_property, suggest_strategies, record_property_run)",
  );
}
