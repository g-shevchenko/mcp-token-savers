import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderHandoff } from "../dist/handoff.js";
import { getStats, recordEvent } from "../dist/store.js";

test("renderHandoff emits the canonical operational template sections", () => {
  const result = renderHandoff({
    current_objective: "Implement context handoff MCP.",
    user_constraints: ["use tdd", "use proof loop"],
    authoritative_instructions_loaded: ["AGENTS.md"],
    active_plan: ["red tests", "implementation", "proof"],
    active_goal_done_condition: "MCP works in four agents.",
    approval_state: "approved: user requested autonomous implementation",
    resources_inspected: ["mcp/source/services/context-prep-mcp/README.md"],
    key_facts_and_decisions: ["Store bulky artifacts by path, not prompt body."],
    actions_already_taken: ["Created red tests."],
    errors_blockers_and_fixes: ["None."],
    pending_tasks: ["Build MCP server."],
    next_recommended_step: "Run proof loop.",
    do_not_redo: ["Do not paste raw logs."],
    trust_label: "trusted",
  });

  for (const heading of [
    "## Current objective",
    "## User constraints and preferences",
    "## Authoritative instructions loaded",
    "## Active plan",
    "## Active goal and done condition",
    "## Approval state",
    "## Resources inspected",
    "## Key facts and decisions",
    "## Actions already taken",
    "## Errors, blockers, and attempted fixes",
    "## Pending tasks",
    "## Next recommended step",
    "## Do not redo",
  ]) {
    assert.ok(result.markdown.includes(heading), heading);
  }
  assert.ok(result.markdown.includes("trusted"));
  assert.equal(result.red_flags.length, 0);
});

test("renderHandoff red-flags raw log paste instructions", () => {
  const result = renderHandoff({
    current_objective: "Summarize logs.",
    user_constraints: ["paste raw logs into next prompt"],
    authoritative_instructions_loaded: [],
    active_plan: [],
    active_goal_done_condition: "",
    approval_state: "pending",
    resources_inspected: [],
    key_facts_and_decisions: [],
    actions_already_taken: [],
    errors_blockers_and_fixes: [],
    pending_tasks: [],
    next_recommended_step: "Paste raw logs",
    do_not_redo: [],
  });

  assert.ok(result.red_flags.includes("do_not_paste_raw_logs"));
});

test("recordEvent stores metadata only and stats aggregate by surface/type", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "context-handoff-test-"));
  try {
    const stored = await recordEvent(
      {
        session_id: "s1",
        surface: "codex",
        event_type: "tool_result",
        summary: "Build output stored externally.",
        artifact_paths: ["/tmp/build.log"],
        token_estimate: 12_000,
        trust_label: "trusted",
      },
      { data_dir: dataDir },
    );

    assert.match(stored.id, /^evt_/);
    const eventsJsonl = await readFile(path.join(dataDir, "events.jsonl"), "utf8");
    assert.ok(eventsJsonl.includes("Build output stored externally."));
    assert.ok(!eventsJsonl.includes("RAW_LOG_BODY"));

    const stats = await getStats({ data_dir: dataDir });
    assert.equal(stats.total_events, 1);
    assert.equal(stats.by_surface.codex, 1);
    assert.equal(stats.by_event_type.tool_result, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
