import { ContextPrepConfig, CONTEXT_PREP_SCHEMA_VERSION, CONTEXT_PREP_PIPELINE_VERSION } from "./config.js";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import { buildTokenStats } from "./token-estimates.js";
import { clampText, firstLines, normalizeWhitespace, uniqueStrings } from "./text-utils.js";

export interface PrepTextOptions {
  purpose?: string;
  max_compact_chars?: number;
  preserve_exact?: boolean;
  metadata?: unknown;
}

export interface PrepTextResult {
  schema_version: string;
  pipeline_version: string;
  prep_mode: "text-prep";
  purpose: string;
  input_stats: ReturnType<typeof buildTokenStats>;
  extracted: {
    summary_lines: string[];
    decisions: string[];
    action_items: string[];
    open_questions: string[];
    risks: string[];
  };
  compact_context: string;
  artifacts: {
    raw_text_url: string;
    manifest_url: string;
  };
  confidence: {
    uncertainty: number;
    reasons: string[];
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "use_compact_context" | "use_raw_artifact";
  };
  prompt_scaffold: string;
}

const DECISION_RE = /(решили|решение|итог|вывод|decided|decision|conclusion|we will|we agreed)/i;
const ACTION_RE = /(todo|action item|next step|follow[- ]?up|надо|нужно|сделать|починить|добавить|реализовать|проверить|fix|implement|ship|deploy)/i;
const RISK_RE = /(risk|риск|blocker|blocked|опасн|проблем|timeout|ошибка|regression|security|auth|credential|secret)/i;
const QUESTION_RE = /(\?|вопрос|неясно|уточн|tbd|open question|unclear|confirm)/i;

function matchingLines(lines: string[], pattern: RegExp, limit: number): string[] {
  return uniqueStrings(lines.filter((line) => pattern.test(line)), limit);
}

function buildExtractiveSummary(lines: string[], limit: number): string[] {
  const important = lines.filter((line) => {
    if (line.length < 12) {
      return false;
    }
    return DECISION_RE.test(line) || ACTION_RE.test(line) || RISK_RE.test(line) || QUESTION_RE.test(line);
  });

  return uniqueStrings([...lines.slice(0, 4), ...important], limit);
}

function composeCompactContext(result: {
  purpose: string;
  summary: string[];
  decisions: string[];
  actions: string[];
  questions: string[];
  risks: string[];
  carry: string;
}): string {
  const sections = [
    `Purpose: ${result.purpose}`,
    `Summary:\n${result.summary.map((item) => `- ${item}`).join("\n") || "- No strong summary lines detected."}`,
    result.decisions.length ? `Decisions:\n${result.decisions.map((item) => `- ${item}`).join("\n")}` : "",
    result.actions.length ? `Action items:\n${result.actions.map((item) => `- ${item}`).join("\n")}` : "",
    result.questions.length ? `Open questions:\n${result.questions.map((item) => `- ${item}`).join("\n")}` : "",
    result.risks.length ? `Risks / blockers:\n${result.risks.map((item) => `- ${item}`).join("\n")}` : "",
    `Carry-forward context:\n${result.carry}`,
  ];

  return sections.filter(Boolean).join("\n\n");
}

export async function prepText(
  text: string,
  config: ContextPrepConfig,
  options: PrepTextOptions = {},
): Promise<PrepTextResult> {
  const purpose = options.purpose?.trim() || "compact long text for frontier model context";
  const maxCompactChars = options.max_compact_chars || (options.preserve_exact ? 12_000 : 7_000);
  const normalized = normalizeWhitespace(text).slice(0, config.maxInputChars);
  const lines = firstLines(normalized, 400);
  const summary = buildExtractiveSummary(lines, 8);
  const decisions = matchingLines(lines, DECISION_RE, 10);
  const actions = matchingLines(lines, ACTION_RE, 16);
  const questions = matchingLines(lines, QUESTION_RE, 10);
  const risks = matchingLines(lines, RISK_RE, 10);
  const carry = clampText(normalized, options.preserve_exact ? maxCompactChars : Math.floor(maxCompactChars * 0.45));

  const compactContext = clampText(
    composeCompactContext({
      purpose,
      summary,
      decisions,
      actions,
      questions,
      risks,
      carry,
    }),
    maxCompactChars,
  );

  const artifactKey = stableKey("text", normalized);
  const rawArtifact = await persistArtifactText(config, artifactKey, "txt", normalized);
  const manifestArtifact = await persistArtifactJson(config, `${artifactKey}-manifest`, {
    purpose,
    metadata: options.metadata || null,
    extracted: {
      summary_lines: summary,
      decisions,
      action_items: actions,
      open_questions: questions,
      risks,
    },
    compact_context: compactContext,
  });

  const tokenStats = buildTokenStats(normalized, compactContext);
  const reasons: string[] = [];
  if (normalized.length !== text.length) {
    reasons.push("input_truncated_to_service_limit");
  }
  if (tokenStats.savings_pct < 25 && normalized.length > 8_000) {
    reasons.push("low_compression_gain");
  }
  if (options.preserve_exact) {
    reasons.push("preserve_exact_enabled");
  }

  const uncertainty = reasons.includes("low_compression_gain") ? 0.05 : options.preserve_exact ? 0.03 : 0.02;

  return {
    schema_version: CONTEXT_PREP_SCHEMA_VERSION,
    pipeline_version: CONTEXT_PREP_PIPELINE_VERSION,
    prep_mode: "text-prep",
    purpose,
    input_stats: tokenStats,
    extracted: {
      summary_lines: summary,
      decisions,
      action_items: actions,
      open_questions: questions,
      risks,
    },
    compact_context: compactContext,
    artifacts: {
      raw_text_url: rawArtifact.url,
      manifest_url: manifestArtifact.url,
    },
    confidence: {
      uncertainty,
      reasons,
    },
    autopilot: {
      requires_clarification: uncertainty > 0.03,
      suggested_action: uncertainty > 0.03 ? "use_raw_artifact" : "use_compact_context",
    },
    prompt_scaffold:
      "Use compact_context first. If exact wording, legal/compliance nuance, or quoted text matters, fetch raw_text_url before final reasoning.",
  };
}
