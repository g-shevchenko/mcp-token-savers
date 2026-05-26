import assert from "node:assert/strict";
import { test } from "node:test";
import { preScoreContext } from "../dist/scoring.js";

test("preScoreContext escalates when context usage reaches 70 percent", () => {
  const result = preScoreContext({
    context_window_tokens: 1_000_000,
    estimated_context_tokens: 720_000,
    turn_count: 38,
  });

  assert.equal(result.gate, "handoff_required");
  assert.ok(result.pressure_score >= 70);
  assert.ok(result.triggers.includes("context_window_ge_70pct"));
});

test("preScoreContext flags large raw tool output without asking to paste logs", () => {
  const result = preScoreContext({
    largest_tool_result_chars: 24_000,
    large_tool_result_count: 3,
    has_long_noisy_input: true,
    raw_paste_chars: 18_000,
  });

  assert.equal(result.gate, "handoff_required");
  assert.ok(result.red_flags.includes("large_tool_result_over_8000_chars"));
  assert.ok(result.red_flags.includes("do_not_paste_raw_logs"));
});

test("preScoreContext prepares handoff at milestone and cross-agent boundary", () => {
  const result = preScoreContext({
    milestone: "verify",
    cross_agent_target: "cursor",
    elapsed_minutes: 18,
  });

  assert.equal(result.gate, "prepare_handoff");
  assert.ok(result.triggers.includes("major_milestone_boundary"));
  assert.ok(result.triggers.includes("cross_agent_transfer"));
});
