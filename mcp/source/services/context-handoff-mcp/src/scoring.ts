export type ContextSignal = {
  elapsed_minutes?: number;
  turn_count?: number;
  context_window_tokens?: number;
  estimated_context_tokens?: number;
  largest_tool_result_chars?: number;
  large_tool_result_count?: number;
  milestone?: "plan" | "execute" | "verify" | "ship" | "approval" | "resume";
  cross_agent_target?: "claude-code" | "codex" | "cursor" | "windsurf" | "other";
  has_long_noisy_input?: boolean;
  raw_paste_chars?: number;
};

export type PreScoreResult = {
  schema_version: "context-handoff.score.v1";
  pressure_score: number;
  gate: "continue" | "prepare_handoff" | "handoff_required";
  red_flags: string[];
  triggers: string[];
  recommended_action: string;
};

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function preScoreContext(signal: ContextSignal): PreScoreResult {
  const triggers: string[] = [];
  const redFlags: string[] = [];
  let score = 0;

  if (
    typeof signal.context_window_tokens === "number" &&
    signal.context_window_tokens > 0 &&
    typeof signal.estimated_context_tokens === "number"
  ) {
    const usagePct = (signal.estimated_context_tokens / signal.context_window_tokens) * 100;
    score = Math.max(score, usagePct);
    if (usagePct >= 70) {
      addUnique(triggers, "context_window_ge_70pct");
    } else if (usagePct >= 55) {
      addUnique(triggers, "context_window_ge_55pct");
    }
  }

  if (typeof signal.largest_tool_result_chars === "number" && signal.largest_tool_result_chars > 8000) {
    score = Math.max(score, 82);
    addUnique(redFlags, "large_tool_result_over_8000_chars");
    addUnique(triggers, "tool_result_over_8000_chars");
  }

  if (typeof signal.large_tool_result_count === "number" && signal.large_tool_result_count >= 3) {
    score = Math.max(score, 74);
    addUnique(triggers, "multiple_large_tool_results");
  }

  if (signal.has_long_noisy_input || (typeof signal.raw_paste_chars === "number" && signal.raw_paste_chars > 8000)) {
    score = Math.max(score, 80);
    addUnique(redFlags, "do_not_paste_raw_logs");
    addUnique(triggers, "long_noisy_input");
  }

  if (typeof signal.elapsed_minutes === "number" && signal.elapsed_minutes >= 30) {
    score = Math.max(score, 64);
    addUnique(triggers, "long_session_elapsed_ge_30min");
  }

  if (typeof signal.turn_count === "number" && signal.turn_count >= 50) {
    score = Math.max(score, 68);
    addUnique(triggers, "long_session_turns_ge_50");
  }

  if (signal.milestone && ["execute", "verify", "ship", "approval", "resume"].includes(signal.milestone)) {
    score = Math.max(score, signal.milestone === "approval" ? 72 : 58);
    addUnique(triggers, "major_milestone_boundary");
  }

  if (signal.cross_agent_target) {
    score = Math.max(score, 60);
    addUnique(triggers, "cross_agent_transfer");
  }

  const pressureScore = clampScore(score);
  const hardTrigger =
    triggers.includes("context_window_ge_70pct") ||
    triggers.includes("tool_result_over_8000_chars") ||
    redFlags.includes("do_not_paste_raw_logs") ||
    signal.milestone === "approval" ||
    signal.milestone === "resume";
  const softBoundary = triggers.includes("major_milestone_boundary") || triggers.includes("cross_agent_transfer");
  const gate: PreScoreResult["gate"] = hardTrigger
    ? "handoff_required"
    : softBoundary || pressureScore >= 55
      ? "prepare_handoff"
      : "continue";

  return {
    schema_version: "context-handoff.score.v1",
    pressure_score: pressureScore,
    gate,
    red_flags: redFlags,
    triggers,
    recommended_action:
      gate === "handoff_required"
        ? "write an operational handoff before continuing; reference bulky artifacts by path"
        : gate === "prepare_handoff"
          ? "prepare a stable handoff at this boundary"
          : "continue; record only material events",
  };
}
