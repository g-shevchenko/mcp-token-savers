#!/usr/bin/env node
/**
 * crawl4ai-mcp — stdio MCP wrapper for Crawl4AI service.
 *
 * Tools:
 *   crawl(urls, crawl_config?)    — crawl 1+ URLs, return structured results
 *   extract_structured(url, schema) — LLM-backed extraction against a Pydantic schema
 *   generate_llmstxt(url)         — crawl site + emit llms.txt
 *
 * Env: HWAI_CRAWL4AI_URL (default http://127.0.0.1:11235),
 *      HWAI_CRAWL4AI_TOKEN (api_token used to mint JWTs).
 *      HWAI_CRAWL4AI_EMAIL (email claim for JWT subject, default user@example.com).
 *
 * Auth: service runs with security.jwt_enabled=true (see services/crawl4ai-service/
 * overrides/config.yml). Raw api_token is NOT accepted as Bearer — we POST /token
 * with {email, api_token} to mint a JWT (60-min lifetime, signed with SECRET_KEY),
 * cache it in-process, refresh on 401 or <60s to expiry.
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.HWAI_CRAWL4AI_URL || 'http://127.0.0.1:11235';
const API_TOKEN = process.env.HWAI_CRAWL4AI_TOKEN || '';
const EMAIL = process.env.HWAI_CRAWL4AI_EMAIL || 'user@example.com';
const MCP_NAME = 'crawl4ai-mcp';
const MCP_VERSION = '1.2.0';
const CONTEXT = (process.env.HWAI_CONTEXT || `${MCP_NAME}/${randomUUID().slice(0, 8)}`)
  .replace(/(?:token|key|secret|password)=[^&\s]+/gi, '$1=***')
  .slice(0, 64);

const server = new Server({ name: MCP_NAME, version: MCP_VERSION }, { capabilities: { tools: {} } });

// JWT cache: minted via POST /token, expires 60 min (hardcoded in /app/auth.py).
// Refresh when <60s to expiry or on any 401 from crawl4ai.
let jwtCache: { token: string; expiresAt: number } | null = null;

async function mintJwt(): Promise<string> {
  if (!API_TOKEN) throw new Error('HWAI_CRAWL4AI_TOKEN not set — cannot mint JWT');
  const r = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, api_token: API_TOKEN }),
  });
  if (!r.ok) throw new Error(`crawl4ai /token ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = (await r.json()) as { access_token?: string; token?: string };
  const token = data.access_token || data.token;
  if (!token) throw new Error(`crawl4ai /token returned no access_token: ${JSON.stringify(data).slice(0, 200)}`);
  // Refresh 60s before server's 60-min expiry
  jwtCache = { token, expiresAt: Date.now() + (60 * 60 - 60) * 1000 };
  return token;
}

async function getJwt(): Promise<string> {
  if (jwtCache && Date.now() < jwtCache.expiresAt) return jwtCache.token;
  return mintJwt();
}

async function call(path: string, body: any | undefined, traceId: string, retried = false): Promise<any> {
  const jwt = await getJwt();
  const r = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'X-HWAI-MCP': `${MCP_NAME}@${MCP_VERSION}`,
      'X-HWAI-Context': CONTEXT,
      'X-HWAI-Trace-Id': traceId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !retried) {
    jwtCache = null; // Force re-mint
    return call(path, body, traceId, true);
  }
  if (!r.ok) throw new Error(`crawl4ai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as any;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'crawl',
      description:
        'Crawl one or more URLs via Crawl4AI. Good for: multi-page site walks, parallel URL batches, getting markdown + structured metadata at once. LLM extraction routes through LiteLLM proxy — Gemini 2.5 Flash primary, Groq llama-3.3-70b + Cerebras-llama fallbacks (all free-tier pools, $0/page).',
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'URL list' },
          crawl_config: {
            type: 'object',
            description: 'Crawl4AI CrawlerRunConfig — cache_mode, word_count_threshold, etc.',
          },
        },
        required: ['urls'],
      },
    },
    {
      name: 'extract_structured',
      description:
        'LLM-backed structured extraction against a Pydantic-style schema. E.g. pass `{"name":"str","price":"float"}` and the URL of a product page — crawl4ai returns `{name: "...", price: 49.99}`. Uses Gemini 2.5 Flash via LiteLLM proxy (auto-fallback to Groq / Cerebras / local Ollama).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          schema: { type: 'object', description: 'Pydantic-style field spec' },
          instruction: { type: 'string', description: 'Optional extraction instruction (defaults to "extract all fields")' },
        },
        required: ['url', 'schema'],
      },
    },
    {
      name: 'generate_llmstxt',
      description:
        'Walk a site and emit llms.txt (AI-discoverable index). Replaces Firecrawl `/llmstxt` with our self-hosted equivalent. Returns the markdown content; caller can upload to the target site or cache for later.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Root URL to crawl' },
          max_pages: { type: 'integer', default: 50 },
        },
        required: ['url'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const args = a as any;
  const traceId = randomUUID().replace(/-/g, '');

  try {
    if (name === 'crawl') {
      const d = await call('/crawl', { urls: args.urls, crawl_config: args.crawl_config || { cache_mode: 'bypass' } }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    }
    if (name === 'extract_structured') {
      // Crawl4AI supports LLMExtractionStrategy via /crawl with extraction_strategy param.
      const d = await call('/crawl', {
        urls: [args.url],
        extraction_strategy: {
          type: 'llm',
          provider: 'openai/cerebras-llama',
          schema: args.schema,
          instruction: args.instruction || 'Extract all fields defined in the schema.',
        },
      }, traceId);
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    }
    if (name === 'generate_llmstxt') {
      // Crawl4AI exposes /llms_txt when enabled; fall back to /crawl with max_depth.
      let d: any;
      try {
        d = await call('/llms_txt', { url: args.url, max_pages: args.max_pages ?? 50 }, traceId);
      } catch {
        // Fallback path: crawl + concat markdown
        d = await call('/crawl', {
          urls: [args.url],
          crawl_config: { max_pages: args.max_pages ?? 50, scan_full_page: true },
        }, traceId);
      }
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }] };
    }
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`crawl4ai-mcp connected — base=${BASE}, api_token=${API_TOKEN ? 'set' : 'MISSING'}, email=${EMAIL}`);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
