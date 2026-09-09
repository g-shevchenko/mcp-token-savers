#!/usr/bin/env node
/**
 * mcp-token-router MCP server — measurement-driven compressor routing.
 *
 * Exposes one tool: `route_compression(text, budget_chars, task_type)`.
 *
 * The routing decision is deterministic (see src/router.ts); the actual
 * compression is delegated to one of the three measured primitives via
 * subprocess to the bundled Python runners in ./runners/.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { dispatchCompressor } from "./dispatch.js";
import { ROUTING_RULES, routeForBudget } from "./router.js";

const ROUTE_COMPRESSION_TOOL: Tool = {
  name: "route_compression",
  description:
    "Compress `text` using the measured-best compressor for the given budget. " +
    "Routes between hwai_v0_1 (HWAI fact-extraction prefix + sophon body), " +
    "contextprep (HWAI extractive method), and 'none' (inflation guard for short inputs). " +
    "Routing rules are deterministic and backed by the 2026-05-24 c2_bench measurement program: " +
    "tight budget (≤1000c) → hwai_v0_1_600c (67% quality, 94% saving); " +
    "medium budget (1000-2500c) → hwai_v0_1_2000c (87% quality, 92% saving, Pareto-best); " +
    "generous budget (≥2500c) → contextprep_7000c (93% quality, 60% saving). " +
    "task_type='extract' forces hwai (fact-extraction critical); " +
    "task_type='summarize' forces contextprep (extractive gist).",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "Raw input text to compress. Recommended ≥1000 chars; shorter inputs return as-is (inflation guard).",
      },
      budget_chars: {
        type: "integer",
        description:
          "Target output budget in characters. Defaults to 2000 (Pareto sweet-spot per measurements).",
        default: 2000,
        minimum: 100,
        maximum: 50000,
      },
      task_type: {
        type: "string",
        description:
          "Optional hint: 'extract' (find specific facts; routes to hwai), 'summarize' (gist; routes to contextprep), or 'general' (default; uses budget tier).",
        enum: ["extract", "summarize", "general"],
        default: "general",
      },
    },
    required: ["text"],
  },
};

const LIST_ROUTES_TOOL: Tool = {
  name: "list_routes",
  description:
    "Return the measurement-backed routing-rule table for auditing. " +
    "Useful for callers that want to inspect the Pareto frontier before invoking route_compression.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const server = new Server(
  { name: "mcp-token-router", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [ROUTE_COMPRESSION_TOOL, LIST_ROUTES_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "route_compression") {
    const text = String(args?.text ?? "");
    const budgetChars =
      typeof args?.budget_chars === "number"
        ? (args.budget_chars as number)
        : undefined;
    const taskType =
      typeof args?.task_type === "string" ? (args.task_type as string) : undefined;

    const decision = routeForBudget({
      inputChars: text.length,
      budgetChars,
      taskType,
    });

    const compressionResult = await dispatchCompressor(decision.compressor, text);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              schema_version: "0.1",
              decision: {
                compressor: decision.compressor,
                reason: decision.reason,
                budget_used_chars: decision.budgetUsed,
              },
              result: {
                compressed: compressionResult.compressed,
                input_chars: compressionResult.inputChars,
                output_chars: compressionResult.outputChars,
                saving_pct: compressionResult.savingPct,
                latency_ms: compressionResult.latencyMs,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "list_routes") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              schema_version: "0.1",
              source_basis:
                "2026-05-24 c2_bench measurements (15 fixtures × 15-pair QA corpus)",
              rules: ROUTING_RULES,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
