#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { HandoffInput, renderHandoff } from "./handoff.js";
import { ContextSignal, preScoreContext } from "./scoring.js";
import { ContextEvent, getStats, latestEvents, recordEvent } from "./store.js";

const METADATA_SCHEMA = {
  type: "object",
  description:
    "Optional attribution metadata. Recommended: source, task_id, surface, repo, branch. Do not include raw prompts, code, secrets, or long notes.",
  properties: {
    source: { type: "string" },
    task_id: { type: "string" },
    surface: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
  },
};

const TOOLS: Tool[] = [
  {
    name: "ctx_pre_score",
    description:
      "Pre-score context pressure before autocompaction or cross-agent handoff. Deterministic gate: continue, prepare_handoff, or handoff_required.",
    inputSchema: {
      type: "object",
      properties: {
        elapsed_minutes: { type: "number" },
        turn_count: { type: "number" },
        context_window_tokens: { type: "number" },
        estimated_context_tokens: { type: "number" },
        largest_tool_result_chars: { type: "number" },
        large_tool_result_count: { type: "number" },
        milestone: { type: "string", enum: ["plan", "execute", "verify", "ship", "approval", "resume"] },
        cross_agent_target: { type: "string", enum: ["claude-code", "codex", "cursor", "windsurf", "other"] },
        has_long_noisy_input: { type: "boolean" },
        raw_paste_chars: { type: "number" },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "ctx_record_event",
    description:
      "Record a compact metadata-only session event for cross-agent resume. Store paths and summaries, not raw logs, prompts, source bodies, or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        surface: { type: "string", enum: ["claude-code", "codex", "cursor", "windsurf", "automation", "other"] },
        event_type: { type: "string", enum: ["tool_result", "decision", "handoff", "approval", "error", "milestone"] },
        summary: { type: "string" },
        artifact_paths: { type: "array", items: { type: "string" } },
        token_estimate: { type: "number" },
        trust_label: { type: "string", enum: ["trusted", "semi_trusted", "untrusted"] },
        metadata: METADATA_SCHEMA,
      },
      required: ["session_id", "surface", "event_type", "summary"],
    },
  },
  {
    name: "ctx_write_handoff",
    description:
      "Render a canonical operational compaction handoff template. This is a handoff contract, not conversational summarization.",
    inputSchema: {
      type: "object",
      properties: {
        current_objective: { type: "string" },
        user_constraints: { type: "array", items: { type: "string" } },
        authoritative_instructions_loaded: { type: "array", items: { type: "string" } },
        active_plan: { type: "array", items: { type: "string" } },
        active_goal_done_condition: { type: "string" },
        approval_state: { type: "string" },
        resources_inspected: { type: "array", items: { type: "string" } },
        key_facts_and_decisions: { type: "array", items: { type: "string" } },
        actions_already_taken: { type: "array", items: { type: "string" } },
        errors_blockers_and_fixes: { type: "array", items: { type: "string" } },
        pending_tasks: { type: "array", items: { type: "string" } },
        next_recommended_step: { type: "string" },
        do_not_redo: { type: "array", items: { type: "string" } },
        trust_label: { type: "string", enum: ["trusted", "semi_trusted", "untrusted"] },
        metadata: METADATA_SCHEMA,
      },
      required: [
        "current_objective",
        "user_constraints",
        "authoritative_instructions_loaded",
        "active_plan",
        "active_goal_done_condition",
        "approval_state",
        "resources_inspected",
        "key_facts_and_decisions",
        "actions_already_taken",
        "errors_blockers_and_fixes",
        "pending_tasks",
        "next_recommended_step",
        "do_not_redo",
      ],
    },
  },
  {
    name: "ctx_resume",
    description: "Return latest metadata-only events for a session so another agent can resume without re-reading raw context.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        limit: { type: "number" },
        metadata: METADATA_SCHEMA,
      },
    },
  },
  {
    name: "ctx_stats",
    description:
      "Return aggregate context-handoff usage counters. No raw prompts, docs, code, logs, or secrets are returned.",
    inputSchema: {
      type: "object",
      properties: {
        metadata: METADATA_SCHEMA,
      },
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asHandoffInput(args: Record<string, unknown>): HandoffInput {
  return {
    current_objective: String(args.current_objective || ""),
    user_constraints: stringArray(args.user_constraints),
    authoritative_instructions_loaded: stringArray(args.authoritative_instructions_loaded),
    active_plan: stringArray(args.active_plan),
    active_goal_done_condition: String(args.active_goal_done_condition || ""),
    approval_state: String(args.approval_state || "pending"),
    resources_inspected: stringArray(args.resources_inspected),
    key_facts_and_decisions: stringArray(args.key_facts_and_decisions),
    actions_already_taken: stringArray(args.actions_already_taken),
    errors_blockers_and_fixes: stringArray(args.errors_blockers_and_fixes),
    pending_tasks: stringArray(args.pending_tasks),
    next_recommended_step: String(args.next_recommended_step || ""),
    do_not_redo: stringArray(args.do_not_redo),
    trust_label:
      args.trust_label === "trusted" || args.trust_label === "semi_trusted" || args.trust_label === "untrusted"
        ? args.trust_label
        : undefined,
  };
}

function asEvent(args: Record<string, unknown>): ContextEvent {
  return {
    session_id: String(args.session_id || ""),
    surface: ["claude-code", "codex", "cursor", "windsurf", "automation", "other"].includes(String(args.surface))
      ? (String(args.surface) as ContextEvent["surface"])
      : "other",
    event_type: ["tool_result", "decision", "handoff", "approval", "error", "milestone"].includes(String(args.event_type))
      ? (String(args.event_type) as ContextEvent["event_type"])
      : "decision",
    summary: String(args.summary || ""),
    artifact_paths: stringArray(args.artifact_paths),
    token_estimate: typeof args.token_estimate === "number" ? args.token_estimate : undefined,
    trust_label:
      args.trust_label === "trusted" || args.trust_label === "semi_trusted" || args.trust_label === "untrusted"
        ? args.trust_label
        : undefined,
  };
}

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const server = new Server({ name: "context-handoff-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = asRecord(request.params.arguments);
  switch (request.params.name) {
    case "ctx_pre_score":
      return jsonContent(preScoreContext(args as ContextSignal));
    case "ctx_record_event":
      return jsonContent(await recordEvent(asEvent(args)));
    case "ctx_write_handoff":
      return jsonContent(renderHandoff(asHandoffInput(args)));
    case "ctx_resume":
      return jsonContent(
        await latestEvents({
          session_id: typeof args.session_id === "string" && args.session_id ? args.session_id : undefined,
          limit: typeof args.limit === "number" ? args.limit : 20,
        }),
      );
    case "ctx_stats":
      return jsonContent(await getStats());
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
