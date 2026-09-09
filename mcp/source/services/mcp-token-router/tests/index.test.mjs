/**
 * index.ts shell tests — verifies the MCP server module imports cleanly
 * without throwing, which means the tool schemas, dispatch wiring, and
 * SDK imports are all syntactically + semantically valid.
 *
 * Deep end-to-end (stdio handshake) lives in scripts/local-stdio.sh
 * smoke tests + the README "stdio handshake proof" — those are
 * integration concerns, not unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'index.js');

test('MCP server responds to initialize + tools/list with the documented surface', async () => {
  const proc = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n',
  );
  proc.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
  );
  // Wait for both responses then close stdin
  await new Promise((resolve) => {
    const check = () => {
      if (stdout.split('\n').filter(Boolean).length >= 2) resolve();
      else setTimeout(check, 20);
    };
    check();
  });
  proc.stdin.end();
  await new Promise((resolve) => proc.on('close', resolve));

  const lines = stdout.split('\n').filter(Boolean);
  const initResp = JSON.parse(lines[0]);
  const listResp = JSON.parse(lines[1]);

  assert.equal(initResp.result.serverInfo.name, 'mcp-token-router');
  const toolNames = listResp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ['list_routes', 'route_compression']);
});
