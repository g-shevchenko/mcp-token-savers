import { ContextPrepConfig, CONTEXT_PREP_SCHEMA_VERSION, CONTEXT_PREP_PIPELINE_VERSION } from "./config.js";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import { buildTokenStats, estimateTokens } from "./token-estimates.js";

export type CompressionMode = "query" | "general";

export interface CompressContextOptions {
  query?: string;
  mode?: CompressionMode;
  target_ratio?: number;
  metadata?: unknown;
}

export interface CompressContextResult {
  schema_version: string;
  pipeline_version: string;
  prep_mode: "context-compression";
  compression: {
    mode: CompressionMode;
    query: string;
    target_ratio: number;
    method: "deterministic-extractive-v1";
    units_total: number;
    units_kept: number;
    critical_units_kept: number;
  };
  input_stats: ReturnType<typeof buildTokenStats>;
  compressed_context: string;
  retained_units: Array<{
    index: number;
    score: number;
    tokens_estimate: number;
  }>;
  artifacts: {
    raw_context_url: string;
    manifest_url: string;
  };
  confidence: {
    uncertainty: number;
    reasons: string[];
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "use_compressed_context" | "use_raw_artifact";
  };
  prompt_scaffold: string;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "you",
  "your",
  "are",
  "или",
  "для",
  "что",
  "это",
  "как",
  "при",
  "без",
  "его",
  "она",
  "они",
]);

function normalizeMode(mode: unknown): CompressionMode {
  return mode === "general" ? "general" : "query";
}

function normalizeRatio(value: unknown): number {
  const ratio = typeof value === "number" && Number.isFinite(value) ? value : 0.35;
  return Math.min(0.9, Math.max(0.1, ratio));
}

function terms(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9_а-яё-]+/iu)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3)
      .filter((item) => !STOP_WORDS.has(item)),
  );
}

function splitUnits(text: string): string[] {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (paragraphs.length >= 4) {
    return paragraphs;
  }
  return String(text || "")
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreUnit(unit: string, queryTerms: Set<string>, index: number, mode: CompressionMode): number {
  const unitLower = unit.toLowerCase();
  const unitTerms = terms(unit);
  let score = 0;
  let queryHits = 0;

  if (mode === "query") {
    for (const term of queryTerms) {
      if (unitTerms.has(term) || unitLower.includes(term)) {
        queryHits += 1;
        score += 8;
      }
    }
    if (queryHits >= 2) {
      score += 8;
    }
  }

  if (/quality gate|guardrail|policy|must|requires?|should|error|failed|exception|root cause|decision|risk|action|todo|fix|warning/i.test(unit)) {
    score += 5;
  }
  if (/```|\{|\}|\(|\)|\b[A-Z0-9_]{4,}\b|\.ts|\.js|\.py|\.md|npm|node|git/i.test(unit)) {
    score += 3;
  }
  if (/[$€£]\d|\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?x\b/i.test(unit)) {
    score += 2;
  }
  if (/^#{1,6}\s|^[A-Z][A-Za-z0-9 -]{2,60}$/m.test(unit)) {
    score += 2;
  }
  if (/^noise\b|unrelated|generic product prose|background/i.test(unit)) {
    score -= 8;
  }

  score += Math.max(0, 2 - index * 0.05);
  return score;
}

function isCriticalEvidenceUnit(unit: string): boolean {
  return /quality gate|guardrail|policy|must|requires?|do not|don't|should|error|failed|exception|root cause|evidence|decision|risk|action|todo|fix|warning|exact command|exact env|caveat|timing|следующее действие|запустить/i.test(unit);
}

function isNoiseUnit(unit: string): boolean {
  return /^noise\b|unrelated|generic product prose|background|misleading note/i.test(unit);
}

export async function compressContext(
  text: string,
  config: ContextPrepConfig,
  options: CompressContextOptions = {},
): Promise<CompressContextResult> {
  const mode = normalizeMode(options.mode);
  const targetRatio = normalizeRatio(options.target_ratio);
  const normalized = String(text || "").slice(0, config.maxInputChars);
  const rawTokens = estimateTokens(normalized);
  const targetTokens = Math.max(32, Math.floor(rawTokens * targetRatio));
  const query = String(options.query || "");
  const queryTerms = terms(query);
  const units = splitUnits(normalized);
  const scored = units.map((unit, index) => ({
    index,
    unit,
    tokens: estimateTokens(unit),
    score: scoreUnit(unit, queryTerms, index, mode),
    critical: isCriticalEvidenceUnit(unit),
  }));

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const kept: typeof scored = [];
  let compactTokens = 0;
  for (const item of scored) {
    if (isNoiseUnit(item.unit)) {
      continue;
    }
    if (item.score <= 0) {
      continue;
    }
    const canExceedForCritical = item.critical && compactTokens < Math.ceil(targetTokens * 1.25);
    if (kept.length > 0 && compactTokens + item.tokens > targetTokens && !canExceedForCritical) {
      continue;
    }
    kept.push(item);
    compactTokens += item.tokens;
    if (compactTokens >= targetTokens) {
      break;
    }
  }

  if (kept.length === 0 && scored.length > 0) {
    kept.push(scored[0]);
  }

  kept.sort((a, b) => a.index - b.index);
  const compressedContext = kept.map((item) => item.unit).join("\n\n");
  const tokenStats = buildTokenStats(normalized, compressedContext);
  const artifactKey = stableKey("compress", normalized);
  const rawArtifact = await persistArtifactText(config, artifactKey, "txt", normalized);
  const manifestArtifact = await persistArtifactJson(config, `${artifactKey}-manifest`, {
    mode,
    query,
    target_ratio: targetRatio,
    metadata: options.metadata || null,
    retained_units: kept.map((item) => ({
      index: item.index,
      score: item.score,
      tokens_estimate: item.tokens,
    })),
    input_stats: tokenStats,
  });

  const reasons: string[] = [];
  if (mode === "query" && queryTerms.size === 0) {
    reasons.push("query_mode_without_query");
  }
  if (normalized.length !== text.length) {
    reasons.push("input_truncated_to_service_limit");
  }
  if (tokenStats.savings_pct < 25 && rawTokens > 500) {
    reasons.push("low_compression_gain");
  }
  if (targetRatio <= 0.2) {
    reasons.push("aggressive_compression");
  }

  const uncertainty =
    reasons.includes("query_mode_without_query") || reasons.includes("low_compression_gain")
      ? 0.05
      : reasons.includes("aggressive_compression")
        ? 0.04
        : 0.02;

  return {
    schema_version: CONTEXT_PREP_SCHEMA_VERSION,
    pipeline_version: CONTEXT_PREP_PIPELINE_VERSION,
    prep_mode: "context-compression",
    compression: {
      mode,
      query,
      target_ratio: targetRatio,
      method: "deterministic-extractive-v1",
      units_total: units.length,
      units_kept: kept.length,
      critical_units_kept: kept.filter((item) => item.critical).length,
    },
    input_stats: tokenStats,
    compressed_context: compressedContext,
    retained_units: kept.map((item) => ({
      index: item.index,
      score: item.score,
      tokens_estimate: item.tokens,
    })),
    artifacts: {
      raw_context_url: rawArtifact.url,
      manifest_url: manifestArtifact.url,
    },
    confidence: {
      uncertainty,
      reasons,
    },
    autopilot: {
      requires_clarification: uncertainty > 0.03,
      suggested_action: uncertainty > 0.03 ? "use_raw_artifact" : "use_compressed_context",
    },
    prompt_scaffold:
      "Use compressed_context only for the first pass. If the answer needs exact wording, legal/security nuance, or the compression is aggressive/high-uncertainty, fetch raw_context_url before final reasoning.",
  };
}
