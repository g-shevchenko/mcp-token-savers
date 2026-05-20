#!/usr/bin/env node
// test-results-mcp v0.1.0
//
// JSON-ledger MCP for durable test/feature pass-fail contracts between AI agents.
// Implements the structured feature_list.json pattern with immutability lock:
// each acceptance criterion is {passes:false} until verified end-to-end, and
// only a verifier role may flip it true.
//
// This file is BOTH:
//   - A library exporting `initFeatureList` for direct import (tests, smoke)
//   - An MCP stdio server when run as main (`node dist/index.js`)

import { promises as fs } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCHEMA_VERSION = 1;

// ── Core library function ────────────────────────────────────────────────────

export async function initFeatureList(
  taskId: string,
  features: FeatureInput[],
  rootDir: string = process.cwd()
): Promise<FeatureList> {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(
      `Invalid task_id "${taskId}" — must be kebab-case (lowercase alphanumeric + hyphens, no slashes/dots/spaces)`
    );
  }

  if (!features || features.length === 0) {
    throw new Error(
      "initFeatureList requires at least one feature in the features array"
    );
  }

  const dir = path.join(rootDir, ".agent", "tasks", taskId);
  const file = path.join(dir, "feature_list.json");

  const exists = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(
      `feature_list.json already exists for task "${taskId}" at ${file} — remove it or use a new task_id (immutability lock)`
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
  await fs.writeFile(file, JSON.stringify(list, null, 2) + "\n", "utf-8");

  return list;
}

// ── MCP server registration ─────────────────────────────────────────────────

const INIT_FEATURE_LIST_TOOL: Tool = {
  name: "init_feature_list",
  description:
    "Create an immutable JSON ledger of acceptance criteria for a task. Each feature starts at {passes: false} and may only be flipped to true after end-to-end verification (via the mark_pass tool, planned in a future version). Throws if a ledger already exists for the given task_id (immutability lock).",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description:
          "Kebab-case task identifier (e.g. 'feature-add-login'). Used to compute the storage path under .agent/tasks/<task_id>/feature_list.json.",
      },
      features: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Feature identifier (e.g. 'AC1')" },
            description: {
              type: "string",
              description: "Acceptance criterion text",
            },
            evidence_required: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of evidence types required (e.g. 'test passes', 'screenshot diff < 1%')",
            },
          },
          required: ["id", "description"],
        },
      },
      root_dir: {
        type: "string",
        description:
          "Optional root directory for the .agent/tasks/ hierarchy. Defaults to process.cwd().",
      },
    },
    required: ["task_id", "features"],
  },
};

export function createTestResultsServer(): Server {
  const server = new Server(
    { name: "test-results-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [INIT_FEATURE_LIST_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "init_feature_list") {
      const a = (args ?? {}) as {
        task_id?: string;
        features?: FeatureInput[];
        root_dir?: string;
      };
      if (!a.task_id || !Array.isArray(a.features)) {
        throw new Error("init_feature_list requires task_id and features[]");
      }
      const list = await initFeatureList(a.task_id, a.features, a.root_dir);
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

// ── Main entry: run stdio server when invoked directly ──────────────────────

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:${process.argv[1]}`;

if (isMain) {
  const server = createTestResultsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("test-results-mcp v0.1.0 stdio ready");
}
