/**
 * RAG (Retrieval Augmented Generation) for screenshot task analysis
 * Searches KNOWLEDGE_BASE.md for relevant gotchas and context
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Gotcha {
  category: string;
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
  relatedFiles?: string[];
}

export interface RAGContext {
  gotchas: Gotcha[];
  relevantSections: string[];
  warnings: string[];
}

// Keywords mapping for different UI element types
const ELEMENT_KEYWORDS: Record<string, string[]> = {
  "video player": ["video", "media", "player", "overflow", "padding", "responsive"],
  "chart": ["chart", "graph", "visualization", "d3", "recharts", "data"],
  "address bar": ["url", "navigation", "routing", "browser", "location"],
  "button": ["button", "click", "cta", "action", "disabled"],
  "heading": ["heading", "title", "h1", "h2", "typography"],
  "input": ["input", "form", "validation", "field"],
  "image": ["image", "img", "lazy", "loading", "optimization"],
  "container": ["container", "layout", "grid", "flex", "css"],
  "navigation": ["nav", "menu", "navbar", "sidebar"],
};

// Keywords from comment text patterns
const COMMENT_PATTERNS: Record<string, string[]> = {
  padding: ["padding", "margin", "spacing", "layout", "css"],
  mobile: ["mobile", "responsive", "breakpoint", "device"],
  slow: ["performance", "loading", "speed", "optimization"],
  text: ["text", "font", "typography", "i18n", "translation"],
};

/**
 * Search KNOWLEDGE_BASE.md for relevant gotchas
 */
export async function findRelevantGotchas(
  elementType: string,
  commentText: string,
  knowledgeBasePath: string = "../../../claude/KNOWLEDGE_BASE.md"
): Promise<RAGContext> {
  const gotchas: Gotcha[] = [];
  const relevantSections: string[] = [];
  const warnings: string[] = [];

  try {
    // Resolve path relative to this file
    const kbPath = path.resolve(__dirname, knowledgeBasePath);
    
    if (!fs.existsSync(kbPath)) {
      console.error(`[RAG] Knowledge base not found: ${kbPath}`);
      return { gotchas, relevantSections, warnings };
    }

    const content = fs.readFileSync(kbPath, "utf-8");

    // Build search keywords
    const searchTerms = buildSearchTerms(elementType, commentText);
    console.error(`[RAG] Searching for: ${searchTerms.join(", ")}`);

    // Search in content
    for (const term of searchTerms) {
      const matches = findMatches(content, term);
      
      for (const match of matches.slice(0, 3)) { // Top 3 matches per term
        const gotcha = extractGotcha(content, match, term);
        if (gotcha && !gotchas.find(g => g.title === gotcha.title)) {
          gotchas.push(gotcha);
        }
      }
    }

    // Add warnings based on element type
    if (elementType.includes("video")) {
      warnings.push("Video players often have mobile overflow issues — test on actual devices");
    }
    if (elementType.includes("chart")) {
      warnings.push("Charts may have responsive rendering issues — verify container queries");
    }
    if (commentText.toLowerCase().includes("padding")) {
      warnings.push("Padding/margin fixes may affect responsive breakpoints — test all sizes");
    }

    return { gotchas, relevantSections, warnings };
  } catch (error) {
    console.error(`[RAG] Error searching knowledge base: ${error}`);
    return { gotchas, relevantSections, warnings };
  }
}

/**
 * Build search terms from element type and comment
 */
function buildSearchTerms(elementType: string, commentText: string): string[] {
  const terms = new Set<string>();

  // Add element type keywords
  for (const [type, keywords] of Object.entries(ELEMENT_KEYWORDS)) {
    if (elementType.toLowerCase().includes(type)) {
      keywords.forEach(k => terms.add(k));
    }
  }

  // Add comment pattern keywords
  const lowerComment = commentText.toLowerCase();
  for (const [pattern, keywords] of Object.entries(COMMENT_PATTERNS)) {
    if (lowerComment.includes(pattern)) {
      keywords.forEach(k => terms.add(k));
    }
  }

  // Extract specific words from comment (3+ chars)
  const words = commentText
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !["the", "and", "for", "this", "with"].includes(w));
  words.slice(0, 5).forEach(w => terms.add(w));

  return Array.from(terms).slice(0, 10); // Max 10 terms
}

/**
 * Find matches of search term in content
 */
function findMatches(content: string, term: string): Array<{ line: number; context: string }> {
  const lines = content.split("\n");
  const matches: Array<{ line: number; context: string }> = [];
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(term.toLowerCase())) {
      // Get context (3 lines before and after)
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 4);
      const context = lines.slice(start, end).join("\n");
      matches.push({ line: i + 1, context });
    }
  }
  
  return matches;
}

/**
 * Extract gotcha from matched context
 */
function extractGotcha(
  content: string,
  match: { line: number; context: string },
  searchTerm: string
): Gotcha | null {
  // Simple extraction — look for headers and bullet points
  const lines = match.context.split("\n");
  
  let title = "";
  let description = "";
  let category = "general";
  let severity: "high" | "medium" | "low" = "medium";

  for (const line of lines) {
    // Markdown headers
    if (line.startsWith("## ") || line.startsWith("### ")) {
      title = line.replace(/^#+\s+/, "").trim();
    }
    // Bullet points with gotcha indicators
    else if (line.match(/^\s*[-*]\s*(⚠️|❌|WARNING|GOTCHA|BUG)/i)) {
      description = line.replace(/^\s*[-*]\s*/, "").trim();
      severity = line.includes("⚠️") || line.includes("❌") ? "high" : "medium";
    }
    // Category from context
    else if (line.toLowerCase().includes("css") || line.toLowerCase().includes("layout")) {
      category = "css";
    }
    else if (line.toLowerCase().includes("performance")) {
      category = "performance";
    }
  }

  if (!title) {
    title = `Issue related to "${searchTerm}"`;
  }
  if (!description) {
    description = match.context.slice(0, 200) + "...";
  }

  return { category, title, description, severity };
}

/**
 * Quick check if element type is known to have common issues
 */
export function hasKnownIssues(elementType: string): boolean {
  return Object.keys(ELEMENT_KEYWORDS).some(
    key => elementType.toLowerCase().includes(key)
  );
}

/**
 * Format RAG context for output
 */
export function formatRAGContext(context: RAGContext): string {
  if (context.gotchas.length === 0 && context.warnings.length === 0) {
    return "";
  }

  let output = "\n### ⚠️ Relevant Gotchas & Warnings\n\n";

  if (context.gotchas.length > 0) {
    output += "**From Knowledge Base:**\n";
    for (const gotcha of context.gotchas.slice(0, 3)) {
      const icon = gotcha.severity === "high" ? "🔴" : gotcha.severity === "medium" ? "🟡" : "🟢";
      output += `- ${icon} **${gotcha.title}** (${gotcha.category})\n`;
      output += `  ${gotcha.description.slice(0, 150)}...\n`;
    }
    output += "\n";
  }

  if (context.warnings.length > 0) {
    output += "**Generated Warnings:**\n";
    for (const warning of context.warnings) {
      output += `- ⚠️ ${warning}\n`;
    }
  }

  return output;
}
