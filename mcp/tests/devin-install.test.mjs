import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('Devin core dry-run advertises project MCP config and agent instructions without writes', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'devin-install-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [join(repo, 'mcp/bin/hwai-mcp.mjs'), 'install',
    `--manifest=${join(repo, 'mcp/manifest.json')}`, `--source-root=${repo}`,
    `--workspace=${workspace}`, '--dry-run', '--skip-build', '--clients=devin', '--profile=core'],
  { cwd: workspace, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `Devin installer must accept client: ${result.stderr}`);
  assert.ok(result.stdout.includes(join(workspace, '.devin', 'mcp_config.json')), result.stdout);
  assert.ok(result.stdout.includes(join(workspace, 'AGENTS.md')), result.stdout);
  assert.deepEqual(readdirSync(workspace), [], 'dry-run must not write project files');
});
