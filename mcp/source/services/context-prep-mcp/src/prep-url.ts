import fetch, { Response } from "node-fetch";
import { load } from "cheerio";
import { ContextPrepConfig, CONTEXT_PREP_SCHEMA_VERSION, CONTEXT_PREP_PIPELINE_VERSION } from "./config.js";
import { persistArtifactJson, persistArtifactText, stableKey } from "./artifact-store.js";
import { buildTokenStats } from "./token-estimates.js";
import { clampText, normalizeWhitespace, uniqueStrings } from "./text-utils.js";
import { assertSafePublicUrl } from "./url-policy.js";
import {
  fetchWithScraperCore,
  isScraperCoreConfigured,
  ScraperCoreFetchResult,
} from "./scraper-core-client.js";

type ParserStackMode = "auto" | "local" | "scraper_core";

export interface PrepUrlOptions {
  allow_paid_tiers?: boolean;
  country?: string;
  purpose?: string;
  max_compact_chars?: number;
  max_tier?: string;
  metadata?: unknown;
  parser_stack?: ParserStackMode;
  session_id?: string;
}

export interface PrepUrlResult {
  schema_version: string;
  pipeline_version: string;
  prep_mode: "url-prep";
  source_url: string;
  final_url: string;
  purpose: string;
  title: string;
  description?: string;
  canonical_url?: string;
  content_type: string;
  parser_stack: {
    requested: ParserStackMode;
    used: "local" | "scraper_core";
    fallback_reason?: string;
    scraper_core?: {
      cache_hit?: boolean;
      challenge_detected?: string | null;
      duration_ms?: number;
      engine?: string;
      status?: number;
      tiers_tried?: string[];
    };
  };
  input_stats: ReturnType<typeof buildTokenStats>;
  headings: string[];
  key_facts: string[];
  key_links: Array<{ text: string; url: string }>;
  compact_markdown: string;
  warnings: string[];
  artifacts: {
    cleaned_text_url: string;
    manifest_url: string;
  };
  confidence: {
    uncertainty: number;
    reasons: string[];
  };
  autopilot: {
    requires_clarification: boolean;
    suggested_action: "use_compact_markdown" | "inspect_cleaned_artifact";
  };
  prompt_scaffold: string;
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  if (!response.body) {
    return { text: "", truncated: false };
  }

  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const remaining = Math.max(0, maxBytes - (total - buffer.length));
      chunks.push(buffer.subarray(0, remaining));
      truncated = true;
      break;
    }
    chunks.push(buffer);
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  };
}

interface PreparedUrlParts {
  canonical?: string;
  cleanedText: string;
  contentType: string;
  description?: string;
  finalUrl: string;
  facts: string[];
  headings: string[];
  links: Array<{ text: string; url: string }>;
  rawText: string;
  title: string;
  warnings: string[];
}

function extractFacts(cleanedText: string): string[] {
  return uniqueStrings(
    cleanedText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /(\d{2,}|[$€£₽%]|pricing|price|deadline|date|api|token|limit|latency|cost|стоим|цена|лимит|дата)/i.test(line)),
    18,
  );
}

function markdownHeadings(markdown: string): string[] {
  return uniqueStrings(
    markdown
      .split("\n")
      .map((line) => line.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim() || "")
      .filter(Boolean),
    24,
  );
}

function markdownLinks(markdown: string): Array<{ text: string; url: string }> {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g)) {
    links.push(`${normalizeWhitespace(match[1])}\t${match[2]}`);
  }

  return uniqueStrings(links, 30).map((item) => {
    const [text, url] = item.split("\t");
    return { text, url };
  });
}

function isLikelyJsShell(rawHtml: string, cleanedText: string): boolean {
  if (cleanedText.length >= 800) {
    return false;
  }

  return /(__NEXT_DATA__|data-reactroot|vite|webpackJsonp|enable javascript|cf-chl|cloudflare|datadome|turnstile|captcha)/i.test(
    rawHtml.slice(0, 50_000),
  );
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function htmlToCompactParts(html: string, baseUrl: string): {
  title: string;
  description?: string;
  canonical?: string;
  cleanedText: string;
  headings: string[];
  links: Array<{ text: string; url: string }>;
  facts: string[];
} {
  const $ = load(html);

  $("script,style,noscript,svg,canvas,iframe,template,nav,header,footer,form").remove();
  $("[aria-hidden='true'],[hidden]").remove();

  const title = normalizeWhitespace($("title").first().text() || $("h1").first().text() || "Untitled page");
  const description = normalizeWhitespace(
    $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "",
  );
  const canonical = $("link[rel='canonical']").attr("href");
  const canonicalUrl = canonical ? absoluteUrl(canonical, baseUrl) || undefined : undefined;
  const root = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("[role='main']").first().length
        ? $("[role='main']").first()
        : $("body").first();

  const headings = uniqueStrings(
    root
      .find("h1,h2,h3")
      .toArray()
      .map((el) => normalizeWhitespace($(el).text()))
      .filter(Boolean),
    24,
  );

  const links = uniqueStrings(
    root
      .find("a[href]")
      .toArray()
      .map((el) => {
        const text = normalizeWhitespace($(el).text());
        const href = $(el).attr("href") || "";
        const url = absoluteUrl(href, baseUrl);
        return text && url ? `${text}\t${url}` : "";
      })
      .filter(Boolean),
    30,
  ).map((item) => {
    const [text, url] = item.split("\t");
    return { text, url };
  });

  const contentBlocks: string[] = [];
  root.find("h1,h2,h3,p,li,blockquote,td,th").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = normalizeWhitespace($(el).text());
    if (!text || text.length < 3) {
      return;
    }
    if (/^h[1-3]$/.test(tag)) {
      contentBlocks.push(`\n${"#".repeat(Number(tag.slice(1)))} ${text}`);
      return;
    }
    contentBlocks.push(tag === "li" ? `- ${text}` : text);
  });

  const cleanedText = normalizeWhitespace(contentBlocks.join("\n"));
  const facts = extractFacts(cleanedText);

  return {
    title,
    description: description || undefined,
    canonical: canonicalUrl,
    cleanedText,
    headings,
    links,
    facts,
  };
}

function composeMarkdown(input: {
  title: string;
  sourceUrl: string;
  finalUrl: string;
  purpose: string;
  description?: string;
  headings: string[];
  facts: string[];
  body: string;
  links: Array<{ text: string; url: string }>;
}): string {
  return [
    `# ${input.title}`,
    `Source: ${input.sourceUrl}`,
    input.finalUrl !== input.sourceUrl ? `Final URL: ${input.finalUrl}` : "",
    `Purpose: ${input.purpose}`,
    input.description ? `Description: ${input.description}` : "",
    input.headings.length ? `Headings:\n${input.headings.map((item) => `- ${item}`).join("\n")}` : "",
    input.facts.length ? `Key facts:\n${input.facts.map((item) => `- ${item}`).join("\n")}` : "",
    `Main content:\n${input.body}`,
    input.links.length
      ? `Key links:\n${input.links
          .slice(0, 20)
          .map((item) => `- [${item.text}](${item.url})`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchAndParseLocally(url: URL, config: ContextPrepConfig): Promise<PreparedUrlParts> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "HWAI-Context-Prep-MCP/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`URL fetch failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "text/plain";
  const finalUrl = response.url || url.toString();
  const body = await readLimitedResponse(response, config.maxBodyBytes);
  const warnings: string[] = [];

  if (body.truncated) {
    warnings.push("response_truncated_to_service_limit");
  }

  const isHtml = /html/i.test(contentType) || /<html|<!doctype html/i.test(body.text.slice(0, 500));
  const parts = isHtml
    ? htmlToCompactParts(body.text, finalUrl)
    : {
        title: finalUrl,
        description: undefined,
        canonical: undefined,
        cleanedText: normalizeWhitespace(body.text),
        headings: [] as string[],
        links: [] as Array<{ text: string; url: string }>,
        facts: [] as string[],
      };

  if (!isHtml) {
    warnings.push("non_html_content_type");
  }
  if (parts.cleanedText.length < 400) {
    warnings.push("low_text_extraction_volume");
  }
  if (isHtml && isLikelyJsShell(body.text, parts.cleanedText)) {
    warnings.push("likely_js_or_challenge_shell");
  }

  return {
    title: parts.title,
    description: parts.description,
    canonical: parts.canonical,
    cleanedText: parts.cleanedText,
    headings: parts.headings,
    links: parts.links,
    facts: parts.facts,
    contentType,
    finalUrl,
    rawText: body.text,
    warnings,
  };
}

function scraperResultToParts(
  result: ScraperCoreFetchResult,
  sourceUrl: string,
  fallbackReason: string,
): PreparedUrlParts {
  const markdown = normalizeWhitespace(result.markdown || result.text || "");
  const rawText = result.html || result.markdown || result.text || "";
  const cleanedText = markdown || normalizeWhitespace(result.html || "");
  const finalUrl = result.final_url || result.url || sourceUrl;
  const title =
    normalizeWhitespace(result.title || markdown.match(/^#\s+(.+)$/m)?.[1] || finalUrl) || finalUrl;
  const warnings: string[] = [`parser_stack_fallback:${fallbackReason}`];

  if (!cleanedText) {
    warnings.push("scraper_core_empty_markdown");
  }
  if (result.error) {
    warnings.push(`scraper_core_error:${result.error}`);
  }

  return {
    title,
    description:
      typeof result.metadata?.reader_description === "string"
        ? normalizeWhitespace(result.metadata.reader_description)
        : undefined,
    canonical:
      typeof result.metadata?.canonical_url === "string"
        ? String(result.metadata.canonical_url)
        : undefined,
    cleanedText,
    headings: markdownHeadings(markdown),
    links: markdownLinks(markdown),
    facts: extractFacts(cleanedText),
    contentType: "text/markdown; parser=scraper-core",
    finalUrl,
    rawText,
    warnings,
  };
}

function chooseFallbackReason(parts: PreparedUrlParts | null, localError: Error | null): string | null {
  if (localError) {
    return "local_fetch_failed";
  }
  if (!parts) {
    return "local_parser_unavailable";
  }
  if (parts.warnings.includes("likely_js_or_challenge_shell")) {
    return "likely_js_or_challenge_shell";
  }
  if (parts.warnings.includes("low_text_extraction_volume")) {
    return "low_text_extraction_volume";
  }
  if (parts.warnings.includes("non_html_content_type")) {
    return "non_html_content_type";
  }
  return null;
}

export async function prepUrl(
  rawUrl: string,
  config: ContextPrepConfig,
  options: PrepUrlOptions = {},
): Promise<PrepUrlResult> {
  const purpose = options.purpose?.trim() || "prepare URL content for frontier model context";
  const maxCompactChars = options.max_compact_chars || 9_000;
  const parsed = await assertSafePublicUrl(rawUrl, config);
  const parserStack = options.parser_stack || "auto";
  let parts: PreparedUrlParts | null = null;
  let localError: Error | null = null;
  let fallbackReason: string | null = parserStack === "scraper_core" ? "forced_scraper_core" : null;
  let scraperResult: ScraperCoreFetchResult | null = null;
  let usedParser: "local" | "scraper_core" = "local";

  if (parserStack !== "scraper_core") {
    try {
      parts = await fetchAndParseLocally(parsed, config);
      fallbackReason = parserStack === "auto" ? chooseFallbackReason(parts, null) : null;
    } catch (error) {
      localError = error instanceof Error ? error : new Error(String(error));
      fallbackReason = parserStack === "auto" ? chooseFallbackReason(null, localError) : null;
      if (parserStack === "local") {
        throw localError;
      }
    }
  }

  if (fallbackReason) {
    if (config.scraperFallbackMode === "disabled") {
      if (!parts && localError) {
        throw localError;
      }
      if (!parts) {
        throw new Error("scraper-core fallback is disabled");
      }
      parts?.warnings.push("scraper_core_fallback_disabled");
    } else if (!isScraperCoreConfigured(config)) {
      if (!parts && localError) {
        throw new Error(`${localError.message}; scraper-core fallback unavailable: key missing`);
      }
      if (!parts) {
        throw new Error("scraper-core fallback unavailable: key missing");
      }
      parts?.warnings.push("scraper_core_key_missing");
    } else {
      try {
        scraperResult = await fetchWithScraperCore(parsed.toString(), config, {
          allow_paid_tiers: options.allow_paid_tiers,
          country: options.country,
          max_tier: options.max_tier,
          metadata: options.metadata,
          session_id: options.session_id,
        });
        parts = scraperResultToParts(scraperResult, parsed.toString(), fallbackReason);
        usedParser = "scraper_core";
      } catch (error) {
        const scraperError = error instanceof Error ? error : new Error(String(error));
        if (!parts && localError) {
          throw new Error(`${localError.message}; scraper-core fallback failed: ${scraperError.message}`);
        }
        if (!parts) {
          throw new Error(`scraper-core fallback failed: ${scraperError.message}`);
        }
        parts?.warnings.push(`scraper_core_failed:${scraperError.message}`);
      }
    }
  }

  if (!parts) {
    throw new Error("URL parser did not produce content");
  }

  const compactMarkdown = clampText(
    composeMarkdown({
      title: parts.title,
      sourceUrl: parsed.toString(),
      finalUrl: parts.finalUrl,
      purpose,
      description: parts.description,
      headings: parts.headings,
      facts: parts.facts,
      body: clampText(parts.cleanedText, Math.floor(maxCompactChars * 0.62)),
      links: parts.links,
    }),
    maxCompactChars,
  );

  const artifactKey = stableKey("url", `${parts.finalUrl}\n${parts.cleanedText}`);
  const cleanedArtifact = await persistArtifactText(config, artifactKey, "md", parts.cleanedText);
  const manifestArtifact = await persistArtifactJson(config, `${artifactKey}-manifest`, {
    source_url: parsed.toString(),
    final_url: parts.finalUrl,
    purpose,
    title: parts.title,
    description: parts.description,
    canonical_url: parts.canonical,
    content_type: parts.contentType,
    parser_stack: {
      requested: parserStack,
      used: usedParser,
      fallback_reason: usedParser === "scraper_core" ? fallbackReason : undefined,
      scraper_core: scraperResult
        ? {
            cache_hit: scraperResult.cache_hit,
            challenge_detected: scraperResult.challenge_detected,
            duration_ms: scraperResult.duration_ms,
            engine: scraperResult.engine,
            status: scraperResult.status,
            tiers_tried: scraperResult.tiers_tried,
          }
        : undefined,
    },
    headings: parts.headings,
    key_facts: parts.facts,
    key_links: parts.links,
    compact_markdown: compactMarkdown,
    warnings: parts.warnings,
    metadata: options.metadata || null,
  });

  const tokenStats = buildTokenStats(parts.rawText || parts.cleanedText, compactMarkdown);
  const reasons = [...parts.warnings];
  const uncertainty =
    parts.warnings.some((warning) =>
      /low_text_extraction_volume|non_html_content_type|scraper_core_empty_markdown|scraper_core_failed|scraper_core_key_missing|fallback_disabled/.test(
        warning,
      ),
    )
      ? 0.05
      : usedParser === "scraper_core"
        ? 0.025
        : 0.02;

  return {
    schema_version: CONTEXT_PREP_SCHEMA_VERSION,
    pipeline_version: CONTEXT_PREP_PIPELINE_VERSION,
    prep_mode: "url-prep",
    source_url: parsed.toString(),
    final_url: parts.finalUrl,
    purpose,
    title: parts.title,
    description: parts.description,
    canonical_url: parts.canonical,
    content_type: parts.contentType,
    parser_stack: {
      requested: parserStack,
      used: usedParser,
      fallback_reason: usedParser === "scraper_core" ? fallbackReason || undefined : undefined,
      scraper_core: scraperResult
        ? {
            cache_hit: scraperResult.cache_hit,
            challenge_detected: scraperResult.challenge_detected,
            duration_ms: scraperResult.duration_ms,
            engine: scraperResult.engine,
            status: scraperResult.status,
            tiers_tried: scraperResult.tiers_tried,
          }
        : undefined,
    },
    input_stats: tokenStats,
    headings: parts.headings,
    key_facts: parts.facts,
    key_links: parts.links,
    compact_markdown: compactMarkdown,
    warnings: parts.warnings,
    artifacts: {
      cleaned_text_url: cleanedArtifact.url,
      manifest_url: manifestArtifact.url,
    },
    confidence: {
      uncertainty,
      reasons,
    },
    autopilot: {
      requires_clarification: uncertainty > 0.03,
      suggested_action: uncertainty > 0.03 ? "inspect_cleaned_artifact" : "use_compact_markdown",
    },
    prompt_scaffold:
      "Use compact_markdown first. If the task depends on exact wording, pricing/legal details, or extraction warnings are present, inspect cleaned_text_url before final reasoning.",
  };
}
