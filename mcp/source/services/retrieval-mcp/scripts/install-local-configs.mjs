#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DEFAULT_AGENTS = ["codex", "claude", "cursor", "windsurf"];

function argValue(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return exact ? exact.slice(name.length + 3) : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function backup(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const backupPath = `${filePath}.bak.retrieval-${nowStamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeFile(filePath, content, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] would write ${filePath}`);
    return;
  }
  ensureDir(filePath);
  fs.writeFileSync(filePath, content);
  console.log(`updated ${filePath}`);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function retrievalServer(stdioPath) {
  return {
    command: "bash",
    args: [stdioPath],
    env: {},
  };
}

function installProjectJson(filePath, stdioPath, dryRun, extra = {}) {
  const data = readJson(filePath, { mcpServers: {} });
  data.mcpServers = data.mcpServers || {};
  data.mcpServers.retrieval = {
    ...retrievalServer(stdioPath),
    ...extra,
  };
  if (!dryRun) {
    const backupPath = backup(filePath);
    if (backupPath) {
      console.log(`backup ${backupPath}`);
    }
  }
  writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, dryRun);
}

function installCodex(repoRoot, stdioPath, dryRun) {
  const filePath = path.join(os.homedir(), ".codex", "config.toml");
  const block = [
    "[mcp_servers.retrieval]",
    'command = "bash"',
    `args = [${JSON.stringify(stdioPath)}]`,
    "env = {}",
    "",
  ].join("\n");
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const stripped = existing.replace(/\n?\[mcp_servers\.retrieval\][\s\S]*?(?=\n\[|\s*$)/m, "\n").trimEnd();
  const next = `${stripped ? `${stripped}\n\n` : ""}${block}`;
  if (!dryRun) {
    const backupPath = backup(filePath);
    if (backupPath) {
      console.log(`backup ${backupPath}`);
    }
  }
  writeFile(filePath, next, dryRun);
}

function installClaude(repoRoot, stdioPath, dryRun) {
  const filePath = path.join(os.homedir(), ".claude.json");
  const data = readJson(filePath, { projects: {} });
  data.projects = data.projects || {};

  const projectKeys = Object.keys(data.projects).filter((projectPath) => {
    const resolved = path.resolve(projectPath);
    return resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`);
  });
  const targets = projectKeys.length > 0 ? projectKeys : [repoRoot];

  for (const projectPath of targets) {
    data.projects[projectPath] = data.projects[projectPath] || {};
    data.projects[projectPath].mcpServers = data.projects[projectPath].mcpServers || {};
    data.projects[projectPath].mcpServers.retrieval = retrievalServer(stdioPath);
  }

  if (!dryRun) {
    const backupPath = backup(filePath);
    if (backupPath) {
      console.log(`backup ${backupPath}`);
    }
  }
  writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, dryRun);
  console.log(`claude project entries touched: ${targets.length}`);
}

function installCursor(repoRoot, stdioPath, dryRun) {
  installProjectJson(path.join(repoRoot, ".cursor", "mcp.json"), stdioPath, dryRun);
}

function installWindsurf(repoRoot, stdioPath, dryRun) {
  installProjectJson(path.join(repoRoot, ".windsurf", "mcp.json"), stdioPath, dryRun, {
    description: "Local-first codebase retrieval for ranked files and line-anchored snippets",
  });
}

function usage() {
  console.log(`Usage: node services/retrieval-mcp/scripts/install-local-configs.mjs [options]

Options:
  --agents=codex,claude,cursor,windsurf  Agents to configure. Default: all.
  --repo-root=/absolute/path             Repo root. Default: detected from script path.
  --dry-run                              Print actions without writing files.

This script only installs the local retrieval MCP server. It creates backups before modifying existing config files.
`);
}

if (hasFlag("help") || hasFlag("h")) {
  usage();
  process.exit(0);
}

const repoRoot = path.resolve(argValue("repo-root") || DEFAULT_REPO_ROOT);
const agents = (argValue("agents") || DEFAULT_AGENTS.join(","))
  .split(",")
  .map((agent) => agent.trim().toLowerCase())
  .filter(Boolean);
const dryRun = hasFlag("dry-run");
const stdioPath = path.join(repoRoot, "services", "retrieval-mcp", "scripts", "local-stdio.sh");

if (!fs.existsSync(stdioPath)) {
  console.error(`retrieval stdio wrapper not found: ${stdioPath}`);
  process.exit(1);
}

const installers = {
  claude: () => installClaude(repoRoot, stdioPath, dryRun),
  codex: () => installCodex(repoRoot, stdioPath, dryRun),
  cursor: () => installCursor(repoRoot, stdioPath, dryRun),
  windsurf: () => installWindsurf(repoRoot, stdioPath, dryRun),
};

for (const agent of agents) {
  const install = installers[agent];
  if (!install) {
    console.error(`unknown agent: ${agent}`);
    usage();
    process.exit(1);
  }
  install();
}

console.log("retrieval MCP local config install complete");
