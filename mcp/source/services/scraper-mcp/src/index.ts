#!/usr/bin/env node
/**
 * scraper-mcp — stdio MCP wrapper over scraper-core HTTP API.
 *
 * Tools:
 *   - fetch_url(url, extract_markdown?, session_id?, country?, max_tier?, bypass_cache?)
 *   - extract_markdown(html, url?)
 *   - health()
 *   - keyring_stats()
 *
 * Bearer auth sourced from env HWAI_SCRAPER_KEY (per-user key).
 * Base URL sourced from env HWAI_SCRAPER_URL (default http://localhost:8090).
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.HWAI_SCRAPER_URL || 'http://localhost:8090';
const KEY = process.env.HWAI_SCRAPER_KEY || '';
const YT_BASE = process.env.HWAI_YT_TRANSCRIBE_URL || 'http://localhost:8091';
const YT_KEY = process.env.HWAI_YT_TRANSCRIBE_KEY || '';
const MCP_NAME = 'scraper-mcp';
const MCP_VERSION = '1.1.0';
// Per-session context tag. Set by wrapper/launch script, e.g.
// HWAI_CONTEXT="claude-code/chat-abc123". Truncated to 64 chars, stripped
// of obvious secrets, so downstream JSONL can group calls by agent session.
const CONTEXT = (process.env.HWAI_CONTEXT || `${MCP_NAME}/${randomUUID().slice(0, 8)}`)
  .replace(/(?:token|key|secret|password)=[^&\s]+/gi, '$1=***')
  .slice(0, 64);

if (!KEY) {
  console.error('scraper-mcp: HWAI_SCRAPER_KEY env missing — calls will 401');
}

const server = new Server(
  { name: MCP_NAME, version: MCP_VERSION },
  { capabilities: { tools: {} } }
);

function hwaiTelemetryHeaders(traceId: string): Record<string, string> {
  return {
    'X-HWAI-MCP': `${MCP_NAME}@${MCP_VERSION}`,
    'X-HWAI-Context': CONTEXT,
    'X-HWAI-Trace-Id': traceId,
  };
}

async function callScraperCore(path: string, options: RequestInit = {}, traceId: string): Promise<any> {
  const url = `${BASE}${path}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...hwaiTelemetryHeaders(traceId),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`scraper-core ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function callYTTranscribe(path: string, options: RequestInit = {}, traceId: string): Promise<any> {
  const url = `${YT_BASE}${path}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${YT_KEY}`,
      'Content-Type': 'application/json',
      ...hwaiTelemetryHeaders(traceId),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`youtube-transcribe ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'fetch_url',
      description:
        'Fetch any URL via the 7-tier escalation pipeline. Use this INSTEAD of raw WebFetch/curl/fetch() when the page might be JS-heavy, behind Cloudflare/DataDome, or when you want clean markdown for LLM context. Returns {engine, status, markdown, text, html, metadata, tiers_tried, cache_hit, duration_ms}. Cache is keyed by canonical URL — same URL within 6h = free.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch (http/https)' },
          extract_markdown: {
            type: 'boolean',
            default: true,
            description: 'Run trafilatura+LiteLLM reader chain and populate `markdown` field. Default true. Set false if you only need raw HTML.',
          },
          session_id: {
            type: 'string',
            description: 'Sticky-session key — same id across a batch reuses Decodo IP + Camoufox fingerprint + persistent profile. Saves cost, raises success rate.',
          },
          country: { type: 'string', description: 'Proxy geo, e.g. "US", "GB", "RU", "AE"' },
          max_tier: {
            type: 'string',
            enum: ['firstparty', 'curl_cffi', 'httpx_warm', 'patchright', 'camoufox'],
            default: 'camoufox',
            description: 'Clamp escalation ceiling. Default "camoufox". Set "curl_cffi" to forbid browser tiers (faster, free).',
          },
          force_tier: {
            type: 'string',
            enum: ['firstparty', 'curl_cffi', 'httpx_warm', 'patchright', 'camoufox'],
            description: 'Run exactly this tier, skip escalation. For debugging or red-team tests.',
          },
          bypass_cache: { type: 'boolean', default: false },
          wait_for_selector: {
            type: 'string',
            description: 'Playwright selector to wait for before capturing HTML (L3/L4 only). E.g. "h3" for Google SERP.',
          },
          timeout_seconds: { type: 'integer' },
        },
        required: ['url'],
      },
    },
    {
      name: 'extract_markdown',
      description:
        'Convert raw HTML you already have to clean markdown via the trafilatura → Cerebras → Gemini → Ollama chain. Use when you fetched HTML yourself and want to normalize it for LLM context.',
      inputSchema: {
        type: 'object',
        properties: {
          html: { type: 'string' },
          url: { type: 'string', description: 'Source URL — helps trafilatura resolve relative links' },
          favor_precision: { type: 'boolean', default: true },
        },
        required: ['html'],
      },
    },
    {
      name: 'extract_structured',
      description:
        'Phase 4.4 — Pydantic schema-driven structured extraction. Takes a bundled schema reference (e.g. "product_pricing@v1", "company_contact@v1", "article@v1", "review@v1", "event_schedule@v1") or an inline schema definition, plus a URL or raw HTML, and returns typed fields via CSS selectors with LLM fallback through LiteLLM cerebras-llama when N+ fields miss. Reusable extraction templates — use this instead of hand-rolling per-site parsers.',
      inputSchema: {
        type: 'object',
        properties: {
          schema_ref: {
            type: 'string',
            description: 'Bundled schema reference. Available: product_pricing@v1, company_contact@v1, article@v1, review@v1, event_schedule@v1',
          },
          schema: {
            type: 'object',
            description: 'Inline schema definition. See configs/extract_schemas/README.md for DSL. Use either this OR schema_ref, not both.',
          },
          url: { type: 'string', description: 'URL to fetch (goes through 7-tier pipeline first)' },
          html: { type: 'string', description: 'Raw HTML if you already fetched it' },
          country: { type: 'string' },
          force_llm_fallback: {
            type: 'boolean',
            default: false,
            description: 'Force LLM fallback even when CSS covers most fields. Use for eval / benchmarking.',
          },
        },
      },
    },
    {
      name: 'health',
      description: 'scraper-core liveness + per-tier + per-keypool status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'keyring_stats',
      description:
        'Per-provider pool usage (daily + monthly tokens/requests, exhausted key count). Call before heavy batches to verify quota headroom.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'youtube_transcribe',
      description:
        'Transcribe a YouTube video via HWAI youtube-transcribe-api. Tier cascade: (T1) yt-dlp native subs — manual > auto, <5s, $0 — covers ~90% of popular videos; (T2) local WhisperX large-v3 int8 on cx43 (RU+EN quality, ~1× realtime, optional pyannote diarization); (T3) Groq whisper-large-v3-turbo fallback for OOM/>2h/when allow_cloud=true. Adds LLM summary + timestamp-citation URLs by default. USE THIS instead of raw WebFetch when given a youtube.com/youtu.be URL and the caller wants content of the video. Async by default — returns job_id; poll `youtube_transcribe_status`. For <10min clips pass `wait=true`.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube URL (watch / youtu.be / shorts / embed)' },
          lang: { type: 'string', default: 'auto', description: '"ru", "en", or "auto"' },
          with_diarization: { type: 'boolean', default: false, description: 'Assign speaker labels (who said what) — adds ~30s, useful for interviews/podcasts.' },
          with_summary: { type: 'boolean', default: true, description: 'LLM post-process: summary + key_points + 3-6 timestamp-linked citations.' },
          allow_cloud: { type: 'boolean', default: true, description: 'Permit Groq API fallback. Set false for sensitive/private videos — stays 100% on HWAI infra.' },
          bypass_cache: { type: 'boolean', default: false, description: 'Re-transcribe even if cached (30-day TTL).' },
          wait: { type: 'boolean', default: false, description: 'If true, block and return full result (only for short <10min videos). If false, return job_id and poll via youtube_transcribe_status.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'youtube_transcribe_status',
      description:
        'Check status of an async youtube_transcribe job. Returns {status: queued|running|finished|failed, result?, error?}. Poll every 10-30s; a 30-min RU video finishes in ~30-45min on cx43 local, <1min on Groq fallback.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'youtube_transcribe_health',
      description: 'youtube-transcribe-api liveness + queue depth + RAM headroom + cookies freshness.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // One trace-id per tool invocation. All downstream scraper-core calls
  // inherit it, so you can jq the JSONL by trace_id for a single flow.
  const traceId = randomUUID().replace(/-/g, '');

  try {
    if (name === 'fetch_url') {
      const a = (args || {}) as any;
      const data = await callScraperCore('/fetch', {
        method: 'POST',
        body: JSON.stringify({
          url: a.url,
          extract_markdown: a.extract_markdown ?? true,
          session_id: a.session_id,
          country: a.country,
          max_tier: a.max_tier ?? 'camoufox',
          force_tier: a.force_tier,
          bypass_cache: a.bypass_cache ?? false,
          wait_for_selector: a.wait_for_selector,
          timeout_seconds: a.timeout_seconds,
        }),
      }, traceId);
      // Summarize for agent — avoid dumping 897KB HTML to context by default.
      const summary = {
        url: data.url,
        final_url: data.final_url,
        status: data.status,
        engine: data.engine,
        tiers_tried: data.tiers_tried,
        challenge_detected: data.challenge_detected,
        duration_ms: data.duration_ms,
        cache_hit: data.cache_hit,
        title: data.title,
        metadata: data.metadata,
        markdown_chars: (data.markdown || '').length,
        text_chars: (data.text || '').length,
        html_chars: (data.html || '').length,
        error: data.error,
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(summary, null, 2) },
          // Full markdown is what the agent actually wants to consume
          ...(data.markdown
            ? [{ type: 'text', text: `\n---markdown---\n${data.markdown}` }]
            : []),
        ],
      };
    }

    if (name === 'extract_markdown') {
      const a = (args || {}) as any;
      const data = await callScraperCore('/extract', {
        method: 'POST',
        body: JSON.stringify({
          html: a.html,
          url: a.url,
          favor_precision: a.favor_precision ?? true,
        }),
      }, traceId);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === 'extract_structured') {
      const a = (args || {}) as any;
      const body: Record<string, unknown> = {};
      if (a.schema_ref) body.schema_ref = a.schema_ref;
      if (a.schema) body.schema = a.schema;
      if (a.url) body.url = a.url;
      if (a.html) body.html = a.html;
      if (a.country) body.country = a.country;
      if (a.force_llm_fallback) body.force_llm_fallback = a.force_llm_fallback;
      const data = await callScraperCore('/extract-structured', {
        method: 'POST',
        body: JSON.stringify(body),
      }, traceId);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }

    if (name === 'health') {
      const data = await callScraperCore('/health', { method: 'GET' }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'keyring_stats') {
      const data = await callScraperCore('/keyring/stats', { method: 'GET' }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'youtube_transcribe') {
      const a = (args || {}) as any;
      const body = {
        url: a.url,
        lang: a.lang ?? 'auto',
        with_diarization: !!a.with_diarization,
        with_summary: a.with_summary ?? true,
        allow_cloud: a.allow_cloud ?? true,
        bypass_cache: !!a.bypass_cache,
      };
      const path = a.wait ? '/transcribe' : '/jobs';
      const data = await callYTTranscribe(path, { method: 'POST', body: JSON.stringify(body) }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'youtube_transcribe_status') {
      const a = (args || {}) as any;
      const data = await callYTTranscribe(`/jobs/${encodeURIComponent(a.job_id)}`, { method: 'GET' }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'youtube_transcribe_health') {
      const data = await callYTTranscribe('/health', { method: 'GET' }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (e: any) {
    return {
      content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`scraper-mcp connected — base=${BASE}, key=${KEY ? 'set' : 'MISSING'}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
