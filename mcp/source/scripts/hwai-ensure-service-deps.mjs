#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function needsInstall(serviceDir, pkg) {
  const nodeModules = path.join(serviceDir, "node_modules");
  if (!exists(nodeModules)) {
    return true;
  }
  const buildScript = pkg.scripts?.build || "";
  if (buildScript.includes("tsc") && !exists(path.join(nodeModules, ".bin", "tsc"))) {
    return true;
  }
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  for (const name of Object.keys(deps)) {
    if (name.startsWith("@")) {
      const [scope, packageName] = name.split("/");
      if (!exists(path.join(nodeModules, scope, packageName || ""))) {
        return true;
      }
      continue;
    }
    if (!exists(path.join(nodeModules, name))) {
      return true;
    }
  }
  return false;
}

const services = process.argv.slice(2);
if (services.length === 0) {
  console.error("Usage: node scripts/hwai-ensure-service-deps.mjs services/<service> [...]");
  process.exit(2);
}

for (const service of services) {
  const serviceDir = path.resolve(repoRoot, service);
  const packagePath = path.join(serviceDir, "package.json");
  const lockPath = path.join(serviceDir, "package-lock.json");
  if (!exists(packagePath)) {
    console.error(`Missing package.json for ${service}`);
    process.exit(2);
  }
  if (!exists(lockPath)) {
    continue;
  }
  const pkg = readJson(packagePath);
  if (!needsInstall(serviceDir, pkg)) {
    continue;
  }
  console.error(`Installing missing dependencies for ${service}`);
  const result = spawnSync("npm", ["ci", "--ignore-scripts"], {
    cwd: serviceDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
