import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('Devin install merges unrelated config and repeated install is idempotent', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'devin-merge-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace'); const home = join(base, 'home'); const source = join(base, 'source');
  for (const dir of [workspace, home, source, join(workspace, '.devin'), join(source, 'service')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, 'service/package.json'), JSON.stringify({ scripts: { build: 'true', smoke: 'true', 'measurement:report': 'true' } }));
  const stdio = join(source, 'service/local-stdio.sh'); writeFileSync(stdio, '#!/bin/sh\nexit 0\n'); chmodSync(stdio, 0o755);
  const manifest = join(base, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ workspace_env_file: '$HOME/.hwai/mcp-stack/env',
    profiles: { core: { services: ['fixture-mcp'] } },
    services: { 'fixture-mcp': { client_name: 'fixture', service_dir: 'service', stdio: 'service/local-stdio.sh' } } }));
  const configPath = join(workspace, '.devin/mcp_config.json');
  const unrelated = { command: 'existing-tool', args: ['--keep'], env: { EXISTING: 'preserved' } };
  writeFileSync(configPath, JSON.stringify({ setting: 'preserved', mcpServers: { unrelated } }));
  writeFileSync(join(workspace, 'AGENTS.md'), '# Existing instructions\nKeep this sentence.\n');
  function install() {
    const result = spawnSync(process.execPath, [join(repo, 'mcp/bin/hwai-mcp.mjs'), 'install',
      `--manifest=${manifest}`, `--source-root=${source}`, `--workspace=${workspace}`,
      '--skip-build', '--clients=devin', '--profile=core'],
    { cwd: workspace, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  install();
  const firstConfig = readFileSync(configPath, 'utf8'); const config = JSON.parse(firstConfig);
  assert.deepEqual(config.mcpServers.unrelated, unrelated);
  assert.equal(config.setting, 'preserved');
  assert.equal(config.mcpServers.fixture.command, 'bash');
  assert.deepEqual(config.mcpServers.fixture.args, [stdio]);
  assert.equal(config.mcpServers.fixture.env.HWAI_CONTEXT, 'devin/hwai-mcp-stack');
  assert.equal(config.mcpServers.fixture.env.HWAI_MCP_ENV_FILE, join(home, '.hwai/mcp-stack/env'));
  const firstAgents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  assert.ok(firstAgents.includes('Keep this sentence.'));
  assert.equal(firstAgents.split('<!-- BEGIN HUMANSWITHAI_MCP_AUTOPILOT -->').length - 1, 1);
  install();
  assert.equal(readFileSync(configPath, 'utf8'), firstConfig);
  assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), firstAgents);
});
