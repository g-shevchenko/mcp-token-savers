#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { getRetrievalConfig } from "../dist/config.js";

const BAD_OUTCOMES = new Set(["partial", "miss", "wrong_context", "manual_search_needed"]);

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function cleanArray(value, maxItems = 12) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
}

function slugify(raw, fallback) {
  const slug = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pickDefaultFeedbackLog(config) {
  const sharedPath = path.join(process.env.HOME || "", ".hwai", "retrieval-mcp", "feedback.jsonl");
  if (sharedPath && sharedPath !== config.feedbackLogPath) {
    try {
      await fs.stat(sharedPath);
      return sharedPath;
    } catch {
      // Fall back to config path.
    }
  }
  return config.feedbackLogPath;
}

function inferIncludeGlobs(paths) {
  const topDirs = new Set();
  for (const item of paths) {
    const parts = item.split("/");
    if (parts[0] === "services" && parts[1]) {
      topDirs.add(`services/${parts[1]}/**`);
    } else if (parts[0] === "notes") {
      topDirs.add("notes/**");
    } else if (parts[0] === "claude" || parts[0] === ".claude" || parts[0] === ".cursor" || parts[0] === ".windsurf") {
      topDirs.add(`${parts[0]}/**`);
    } else if (parts[0]) {
      topDirs.add(`${parts[0]}/**`);
    }
  }
  return Array.from(topDirs).slice(0, 8);
}

function candidateFromFeedback(item, index) {
  const expectedPaths = cleanArray(item.expected_paths).length > 0
    ? cleanArray(item.expected_paths)
    : cleanArray(item.missing_paths);
  if (expectedPaths.length === 0) {
    return null;
  }
  const query = typeof item.corrected_query === "string" && item.corrected_query.trim()
    ? item.corrected_query.trim()
    : typeof item.query === "string"
    ? item.query.trim()
    : "";
  if (!query) {
    return null;
  }

  return {
    name: slugify(query, `trace-${index + 1}`),
    review_status: "needs_review",
    source_feedback_ids: cleanArray([item.feedback_id || item.call_id].filter(Boolean), 3),
    query,
    task_intent: "unknown",
    include_globs: inferIncludeGlobs(expectedPaths),
    expected_paths: expectedPaths,
    expected_terms: [],
    trace_outcome: item.outcome,
    frontier_had_to_search: item.frontier_had_to_search === true,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const key = JSON.stringify({
      query: candidate.query,
      expected_paths: candidate.expected_paths.slice().sort(),
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

const config = getRetrievalConfig();
const feedbackLogPath = path.resolve(
  argValue("--feedback-log", await pickDefaultFeedbackLog(config)),
);
const outPath = argValue("--out", "");
const includeHelpful = hasFlag("--include-helpful");

const feedback = await readJsonl(feedbackLogPath);
const filtered = feedback.filter((item) =>
  includeHelpful ? item.outcome === "helpful" || BAD_OUTCOMES.has(item.outcome) : BAD_OUTCOMES.has(item.outcome) || item.frontier_had_to_search === true,
);
const candidates = dedupeCandidates(
  filtered
    .map(candidateFromFeedback)
    .filter(Boolean),
);

const payload = {
  schema_version: "retrieval-trace-candidates.v1",
  generated_at: new Date().toISOString(),
  feedback_log_path: feedbackLogPath,
  summary: {
    feedback_lines: feedback.length,
    candidate_feedback_lines: filtered.length,
    candidates: candidates.length,
  },
  candidates,
  review_instructions: [
    "Review each candidate before copying it into benchmarks/from-traces.json.",
    "Keep only safe queries and metadata-only paths.",
    "Add expected_terms or expected_symbols after inspecting exact files.",
    "Run npm run benchmark before changing ranking.",
  ],
};

const rendered = `${JSON.stringify(payload, null, 2)}\n`;
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), rendered, "utf8");
  console.log(JSON.stringify({ wrote: path.resolve(outPath), candidates: candidates.length }, null, 2));
} else {
  process.stdout.write(rendered);
}
