#!/usr/bin/env node
import { preScoreContext } from "../dist/scoring.js";
import { renderHandoff } from "../dist/handoff.js";

const started = performance.now();
const cases = [
  { context_window_tokens: 1000000, estimated_context_tokens: 720000 },
  { largest_tool_result_chars: 24000, has_long_noisy_input: true },
  { milestone: "verify", cross_agent_target: "codex" },
  { elapsed_minutes: 4, turn_count: 8 },
];

const scores = cases.map((input) => preScoreContext(input));
const handoff = renderHandoff({
  current_objective: "Benchmark context handoff rendering.",
  user_constraints: ["Use local metadata only."],
  authoritative_instructions_loaded: ["README.md"],
  active_plan: ["score", "render", "report"],
  active_goal_done_condition: "All outputs are deterministic.",
  approval_state: "not_required",
  resources_inspected: ["mcp/source/services/context-handoff-mcp/README.md"],
  key_facts_and_decisions: ["No raw logs are needed."],
  actions_already_taken: ["Built service."],
  errors_blockers_and_fixes: [],
  pending_tasks: [],
  next_recommended_step: "Run smoke.",
  do_not_redo: ["Do not paste raw logs."],
  trust_label: "trusted",
});

const report = {
  schema_version: "context-handoff.benchmark.v1",
  generated_at: new Date().toISOString(),
  duration_ms: Math.round(performance.now() - started),
  cases: scores.length,
  gates: scores.reduce((acc, score) => {
    acc[score.gate] = (acc[score.gate] || 0) + 1;
    return acc;
  }, {}),
  handoff_chars: handoff.markdown.length,
  red_flags: [...new Set(scores.flatMap((score) => score.red_flags).concat(handoff.red_flags))],
  data_policy: {
    local_only: true,
    raw_prompts_returned: false,
    raw_logs_returned: false
  }
};

console.log(JSON.stringify(report, null, 2));
