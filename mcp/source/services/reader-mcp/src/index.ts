#!/usr/bin/env node
/**
 * reader-mcp — HTML → clean markdown for any agent.
 *
 * One tool:
 *   read(html | url, [favor_precision]) → {markdown, text, title, author, date, language, word_count}
 *
 * If `url` is passed, we first call scraper-core /fetch extract_markdown=true.
 * If `html` is passed, we call /extract directly (no fetch, you already have it).
 *
 * Env: HWAI_SCRAPER_KEY, HWAI_SCRAPER_URL
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.HWAI_SCRAPER_URL || 'http://localhost:8090';
const KEY = process.env.HWAI_SCRAPER_KEY || '';
const MCP_NAME = 'reader-mcp';
const MCP_VERSION = '1.1.0';
const CONTEXT = (process.env.HWAI_CONTEXT || `${MCP_NAME}/${randomUUID().slice(0, 8)}`)
  .replace(/(?:token|key|secret|password)=[^&\s]+/gi, '$1=***')
  .slice(0, 64);

function hwaiHeaders(traceId: string) {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'X-HWAI-MCP': `${MCP_NAME}@${MCP_VERSION}`,
    'X-HWAI-Context': CONTEXT,
    'X-HWAI-Trace-Id': traceId,
  } as Record<string, string>;
}

const server = new Server({ name: MCP_NAME, version: MCP_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read',
      description:
        'HTML → clean markdown. Pass `url` to fetch+extract in one call (recommended), or `html` to extract from raw HTML you already have. ' +
        'Pipeline: trafilatura (deterministic, 50ms) → LiteLLM cerebras-llama (400ms) → gemini-2.5-flash → ollama qwen3. ' +
        'Returns {markdown, text, title, author, date, language, word_count}. 10-50x cheaper tokens than feeding raw HTML to the LLM yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch + extract. Uses scraper-core /fetch.' },
          html: { type: 'string', description: 'Raw HTML you already have. Uses scraper-core /extract.' },
          favor_precision: { type: 'boolean', default: true, description: 'trafilatura precision mode (cleaner but may drop edge content)' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  if (name !== 'read') throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  const args = a as any;

  if (!args.url && !args.html) {
    return { content: [{ type: 'text', text: 'Error: pass either `url` or `html`' }], isError: true };
  }

  const traceId = randomUUID().replace(/-/g, '');
  try {
    let data: any;
    if (args.url) {
      const r = await fetch(`${BASE}/fetch`, {
        method: 'POST',
        headers: hwaiHeaders(traceId),
        body: JSON.stringify({ url: args.url, extract_markdown: true }),
      });
      if (!r.ok) throw new Error(`scraper-core /fetch ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const d = (await r.json()) as any;
      data = {
        markdown: d.markdown,
        text: d.text,
        title: d.title,
        author: d.metadata?.reader_author,
        date: d.metadata?.reader_date,
        language: d.metadata?.reader_lang,
        word_count: d.metadata?.reader_words,
        engine: d.engine,
        cache_hit: d.cache_hit,
      };
    } else {
      const r = await fetch(`${BASE}/extract`, {
        method: 'POST',
        headers: hwaiHeaders(traceId),
        body: JSON.stringify({ html: args.html, favor_precision: args.favor_precision ?? true }),
      });
      if (!r.ok) throw new Error(`scraper-core /extract ${r.status}: ${(await r.text()).slice(0, 300)}`);
      data = await r.json();
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`reader-mcp connected — base=${BASE}, key=${KEY ? 'set' : 'MISSING'}`);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
