#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const DEFAULT_CLIENTS = ["claude", "codex", "cursor", "windsurf"];
const DEFAULT_PROFILE = "core";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function readJson(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data, dryRun) {
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`, dryRun);
}

function writeText(filePath, content, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] would write ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.hwai-mcp-${nowStamp()}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`backup ${backupPath}`);
  }
  fs.writeFileSync(filePath, content);
  console.log(`updated ${filePath}`);
}

function expandHome(label) {
  return label.replace(/^\$HOME(?=\/|$)/, os.homedir());
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

function loadManifest() {
  const manifestPath = path.resolve(argValue("manifest", path.join(process.cwd(), "manifest.json")));
  return { manifestPath, manifest: readJson(manifestPath) };
}

function resolveProfile(manifest, profileName, seen = new Set()) {
  const profile = manifest.profiles[profileName];
  if (!profile) {
    throw new Error(`unknown profile: ${profileName}`);
  }
  if (seen.has(profileName)) {
    throw new Error(`profile inheritance cycle at ${profileName}`);
  }
  seen.add(profileName);
  const out = [];
  for (const parent of profile.extends || []) {
    out.push(...resolveProfile(manifest, parent, new Set(seen)));
  }
  out.push(...(profile.services || []));
  return [...new Set(out)];
}

function selectedClients(value) {
  if (!value || value === "auto") {
    return DEFAULT_CLIENTS;
  }
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function serviceConfig(manifest, serviceId, sourceRoot, client, envFile) {
  const service = manifest.services[serviceId];
  if (!service) {
    throw new Error(`profile references unknown service: ${serviceId}`);
  }
  return {
    id: serviceId,
    clientName: service.client_name || serviceId.replace(/-/g, "_"),
    command: "bash",
    args: [path.join(sourceRoot, service.stdio)],
    env: {
      HWAI_MCP_ENV_FILE: envFile,
      HWAI_CONTEXT: `${client}/hwai-mcp-stack`,
    },
    meta: service,
  };
}

function projectJsonServer(item) {
  return {
    command: item.command,
    args: item.args,
    env: item.env,
  };
}

function installProjectJson(filePath, items, dryRun) {
  const data = readJson(filePath, { mcpServers: {} });
  data.mcpServers = data.mcpServers || {};
  for (const item of items) {
    data.mcpServers[item.clientName] = projectJsonServer(item);
  }
  writeJson(filePath, data, dryRun);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlEnv(env) {
  const pairs = Object.entries(env || {}).map(([key, value]) => `${key} = ${tomlString(value)}`);
  return `{ ${pairs.join(", ")} }`;
}

function stripCodexBlocks(existing, names) {
  let text = existing;
  for (const name of names) {
    const pattern = new RegExp(`\\n?\\[mcp_servers\\.${name}\\][\\s\\S]*?(?=\\n\\[|\\s*$)`, "m");
    text = text.replace(pattern, "\n");
  }
  return text.trimEnd();
}

function installCodex(items, dryRun) {
  const filePath = path.join(os.homedir(), ".codex", "config.toml");
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const stripped = stripCodexBlocks(existing, items.map((item) => item.clientName));
  const blocks = items.map((item) => [
    `[mcp_servers.${item.clientName}]`,
    `command = ${tomlString(item.command)}`,
    `args = [${item.args.map(tomlString).join(", ")}]`,
    `env = ${tomlEnv(item.env)}`,
    "",
  ].join("\n"));
  writeText(filePath, `${stripped ? `${stripped}\n\n` : ""}${blocks.join("\n")}`, dryRun);
}

function installClaude(workspace, items, dryRun) {
  const filePath = path.join(os.homedir(), ".claude.json");
  const data = readJson(filePath, { projects: {} });
  data.projects = data.projects || {};
  const resolvedWorkspace = path.resolve(workspace);
  const projectKeys = Object.keys(data.projects).filter((projectPath) => {
    const resolved = path.resolve(projectPath);
    return resolved === resolvedWorkspace || resolved.startsWith(`${resolvedWorkspace}${path.sep}`);
  });
  const targets = projectKeys.length > 0 ? projectKeys : [resolvedWorkspace];
  for (const projectPath of targets) {
    data.projects[projectPath] = data.projects[projectPath] || {};
    data.projects[projectPath].mcpServers = data.projects[projectPath].mcpServers || {};
    for (const item of items) {
      data.projects[projectPath].mcpServers[item.clientName] = projectJsonServer(item);
    }
  }
  writeJson(filePath, data, dryRun);
  console.log(`claude project entries touched: ${targets.length}`);
}

function ensureEnvFile(manifest, services, envFile, dryRun) {
  const required = [...new Set(services.flatMap((serviceId) => manifest.services[serviceId]?.required_env || []))];
  const optional = [...new Set(services.flatMap((serviceId) => manifest.services[serviceId]?.optional_env || []))];
  const lines = [
    "# Humanswith.ai MCP Stack local env.",
    "# Fill per-user secrets here. Do not commit this file.",
    "HWAI_SCRAPER_URL=http://localhost:8090",
    "HWAI_CRAWL4AI_URL=http://localhost:11235",
  ];
  for (const key of required) {
    if (!lines.some((line) => line.startsWith(`${key}=`))) {
      lines.push(`${key}=`);
    }
  }
  for (const key of optional) {
    if (!lines.some((line) => line.startsWith(`${key}=`))) {
      lines.push(`# ${key}=`);
    }
  }
  if (fs.existsSync(envFile)) {
    console.log(`env file exists: ${envFile}`);
    return;
  }
  writeText(envFile, `${lines.join("\n")}\n`, dryRun);
}

function checkService(manifest, serviceId, sourceRoot) {
  const service = manifest.services[serviceId];
  const serviceDir = path.join(sourceRoot, service.service_dir);
  const packagePath = path.join(serviceDir, "package.json");
  const stdioPath = path.join(sourceRoot, service.stdio);
  const issues = [];
  const warnings = [];
  if (!fs.existsSync(serviceDir)) issues.push("service_dir_missing");
  if (!fs.existsSync(packagePath)) issues.push("package_json_missing");
  if (!fs.existsSync(stdioPath)) issues.push("local_stdio_missing");
  else {
    const mode = fs.statSync(stdioPath).mode;
    if ((mode & 0o111) === 0) issues.push("local_stdio_not_executable");
  }
  const pkg = fs.existsSync(packagePath) ? readJson(packagePath, { scripts: {} }) : { scripts: {} };
  for (const scriptName of ["build"]) {
    if (!pkg.scripts?.[scriptName]) issues.push(`script_missing:${scriptName}`);
  }
  for (const scriptName of ["smoke", "measurement:report"]) {
    if (!pkg.scripts?.[scriptName]) warnings.push(`script_missing:${scriptName}`);
  }
  return { service: serviceId, status: issues.length ? "needs_attention" : "ok", issues, warnings };
}

function doctor({ manifest, sourceRoot, services }) {
  const rows = services.map((serviceId) => checkService(manifest, serviceId, sourceRoot));
  const summary = {
    services: rows.length,
    ok: rows.filter((row) => row.status === "ok").length,
    needs_attention: rows.filter((row) => row.status !== "ok").length,
    warnings: rows.reduce((total, row) => total + row.warnings.length, 0),
  };
  console.log(JSON.stringify({ schema_version: "hwai-mcp-team-doctor.v1", summary, services: rows }, null, 2));
  if (summary.needs_attention > 0) {
    process.exitCode = 1;
  }
}

function installDeps({ manifest, sourceRoot, services, dryRun, skipBuild }) {
  if (skipBuild) {
    console.log("skip-build enabled; not running npm install/build");
    return;
  }
  for (const serviceId of services) {
    const service = manifest.services[serviceId];
    const serviceDir = path.join(sourceRoot, service.service_dir);
    const packagePath = path.join(serviceDir, "package.json");
    if (!fs.existsSync(packagePath)) {
      throw new Error(`missing package.json for ${serviceId}: ${packagePath}`);
    }
    if (dryRun) {
      console.log(`[dry-run] would npm ci/build in ${serviceDir}`);
      continue;
    }
    const installArgs = fs.existsSync(path.join(serviceDir, "package-lock.json"))
      ? ["ci", "--ignore-scripts"]
      : ["install", "--ignore-scripts"];
    run("npm", installArgs, { cwd: serviceDir });
    run("npm", ["run", "build"], { cwd: serviceDir });
  }
}

function install() {
  const { manifest } = loadManifest();
  const profile = argValue("profile", DEFAULT_PROFILE);
  const sourceRoot = path.resolve(argValue("source-root", process.cwd()));
  const workspace = path.resolve(argValue("workspace", process.cwd()));
  const dryRun = hasFlag("dry-run");
  const skipBuild = hasFlag("skip-build");
  const clients = selectedClients(argValue("clients", "auto"));
  const services = resolveProfile(manifest, profile);
  const envFile = expandHome(manifest.workspace_env_file || "$HOME/.hwai/mcp-stack/env");

  installDeps({ manifest, sourceRoot, services, dryRun, skipBuild });
  ensureEnvFile(manifest, services, envFile, dryRun);

  for (const client of clients) {
    const items = services.map((serviceId) => serviceConfig(manifest, serviceId, sourceRoot, client, envFile));
    if (client === "claude") installClaude(workspace, items, dryRun);
    else if (client === "codex") installCodex(items, dryRun);
    else if (client === "cursor") installProjectJson(path.join(workspace, ".cursor", "mcp.json"), items, dryRun);
    else if (client === "windsurf") installProjectJson(path.join(workspace, ".windsurf", "mcp.json"), items, dryRun);
    else throw new Error(`unknown client: ${client}`);
  }

  doctor({ manifest, sourceRoot, services });
  console.log("HWAI MCP stack install complete. Restart clients or open a new chat so stdio MCP configs reload.");
}

function main() {
  const command = process.argv[2] || "help";
  const { manifest } = loadManifest();
  const profile = argValue("profile", DEFAULT_PROFILE);
  const sourceRoot = path.resolve(argValue("source-root", process.cwd()));
  const services = resolveProfile(manifest, profile);

  if (command === "install") install();
  else if (command === "doctor") doctor({ manifest, sourceRoot, services });
  else {
    console.log(`Usage:
  hwai-mcp install --manifest=manifest.json --source-root=/path/repo --workspace=/path/project [--profile=core] [--clients=auto] [--dry-run] [--skip-build]
  hwai-mcp doctor  --manifest=manifest.json --source-root=/path/repo [--profile=core]
`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
