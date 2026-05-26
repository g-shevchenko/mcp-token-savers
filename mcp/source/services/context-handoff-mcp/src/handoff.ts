export type TrustLabel = "trusted" | "semi_trusted" | "untrusted";

export type HandoffInput = {
  current_objective: string;
  user_constraints: string[];
  authoritative_instructions_loaded: string[];
  active_plan: string[];
  active_goal_done_condition: string;
  approval_state: string;
  resources_inspected: string[];
  key_facts_and_decisions: string[];
  actions_already_taken: string[];
  errors_blockers_and_fixes: string[];
  pending_tasks: string[];
  next_recommended_step: string;
  do_not_redo: string[];
  trust_label?: TrustLabel;
};

export type HandoffResult = {
  schema_version: "context-handoff.markdown.v1";
  markdown: string;
  red_flags: string[];
};

function lines(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "None.";
}

function hasRawLogInstruction(input: HandoffInput): boolean {
  const haystack = [...input.user_constraints, ...input.pending_tasks, input.next_recommended_step]
    .join("\n")
    .toLowerCase();
  return /\bpaste\s+(the\s+)?raw\s+(logs?|output|terminal)\b/.test(haystack);
}

export function renderHandoff(input: HandoffInput): HandoffResult {
  const redFlags = hasRawLogInstruction(input) ? ["do_not_paste_raw_logs"] : [];
  const trustLine = input.trust_label ? `Trust label: ${input.trust_label}` : "Trust label: trusted";
  const markdown = `# Compaction Handoff

## Current objective
${input.current_objective || "None."}

## User constraints and preferences
${lines(input.user_constraints)}

## Authoritative instructions loaded
${lines(input.authoritative_instructions_loaded)}

## Active plan
${lines(input.active_plan)}

## Active goal and done condition
${input.active_goal_done_condition || "None."}

## Approval state
${input.approval_state || "pending"}

## Resources inspected
${lines(input.resources_inspected)}

## Key facts and decisions
${trustLine}
${lines(input.key_facts_and_decisions)}

## Actions already taken
${lines(input.actions_already_taken)}

## Errors, blockers, and attempted fixes
${lines(input.errors_blockers_and_fixes)}

## Pending tasks
${lines(input.pending_tasks)}

## Next recommended step
${input.next_recommended_step || "None."}

## Do not redo
${lines(input.do_not_redo)}
`;

  return {
    schema_version: "context-handoff.markdown.v1",
    markdown,
    red_flags: redFlags,
  };
}
