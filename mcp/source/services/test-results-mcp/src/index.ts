#!/usr/bin/env node
// services/test-results-mcp/src/index.ts
//
// JSON-ledger MCP for durable test/feature pass-fail contracts between AI agents.
// Implements the Anthropic Labs feature_list.json canonical pattern with:
//   - immutability lock (init refuses to overwrite)
//   - flip-on-evidence semantic (markPass requires evidenceRef + clears prior error)
//   - compact failing-list for fixer handoff (listFailing)
//   - single-feature drill-down for fixer (getFeature)
//
// File is BOTH:
//   - a library (initFeatureList/markPass/listFailing/getFeature exports for tests + direct callers)
//   - an MCP stdio server when invoked as main (`node dist/index.js`)
//
// TDD discipline: tests at ../tests/index.test.ts cover every public function.
// Per `.claude/rules/tdd-verify-red.md`, see file-order in git commit history
// for the verify-red sequence (tests added first).

import { promises as fs } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Feature {
  id: string;
  description: string;
  evidence_required?: string[];
  passes: boolean;
  passed_at: string | null;
  evidence_ref: string | null;
  last_attempt_error: string | null;
}

export interface FeatureList {
  task_id: string;
  created_at: string;
  schema_version: number;
  features: Feature[];
}

export interface FeatureInput {
  id: string;
  description: string;
  evidence_required?: string[];
}

export interface FailingFeature {
  id: string;
  description: string;
  last_attempt_error: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCHEMA_VERSION = 1;

// ─── Internal helpers ────────────────────────────────────────────────────────

function featureListPath(taskId: string, rootDir: string): string {
  return path.join(rootDir, ".agent", "tasks", taskId, "feature_list.json");
}

function validateTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(
      `Invalid task_id "${taskId}" — must be kebab-case (lowercase alphanumeric + hyphens, no slashes/dots/spaces)`,
    );
  }
}

async function loadFeatureList(
  taskId: string,
  rootDir: string,
): Promise<FeatureList> {
  validateTaskId(taskId);
  const file = featureListPath(taskId, rootDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        `feature_list.json not found for task "${taskId}" at ${file} — run init_feature_list first`,
      );
    }
    throw err;
  }
  return JSON.parse(raw) as FeatureList;
}

async function saveFeatureList(
  taskId: string,
  rootDir: string,
  list: FeatureList,
): Promise<void> {
  const file = featureListPath(taskId, rootDir);
  await fs.writeFile(file, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

// ─── Public tool: initFeatureList ────────────────────────────────────────────

export async function initFeatureList(
  taskId: string,
  features: FeatureInput[],
  rootDir: string = process.cwd(),
): Promise<FeatureList> {
  validateTaskId(taskId);

  if (!features || features.length === 0) {
    throw new Error(
      "initFeatureList requires at least one feature in the features array",
    );
  }

  const dir = path.join(rootDir, ".agent", "tasks", taskId);
  const file = featureListPath(taskId, rootDir);

  const exists = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(
      `feature_list.json already exists for task "${taskId}" at ${file} — remove it or use a new task_id (immutability lock per Anthropic Labs canonical pattern)`,
    );
  }

  const list: FeatureList = {
    task_id: taskId,
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    features: features.map((f) => {
      const feat: Feature = {
        id: f.id,
        description: f.description,
        passes: false,
        passed_at: null,
        evidence_ref: null,
        last_attempt_error: null,
      };
      if (f.evidence_required !== undefined) {
        feat.evidence_required = f.evidence_required;
      }
      return feat;
    }),
  };

  await fs.mkdir(dir, { recursive: true });
  await saveFeatureList(taskId, rootDir, list);

  return list;
}

// ─── Public tool: markPass ───────────────────────────────────────────────────

export async function markPass(
  taskId: string,
  featureId: string,
  evidenceRef: string,
  rootDir: string = process.cwd(),
): Promise<FeatureList> {
  if (!featureId || typeof featureId !== "string") {
    throw new Error("markPass requires a non-empty featureId");
  }
  if (!evidenceRef || typeof evidenceRef !== "string") {
    throw new Error(
      "markPass requires a non-empty evidenceRef (cite proof URL, file path, or artifact ID)",
    );
  }

  const list = await loadFeatureList(taskId, rootDir);
  const feature = list.features.find((f) => f.id === featureId);
  if (!feature) {
    throw new Error(
      `Feature "${featureId}" not found in task "${taskId}" — check init_feature_list ids`,
    );
  }
  if (feature.passes) {
    throw new Error(
      `Feature "${featureId}" is already marked pass (re-marking is a caller bug — the ledger value is durable, only one pass per feature per ledger; create a new task_id for a fresh run)`,
    );
  }

  feature.passes = true;
  feature.passed_at = new Date().toISOString();
  feature.evidence_ref = evidenceRef;
  feature.last_attempt_error = null;

  await saveFeatureList(taskId, rootDir, list);
  return list;
}

// ─── Public tool: listFailing ────────────────────────────────────────────────

export async function listFailing(
  taskId: string,
  rootDir: string = process.cwd(),
): Promise<FailingFeature[]> {
  const list = await loadFeatureList(taskId, rootDir);
  return list.features
    .filter((f) => !f.passes)
    .map((f) => ({
      id: f.id,
      description: f.description,
      last_attempt_error: f.last_attempt_error,
    }));
}

// ─── Public tool: getFeature ─────────────────────────────────────────────────

export async function getFeature(
  taskId: string,
  featureId: string,
  rootDir: string = process.cwd(),
): Promise<Feature> {
  if (!featureId || typeof featureId !== "string") {
    throw new Error("getFeature requires a non-empty featureId");
  }
  const list = await loadFeatureList(taskId, rootDir);
  const feature = list.features.find((f) => f.id === featureId);
  if (!feature) {
    throw new Error(
      `Feature "${featureId}" not found in task "${taskId}" — check init_feature_list ids`,
    );
  }
  return feature;
}

// ─── MCP server: tool definitions ────────────────────────────────────────────

const INIT_FEATURE_LIST_TOOL: Tool = {
  name: "init_feature_list",
  description:
    "Create an immutable JSON ledger of acceptance criteria for a task. Each feature starts at {passes: false} and may only be flipped to true via mark_pass with cited evidence. Throws if a ledger already exists for the given task_id (immutability lock).",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "Kebab-case task identifier (e.g. 'feature-add-login').",
      },
      features: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            evidence_required: { type: "array", items: { type: "string" } },
          },
          required: ["id", "description"],
        },
      },
      root_dir: { type: "string" },
    },
    required: ["task_id", "features"],
  },
};

const MARK_PASS_TOOL: Tool = {
  name: "mark_pass",
  description:
    "Flip a feature's passes from false to true with cited evidence. Only the verifier role should call this. Throws if the feature is already passes:true (re-marking is a caller bug). Clears any prior last_attempt_error on success.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      feature_id: { type: "string" },
      evidence_ref: {
        type: "string",
        description: "URL, file path, or artifact ID citing the proof.",
      },
      root_dir: { type: "string" },
    },
    required: ["task_id", "feature_id", "evidence_ref"],
  },
};

const LIST_FAILING_TOOL: Tool = {
  name: "list_failing",
  description:
    "Return the compact list of failing features for a task: only {id, description, last_attempt_error} per feature. Designed for the fixer role to know what still needs work without re-reading the full ledger.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      root_dir: { type: "string" },
    },
    required: ["task_id"],
  },
};

const GET_FEATURE_TOOL: Tool = {
  name: "get_feature",
  description:
    "Fetch a single feature by ID with all fields. Designed for the fixer role to drill into a specific failure without loading the whole ledger.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      feature_id: { type: "string" },
      root_dir: { type: "string" },
    },
    required: ["task_id", "feature_id"],
  },
};

// ─── MCP server: handler ─────────────────────────────────────────────────────

export function createTestResultsServer(): Server {
  const server = new Server(
    { name: "test-results-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      INIT_FEATURE_LIST_TOOL,
      MARK_PASS_TOOL,
      LIST_FAILING_TOOL,
      GET_FEATURE_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "init_feature_list") {
      if (typeof a.task_id !== "string" || !Array.isArray(a.features)) {
        throw new Error("init_feature_list requires task_id (string) and features (array)");
      }
      const list = await initFeatureList(
        a.task_id,
        a.features as FeatureInput[],
        typeof a.root_dir === "string" ? a.root_dir : undefined,
      );
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }

    if (name === "mark_pass") {
      if (
        typeof a.task_id !== "string" ||
        typeof a.feature_id !== "string" ||
        typeof a.evidence_ref !== "string"
      ) {
        throw new Error(
          "mark_pass requires task_id (string), feature_id (string), evidence_ref (string)",
        );
      }
      const list = await markPass(
        a.task_id,
        a.feature_id,
        a.evidence_ref,
        typeof a.root_dir === "string" ? a.root_dir : undefined,
      );
      return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
    }

    if (name === "list_failing") {
      if (typeof a.task_id !== "string") {
        throw new Error("list_failing requires task_id (string)");
      }
      const failing = await listFailing(
        a.task_id,
        typeof a.root_dir === "string" ? a.root_dir : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(failing, null, 2) }],
      };
    }

    if (name === "get_feature") {
      if (typeof a.task_id !== "string" || typeof a.feature_id !== "string") {
        throw new Error("get_feature requires task_id (string) and feature_id (string)");
      }
      const feature = await getFeature(
        a.task_id,
        a.feature_id,
        typeof a.root_dir === "string" ? a.root_dir : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(feature, null, 2) }],
      };
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
  const server = createTestResultsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("test-results-mcp v0.2.0 stdio ready (tools: init_feature_list, mark_pass, list_failing, get_feature)");
}
