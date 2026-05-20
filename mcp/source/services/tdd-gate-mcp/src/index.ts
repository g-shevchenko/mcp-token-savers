#!/usr/bin/env node
// services/tdd-gate-mcp/src/index.ts
//
// Granular TDD discipline checks exposed as MCP tools. Complementary to the
// existing .claude/hooks/tdd-edit-guard.sh PreToolUse hook:
//   - The hook is a fast deterministic gate (PreToolUse exit-code-2).
//   - This MCP exposes rich introspection that agents can call programmatically.
//
// 4 tools:
//   - checkEditAllowed(file_path, root_dir?) → structured {allowed, reason, suggestion}
//   - checkTestImmutability(file_path, old_content, new_content) → {allowed, violations[]}
//   - verifyRedStatus(test_command, expected_failure_pattern?, timeout_ms?)
//       → classifies output: assertion / import_error / syntax_error / passed / other
//   - registerTestToImplLink(test_file, impl_glob, root_dir?) → durable JSON registry
//
// TDD discipline: tests at ../tests/index.test.ts cover every public function.

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EditCheckResult {
  allowed: boolean;
  reason: string;
  suggestion?: string;
}

export interface ImmutabilityViolation {
  type:
    | "removed_assertion"
    | "skip_marker_added"
    | "comparison_weakened"
    | "tolerance_increased";
  line: number;
  snippet: string;
}

export interface ImmutabilityCheckResult {
  allowed: boolean;
  violations: ImmutabilityViolation[];
}

export type VerifyRedErrorType =
  | "assertion"
  | "import_error"
  | "syntax_error"
  | "passed"
  | "other";

export interface VerifyRedResult {
  is_red: boolean;
  error_type: VerifyRedErrorType;
  message: string;
  expected_pattern_matched: boolean | null;
  raw_output: string;
  exit_code: number;
}

export interface TestImplLink {
  test_file: string;
  impl_glob: string;
  created_at: string;
}

export interface RegisterLinkResult {
  registered: boolean;
  existing?: TestImplLink;
}

// ─── Tool 1: checkEditAllowed ────────────────────────────────────────────────

const CODE_EXT_RE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|php)$/i;
const NON_CODE_EXT_RE =
  /\.(md|markdown|txt|rst|json|yaml|yml|toml|ini|env|html|css|scss|svg|png|jpg|jpeg|gif|webp|lock|lockb)$|\.env\./i;
const BYPASS_PATH_PATTERNS = [
  "/__pycache__/",
  "/node_modules/",
  "/target/",
  "/dist/",
  "/build/",
  "/.next/",
  "/__init__.py",
  "/migrations/",
  "/alembic/versions/",
  "/generated/",
  "/auto-generated/",
];

const TEST_NAME_PATTERNS = (stem: string, ext: string) => [
  `test_${stem}.py`,
  `${stem}_test.py`,
  `${stem}.test.${ext}`,
  `${stem}.test.ts`,
  `${stem}.test.tsx`,
  `${stem}.test.js`,
  `${stem}.test.jsx`,
  `${stem}.test.mjs`,
  `${stem}.spec.${ext}`,
  `${stem}.spec.ts`,
  `${stem}.spec.js`,
  `${stem}_test.go`,
  `${stem}_test.rs`,
];

export async function checkEditAllowed(
  filePath: string,
  options?: { rootDir?: string },
): Promise<EditCheckResult> {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(options?.rootDir ?? process.cwd(), filePath);

  // Not in src/** path — bypass
  if (!/(^|\/)src\//.test(abs) && !/\/services\/[^/]+\/src\//.test(abs)) {
    return { allowed: true, reason: "not in src/** path" };
  }

  // Extension bypass (non-code)
  if (NON_CODE_EXT_RE.test(abs)) {
    return { allowed: true, reason: "non-code extension bypass" };
  }

  // Excluded path bypass (generated, migrations, etc.)
  for (const pat of BYPASS_PATH_PATTERNS) {
    if (abs.includes(pat)) {
      return {
        allowed: true,
        reason: `excluded path (${pat.replace(/\//g, "").trim()})`,
      };
    }
  }

  // Only enforce on code extensions
  if (!CODE_EXT_RE.test(abs)) {
    return { allowed: true, reason: "non-code extension" };
  }

  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const stem = base.replace(/\.[^.]+$/, "");
  const ext = (base.split(".").pop() ?? "").toLowerCase();

  // Walk up to 2 levels for tests/ dir (stay within package boundary)
  let testsDirExists = false;
  let matchingTest: string | null = null;
  let searchRoot = dir;

  outer: for (let i = 0; i < 2; i++) {
    for (const candName of ["tests", "test", "__tests__"]) {
      const candDir = path.join(searchRoot, candName);
      try {
        const stat = await fs.stat(candDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      testsDirExists = true;
      const patterns = TEST_NAME_PATTERNS(stem, ext);
      // Recursive find for matching test file
      const found = await findMatchingTest(candDir, patterns);
      if (found) {
        matchingTest = found;
        break outer;
      }
    }
    searchRoot = path.dirname(searchRoot);
  }

  if (matchingTest) {
    return {
      allowed: true,
      reason: `test found: ${path.relative(options?.rootDir ?? process.cwd(), matchingTest)}`,
    };
  }

  if (!testsDirExists) {
    return {
      allowed: true,
      reason: "legacy bypass: no tests/ dir in package (cannot enforce retroactively)",
    };
  }

  return {
    allowed: false,
    reason: `no matching test for stem "${stem}" — tests/ dir exists but expected test file not found`,
    suggestion: `tests/test_${stem}.py, tests/${stem}.test.${ext}, or tests/${stem}_test.go`,
  };
}

async function findMatchingTest(
  dir: string,
  patterns: string[],
): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && patterns.includes(entry.name)) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = await findMatchingTest(full, patterns);
      if (nested) return nested;
    }
  }
  return null;
}

// ─── Tool 2: checkTestImmutability ───────────────────────────────────────────

const ASSERTION_PATTERN_RE =
  /(\bexpect\s*\(|\bassert\s+|\bassert\w*\s*\(|\bshould\b|\.toBe\b|\.toEqual\b|\.toMatch\b)/;
const SKIP_PATTERN_RE =
  /(\.skip\s*\(|\bxfail\b|@pytest\.mark\.skip|test\.skip\(|it\.skip\(|test\.todo\(|fdescribe\b|fit\b)/;

export async function checkTestImmutability(
  _filePath: string,
  oldContent: string,
  newContent: string,
): Promise<ImmutabilityCheckResult> {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const newLineSet = new Set(newLines.map((l) => l.trim()));
  const oldLineSet = new Set(oldLines.map((l) => l.trim()));

  const violations: ImmutabilityViolation[] = [];

  // Removed assertions: lines in old that contain assertion pattern AND not in new
  oldLines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (ASSERTION_PATTERN_RE.test(line) && !newLineSet.has(trimmed)) {
      violations.push({
        type: "removed_assertion",
        line: idx + 1,
        snippet: trimmed,
      });
    }
  });

  // Skip markers added: lines in new with skip pattern AND not in old
  newLines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (SKIP_PATTERN_RE.test(line) && !oldLineSet.has(trimmed)) {
      violations.push({
        type: "skip_marker_added",
        line: idx + 1,
        snippet: trimmed,
      });
    }
  });

  return { allowed: violations.length === 0, violations };
}

// ─── Tool 3: verifyRedStatus ─────────────────────────────────────────────────

const IMPORT_ERROR_RE =
  /\b(ImportError|ModuleNotFoundError|Cannot find module|ERR_MODULE_NOT_FOUND|module not found)\b/i;
const SYNTAX_ERROR_RE = /\bSyntaxError\b/;
const ASSERTION_FAILURE_RE =
  /\b(AssertionError|AssertionFailedError|expect\s*\(|Expected\s+:|FAIL(ED)?\b|--- FAIL:|thread '.*?' panicked)/;

export async function verifyRedStatus(
  testCommand: string,
  options?: {
    expectedFailurePattern?: string;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<VerifyRedResult> {
  const timeoutMs = options?.timeoutMs ?? 30000;

  return new Promise((resolve) => {
    const child = spawn(testCommand, [], {
      shell: true,
      cwd: options?.cwd,
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
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const exit_code = code ?? -1;
      const raw_output = stdout + stderr;

      if (timedOut) {
        resolve({
          is_red: false,
          error_type: "other",
          message: `Process killed (timeout after ${timeoutMs}ms)`,
          expected_pattern_matched: null,
          raw_output,
          exit_code,
        });
        return;
      }

      // exit 0 → test passed (BAD for TDD)
      if (exit_code === 0) {
        resolve({
          is_red: false,
          error_type: "passed",
          message: "Test passed — invalid for TDD verify-red (test should fail before impl)",
          expected_pattern_matched: null,
          raw_output,
          exit_code,
        });
        return;
      }

      // Classify failure type
      let error_type: VerifyRedErrorType = "other";
      if (IMPORT_ERROR_RE.test(raw_output)) {
        error_type = "import_error";
      } else if (SYNTAX_ERROR_RE.test(raw_output)) {
        error_type = "syntax_error";
      } else if (ASSERTION_FAILURE_RE.test(raw_output)) {
        error_type = "assertion";
      }

      const is_red = error_type === "assertion";

      let expected_pattern_matched: boolean | null = null;
      if (options?.expectedFailurePattern) {
        expected_pattern_matched = raw_output.includes(options.expectedFailurePattern);
      }

      const message =
        error_type === "assertion"
          ? "Test failed with assertion error (valid TDD red state)"
          : error_type === "import_error"
            ? "ImportError — test setup is broken; fix test, not implementation"
            : error_type === "syntax_error"
              ? "SyntaxError — test file is broken; fix syntax"
              : signal
                ? `Process terminated by signal ${signal}`
                : `Test failed with non-assertion error (exit ${exit_code})`;

      resolve({
        is_red,
        error_type,
        message,
        expected_pattern_matched,
        raw_output,
        exit_code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        is_red: false,
        error_type: "other",
        message: `spawn error: ${err.message}`,
        expected_pattern_matched: null,
        raw_output: stderr,
        exit_code: -1,
      });
    });
  });
}

// ─── Tool 4: registerTestToImplLink ──────────────────────────────────────────

interface LinksFile {
  schema_version: number;
  links: TestImplLink[];
}

const LINKS_SCHEMA_VERSION = 1;

export async function registerTestToImplLink(
  testFile: string,
  implGlob: string,
  options?: { rootDir?: string },
): Promise<RegisterLinkResult> {
  if (!testFile || typeof testFile !== "string") {
    throw new Error("registerTestToImplLink requires a non-empty testFile");
  }
  if (!implGlob || typeof implGlob !== "string") {
    throw new Error("registerTestToImplLink requires a non-empty implGlob");
  }

  const rootDir = options?.rootDir ?? process.cwd();
  const linksDir = path.join(rootDir, ".agent", "tdd-links");
  const linksFile = path.join(linksDir, "links.json");

  let data: LinksFile = { schema_version: LINKS_SCHEMA_VERSION, links: [] };
  try {
    const raw = await fs.readFile(linksFile, "utf-8");
    data = JSON.parse(raw) as LinksFile;
  } catch (err: any) {
    if (err && err.code !== "ENOENT") throw err;
  }

  const existing = data.links.find(
    (l) => l.test_file === testFile && l.impl_glob === implGlob,
  );
  if (existing) {
    return { registered: false, existing };
  }

  const newLink: TestImplLink = {
    test_file: testFile,
    impl_glob: implGlob,
    created_at: new Date().toISOString(),
  };
  data.links.push(newLink);

  await fs.mkdir(linksDir, { recursive: true });
  await fs.writeFile(linksFile, JSON.stringify(data, null, 2) + "\n", "utf-8");

  return { registered: true };
}

// ─── MCP server: tool definitions ────────────────────────────────────────────

const CHECK_EDIT_ALLOWED_TOOL: Tool = {
  name: "check_edit_allowed",
  description:
    "Replicates the tdd-edit-guard.sh PreToolUse hook logic at MCP-tool level: returns structured {allowed, reason, suggestion} for a proposed Edit/Write on file_path. Useful for agent self-check before attempting an edit that might be blocked by the hook. Mirrors the same legacy-bypass + 2-level walk-up + extension/path bypass list as the hook.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or relative path to the file." },
      root_dir: { type: "string", description: "Optional repo root (default: process.cwd())." },
    },
    required: ["file_path"],
  },
};

const CHECK_TEST_IMMUTABILITY_TOOL: Tool = {
  name: "check_test_immutability",
  description:
    "Detects test-immutability violations by diffing old vs new content of a test file. Flags removed assertions (expect/assert lines that disappeared) and added skip markers (.skip(), xfail, @pytest.mark.skip). Returns per-violation {type, line, snippet}.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Test file path (for reporting only)." },
      old_content: { type: "string", description: "File content before the proposed edit." },
      new_content: { type: "string", description: "File content after the proposed edit." },
    },
    required: ["file_path", "old_content", "new_content"],
  },
};

const VERIFY_RED_STATUS_TOOL: Tool = {
  name: "verify_red_status",
  description:
    "Runs a test command and classifies the output: assertion (valid TDD red), import_error / syntax_error (broken setup — fix tests), passed (invalid — test passes immediately), other. Returns {is_red, error_type, message, expected_pattern_matched, raw_output, exit_code}. Has a configurable timeout (default 30s).",
  inputSchema: {
    type: "object",
    properties: {
      test_command: {
        type: "string",
        description: "Shell command to run the failing test (e.g. 'npm test path/to/file.test.ts').",
      },
      expected_failure_pattern: {
        type: "string",
        description: "Optional substring expected in the failure output (e.g. 'Email required').",
      },
      cwd: { type: "string", description: "Optional working directory for the spawned command." },
      timeout_ms: {
        type: "number",
        description: "Optional timeout in milliseconds (default 30000).",
      },
    },
    required: ["test_command"],
  },
};

const REGISTER_TEST_TO_IMPL_LINK_TOOL: Tool = {
  name: "register_test_to_impl_link",
  description:
    "Records a durable test↔impl binding in .agent/tdd-links/links.json. Idempotent: a duplicate (test_file, impl_glob) pair returns the existing entry without creating a new one. Supports multiple impl_globs per test (one test covers multiple files). Used to establish traceability for audit / coverage gates.",
  inputSchema: {
    type: "object",
    properties: {
      test_file: { type: "string", description: "Test file path (relative to root_dir)." },
      impl_glob: { type: "string", description: "Source file or glob the test covers." },
      root_dir: { type: "string", description: "Optional repo root (default: process.cwd())." },
    },
    required: ["test_file", "impl_glob"],
  },
};

// ─── MCP server: handler ─────────────────────────────────────────────────────

export function createTddGateServer(): Server {
  const server = new Server(
    { name: "tdd-gate-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      CHECK_EDIT_ALLOWED_TOOL,
      CHECK_TEST_IMMUTABILITY_TOOL,
      VERIFY_RED_STATUS_TOOL,
      REGISTER_TEST_TO_IMPL_LINK_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "check_edit_allowed") {
      if (typeof a.file_path !== "string") {
        throw new Error("check_edit_allowed requires file_path (string)");
      }
      const result = await checkEditAllowed(a.file_path, {
        rootDir: typeof a.root_dir === "string" ? a.root_dir : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "check_test_immutability") {
      if (
        typeof a.file_path !== "string" ||
        typeof a.old_content !== "string" ||
        typeof a.new_content !== "string"
      ) {
        throw new Error(
          "check_test_immutability requires file_path, old_content, new_content (all strings)",
        );
      }
      const result = await checkTestImmutability(a.file_path, a.old_content, a.new_content);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "verify_red_status") {
      if (typeof a.test_command !== "string") {
        throw new Error("verify_red_status requires test_command (string)");
      }
      const result = await verifyRedStatus(a.test_command, {
        expectedFailurePattern:
          typeof a.expected_failure_pattern === "string" ? a.expected_failure_pattern : undefined,
        cwd: typeof a.cwd === "string" ? a.cwd : undefined,
        timeoutMs: typeof a.timeout_ms === "number" ? a.timeout_ms : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "register_test_to_impl_link") {
      if (typeof a.test_file !== "string" || typeof a.impl_glob !== "string") {
        throw new Error(
          "register_test_to_impl_link requires test_file (string) and impl_glob (string)",
        );
      }
      const result = await registerTestToImplLink(a.test_file, a.impl_glob, {
        rootDir: typeof a.root_dir === "string" ? a.root_dir : undefined,
      });
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
  const server = createTddGateServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "tdd-gate-mcp v0.1.0 stdio ready (tools: check_edit_allowed, check_test_immutability, verify_red_status, register_test_to_impl_link)",
  );
}
