#!/usr/bin/env node
/**
 * searxng-mcp — aggregated SERP for agents.
 * Routes through scraper-core /serp (which proxies self-hosted SearXNG +
 * optionally enriches via Decodo+Camoufox Google fetch).
 *
 * Tool: search(query, engines?, country?, count?, fields?, categories?)
 *
 * Env: HWAI_SCRAPER_KEY, HWAI_SCRAPER_URL (default http://127.0.0.1:8090)
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.HWAI_SCRAPER_URL || 'http://127.0.0.1:8090';
const KEY = process.env.HWAI_SCRAPER_KEY || '';
const MCP_NAME = 'searxng-mcp';
const MCP_VERSION = '1.1.0';
const CONTEXT = (process.env.HWAI_CONTEXT || `${MCP_NAME}/${randomUUID().slice(0, 8)}`)
  .replace(/(?:token|key|secret|password)=[^&\s]+/gi, '$1=***')
  .slice(0, 64);

const server = new Server({ name: MCP_NAME, version: MCP_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description:
        'Aggregated SERP across 15+ engines (Google, Bing, Brave, DuckDuckGo, Yandex, Qwant, Mojeek, Ecosia, ...) via self-hosted SearXNG. ' +
        'Use THIS instead of scraping Google directly or calling paid SerpAPI/Serper. ' +
        'Optional enrichment extracts Google People Also Ask, related searches, AI Overview, featured snippet — best-effort (Google bot-detects Decodo IPs ~40% of time; enriched=true means we got clean HTML).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          engines: {
            type: 'string',
            default: 'google,brave,bing,duckduckgo',
            description: 'Comma-separated engine names. Available: google, brave, bing, duckduckgo, startpage, qwant, mojeek, yandex, ecosia, google+news, bing+news, google+scholar, youtube',
          },
          country: { type: 'string', description: 'ISO code: US, GB, DE, RU, AE, ...' },
          categories: { type: 'string', description: 'general, news, images, videos, it, science' },
          count: { type: 'integer', default: 10, minimum: 1, maximum: 30 },
          fields: {
            type: 'string',
            default: 'results,paa,related,featured_snippet,ai_overview,answer_box',
            description: 'Comma-separated: results | paa | related | featured_snippet | ai_overview | answer_box. Set "results" only for fast path (~900ms). Include enrichment fields for ~4-8s Google-via-Decodo pass.',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (name !== 'search') throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  const args = a as any;

  const qs = new URLSearchParams({
    q: args.query,
    engines: args.engines || 'google,brave,bing,duckduckgo',
    count: String(args.count ?? 10),
    fields: args.fields || 'results,paa,related,featured_snippet,ai_overview,answer_box',
  });
  if (args.country) qs.set('country', args.country);
  if (args.categories) qs.set('categories', args.categories);

  const traceId = randomUUID().replace(/-/g, '');
  try {
    const r = await fetch(`${BASE}/serp?${qs.toString()}`, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'X-HWAI-MCP': `${MCP_NAME}@${MCP_VERSION}`,
        'X-HWAI-Context': CONTEXT,
        'X-HWAI-Trace-Id': traceId,
      },
    });
    if (!r.ok) throw new Error(`scraper-core /serp ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = (await r.json()) as any;
    // Compact summary first, then details
    const summary = {
      query: data.query,
      engines_used: data.engines_used,
      result_count: (data.results || []).length,
      paa_count: (data.paa || []).length,
      related_count: (data.related || []).length,
      has_ai_overview: !!data.ai_overview,
      has_featured_snippet: !!data.featured_snippet,
      enriched: data.enriched,
      duration_ms: data.duration_ms,
    };
    return {
      content: [
        { type: 'text', text: JSON.stringify(summary, null, 2) },
        { type: 'text', text: JSON.stringify({ results: data.results, paa: data.paa, related: data.related, featured_snippet: data.featured_snippet, ai_overview: data.ai_overview, answer_box: data.answer_box }, null, 2) },
      ],
    };
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`searxng-mcp connected — base=${BASE}, key=${KEY ? 'set' : 'MISSING'}`);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
