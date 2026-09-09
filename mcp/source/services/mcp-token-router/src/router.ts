/**
 * mcp-token-router — measurement-driven compressor routing.
 *
 * The router's value is the deterministic mapping from
 * (input_chars, budget_chars, task_type) → compressor choice.
 * Routing rules are backed by the c2_bench measurement program
 * (see https://gregshevchenko.com/research/mcp-stack-token-economy/).
 *
 * NO LLM in the routing path. NO network. NO state.
 * Same (input_chars, budget_chars, task_type) → same RouteResult.
 *
 * The actual compression is delegated to one of three measured primitives:
 *   - hwai_v0_1_*  (HWAI fact-extraction prefix + sophon body)
 *   - contextprep_*  (HWAI context-prep prepText extractive)
 *   - sophon_*  (vendor, third-party MIT)
 *   - none  (return original; inflation guard)
 */

export interface RoutingRule {
  /** Compressor key consumed by the dispatch layer. */
  compressor: string;
  /** Inclusive lower bound of output-budget tier (chars). */
  budgetMin: number;
  /** Inclusive upper bound of output-budget tier (chars). */
  budgetMax: number;
  /** Measured quality pass-rate (0..1) from the 15-pair QA corpus. */
  measuredQuality: number;
  /** Measured char-saving (0..1) at this tier. */
  measuredSaving: number;
  /** Human-readable rationale (surfaced in RouteResult.reason). */
  notes: string;
}

export interface RouteRequest {
  /** Length of the input text in characters. */
  inputChars: number;
  /** Target output budget in characters. Defaults to 2000 (Pareto sweet-spot). */
  budgetChars?: number;
  /** Optional task hint: "extract" | "summarize" | "general" (default). */
  taskType?: string;
}

export interface RouteResult {
  /** Compressor key the caller should invoke. */
  compressor: string;
  /** Human-readable explanation referencing the measured frontier. */
  reason: string;
  /** Budget value (chars) used to make the decision. */
  budgetUsed: number;
}

/**
 * Measured routing-rule table. Order matters: rules are evaluated in array
 * order; the FIRST rule whose budget tier matches wins.
 *
 * Boundaries (lower-inclusive, upper-inclusive — closed intervals):
 *   [0, 1000]      → hwai_v0_1_600c
 *   [1001, 2500]   → hwai_v0_1_2000c
 *   [2501, ∞)      → contextprep_7000c
 */
export const ROUTING_RULES: RoutingRule[] = [
  {
    compressor: "hwai_v0_1_600c",
    budgetMin: 0,
    budgetMax: 1000,
    measuredQuality: 0.93,
    measuredSaving: 0.94,
    notes:
      "tight-budget tier: hwai's fact-prefix (titles, bylines, versions, error_patterns, json_kvs, enumerations, paths, key-labelled IDs) preserves the document metadata sophon drops; v0.3 internal upgrade lifted quality from 67% → 87% → 93% at 100%+ retention vs baseline",
  },
  {
    compressor: "hwai_v0_1_2000c",
    budgetMin: 1001,
    budgetMax: 2500,
    measuredQuality: 0.87,
    measuredSaving: 0.92,
    notes:
      "medium-budget Pareto sweet-spot: 87% quality + 92% saving + 100% retention vs baseline; dominates contextprep at the same output size",
  },
  {
    compressor: "contextprep_7000c",
    budgetMin: 2501,
    budgetMax: Number.MAX_SAFE_INTEGER,
    measuredQuality: 0.93,
    measuredSaving: 0.6,
    notes:
      "generous-budget tier: contextprep's extractive method (decisions+actions+questions+risks) wins at 93% quality once output budget exceeds the fact-prefix's contribution",
  },
];

const DEFAULT_BUDGET_CHARS = 2000; // Pareto sweet-spot per measurements
const INFLATION_GUARD_INPUT_CHARS = 1000;

export function routeForBudget(req: RouteRequest): RouteResult {
  const budget = req.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const taskType = (req.taskType ?? "general").toLowerCase();

  // Inflation guard: short inputs inflate in any tested compressor
  // (sophon wraps in <general>, contextprep regex-fans the same text into
  // every section). Returning "none" is the honest choice.
  if (req.inputChars < INFLATION_GUARD_INPUT_CHARS) {
    return {
      compressor: "none",
      reason: `input ${req.inputChars} chars < ${INFLATION_GUARD_INPUT_CHARS} — short inputs inflate in any compressor, returning original`,
      budgetUsed: budget,
    };
  }

  // Task-type overrides
  if (taskType === "extract") {
    // Find the matching hwai rule by budget tier
    const tier = ROUTING_RULES.find(
      (r) => r.compressor.startsWith("hwai_") && budget >= r.budgetMin && budget <= r.budgetMax,
    );
    const chosen = tier?.compressor ?? "hwai_v0_1_2000c";
    return {
      compressor: chosen,
      reason: `task_type=extract — fact-extraction critical; hwai's deterministic regex prefix preserves headers/bylines/versions that sophon and contextprep can drop`,
      budgetUsed: budget,
    };
  }

  if (taskType === "summarize") {
    return {
      compressor: "contextprep_7000c",
      reason: `task_type=summarize — contextprep's extractive method (purpose + summary + decisions + actions + questions + risks) is best for "give me the gist" tasks at any budget`,
      budgetUsed: budget,
    };
  }

  // Default tier-based routing
  for (const rule of ROUTING_RULES) {
    if (budget >= rule.budgetMin && budget <= rule.budgetMax) {
      const tierLabel =
        rule.budgetMax <= 1000
          ? "tight"
          : rule.budgetMax <= 2500
            ? "medium (Pareto sweet-spot)"
            : "generous";
      const isDefault = req.budgetChars === undefined;
      const prefix = isDefault
        ? `default budget ${budget} (Pareto sweet-spot)`
        : `${tierLabel} budget ${budget}c`;
      return {
        compressor: rule.compressor,
        reason: `${prefix} → ${rule.compressor}: measured quality ${(rule.measuredQuality * 100).toFixed(0)}%, saving ${(rule.measuredSaving * 100).toFixed(0)}%. ${rule.notes}`,
        budgetUsed: budget,
      };
    }
  }

  // Defensive fallback (shouldn't reach — table covers [0, ∞))
  return {
    compressor: "hwai_v0_1_2000c",
    reason: `defensive fallback — routing table didn't match budget ${budget}`,
    budgetUsed: budget,
  };
}
