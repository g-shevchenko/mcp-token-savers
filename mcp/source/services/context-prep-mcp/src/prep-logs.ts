import { ContextPrepConfig, CONTEXT_PREP_SCHEMA_VERSION, CONTEXT_PREP_PIPELINE_VERSION } from "./config.js";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import { buildTokenStats } from "./token-estimates.js";
import { clampText, stripAnsi, uniqueStrings } from "./text-utils.js";

export interface PrepLogsOptions {
  context?: string;
  max_compact_chars?: number;
  metadata?: unknown;
}

export interface PrepLogsResult {
  schema_version: string;
  pipeline_version: string;
  prep_mode: "logs-prep";
  context: string;
  input_stats: ReturnType<typeof buildTokenStats>;
  failing_commands: string[];
  top_errors: string[];
  stack_frames: string[];
  impacted_files: string[];
  likely_root_cause: string;
  suggested_next_checks: string[];
  compact_context: string;
  artifacts: {
    raw_log_url: string;
    manifest_url: string;
  };
  confidence: {
    uncertainty: number;
    reasons: string[];
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "debug_from_compact_log" | "inspect_raw_log";
  };
  prompt_scaffold: string;
}

const ERROR_RE =
  /(error|failed|failure|exception|traceback|panic|fatal|cannot find|not found|timeout|timed out|eaddrinuse|npm err!|assertion|segmentation|denied|permission|syntaxerror|typeerror|referenceerror|fail\b)/i;
const COMMAND_RE = /^(\$|>|❯|➜)\s+.+|^(npm|pnpm|yarn|bun|pytest|python|node|tsc|vite|playwright|docker|git|go|cargo|make)\s+.+/i;
const STACK_RE = /^\s*(at\s+.+\(.+\:\d+\:\d+\)|File ".+", line \d+|.+\.(ts|tsx|js|jsx|py|go|rs|java|rb|php):\d+)/i;
const FILE_RE = /(?:^|\s|["'(`])([A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|astro|json|ya?ml|md|sql|sh|tsx?))(?::\d+)?/g;

function collectCommands(lines: string[]): string[] {
  return uniqueStrings(lines.filter((line) => COMMAND_RE.test(line.trim())).map((line) => line.trim()), 12);
}

function collectErrors(lines: string[]): string[] {
  const errors: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || !ERROR_RE.test(line)) {
      continue;
    }

    const next = lines[index + 1]?.trim();
    errors.push(next && next.length < 240 ? `${line}\n${next}` : line);
  }

  return uniqueStrings(errors, 18);
}

function collectFiles(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(FILE_RE)) {
    files.push(match[1]);
  }
  return uniqueStrings(files, 24);
}

function buildLikelyRootCause(errors: string[]): string {
  if (!errors.length) {
    return "No clear error line detected. Use raw_log_url if the failure is hidden in omitted output.";
  }

  const firstNonNoise = errors.find((line) => !/(warning|deprecated|notice)/i.test(line));
  return firstNonNoise || errors[0];
}

function buildNextChecks(files: string[], errors: string[]): string[] {
  const checks = [
    "Re-run the smallest failing command, not the whole pipeline.",
    "Inspect the first real error before later cascading failures.",
  ];

  if (files.length) {
    checks.push(`Open impacted files first: ${files.slice(0, 5).join(", ")}`);
  }
  if (errors.some((line) => /timeout|timed out/i.test(line))) {
    checks.push("Check whether this is a real failure or an infra/network timeout.");
  }
  if (errors.some((line) => /permission|denied|eacces/i.test(line))) {
    checks.push("Check file permissions, env vars, and service user before changing app code.");
  }
  if (errors.some((line) => /not found|cannot find/i.test(line))) {
    checks.push("Check missing dependency/path/import before editing business logic.");
  }

  return checks;
}

function composeCompactLog(input: {
  context: string;
  commands: string[];
  errors: string[];
  stackFrames: string[];
  files: string[];
  rootCause: string;
  nextChecks: string[];
  tail: string;
}): string {
  return [
    `Context: ${input.context}`,
    input.commands.length ? `Failing / relevant commands:\n${input.commands.map((item) => `- ${item}`).join("\n")}` : "",
    `Likely root cause:\n${input.rootCause}`,
    input.errors.length ? `Top errors:\n${input.errors.map((item) => `- ${item}`).join("\n")}` : "",
    input.stackFrames.length ? `Stack frames:\n${input.stackFrames.map((item) => `- ${item}`).join("\n")}` : "",
    input.files.length ? `Impacted files:\n${input.files.map((item) => `- ${item}`).join("\n")}` : "",
    `Suggested next checks:\n${input.nextChecks.map((item) => `- ${item}`).join("\n")}`,
    `Log tail:\n${input.tail}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function prepLogs(
  text: string,
  config: ContextPrepConfig,
  options: PrepLogsOptions = {},
): Promise<PrepLogsResult> {
  const context = options.context?.trim() || "build/test/runtime logs";
  const maxCompactChars = options.max_compact_chars || 8_000;
  const normalized = stripAnsi(text).replace(/\r\n/g, "\n").slice(0, config.maxInputChars);
  const lines = normalized.split("\n");
  const commands = collectCommands(lines);
  const errors = collectErrors(lines);
  const stackFrames = uniqueStrings(lines.filter((line) => STACK_RE.test(line)).map((line) => line.trim()), 18);
  const files = collectFiles(normalized);
  const rootCause = buildLikelyRootCause(errors);
  const nextChecks = buildNextChecks(files, errors);
  const tail = clampText(lines.slice(-80).join("\n").trim(), 2_500);
  const compactContext = clampText(
    composeCompactLog({
      context,
      commands,
      errors,
      stackFrames,
      files,
      rootCause,
      nextChecks,
      tail,
    }),
    maxCompactChars,
  );

  const artifactKey = stableKey("logs", normalized);
  const rawArtifact = await persistArtifactText(config, artifactKey, "log", normalized);
  const manifestArtifact = await persistArtifactJson(config, `${artifactKey}-manifest`, {
    context,
    failing_commands: commands,
    top_errors: errors,
    stack_frames: stackFrames,
    impacted_files: files,
    likely_root_cause: rootCause,
    suggested_next_checks: nextChecks,
    compact_context: compactContext,
    metadata: options.metadata || null,
  });

  const tokenStats = buildTokenStats(normalized, compactContext);
  const reasons: string[] = [];
  if (!errors.length) {
    reasons.push("no_clear_error_detected");
  }
  if (errors.length > 14) {
    reasons.push("many_error_candidates");
  }
  if (normalized.length !== text.length) {
    reasons.push("input_truncated_to_service_limit");
  }

  const uncertainty = !errors.length ? 0.08 : errors.length > 14 ? 0.05 : 0.02;

  return {
    schema_version: CONTEXT_PREP_SCHEMA_VERSION,
    pipeline_version: CONTEXT_PREP_PIPELINE_VERSION,
    prep_mode: "logs-prep",
    context,
    input_stats: tokenStats,
    failing_commands: commands,
    top_errors: errors,
    stack_frames: stackFrames,
    impacted_files: files,
    likely_root_cause: rootCause,
    suggested_next_checks: nextChecks,
    compact_context: compactContext,
    artifacts: {
      raw_log_url: rawArtifact.url,
      manifest_url: manifestArtifact.url,
    },
    confidence: {
      uncertainty,
      reasons,
    },
    autopilot: {
      requires_clarification: uncertainty > 0.03,
      suggested_action: uncertainty > 0.03 ? "inspect_raw_log" : "debug_from_compact_log",
    },
    prompt_scaffold:
      "Use compact_context to start debugging. If there are many error candidates or no clear root cause, inspect raw_log_url before editing code.",
  };
}
