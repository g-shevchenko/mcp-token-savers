#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const serviceRoot = path.join(root, "mcp", "source", "services");
const components = new Map();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, out);
    } else if (entry.name === "package-lock.json") {
      out.push(full);
    }
  }
  return out;
}

function addComponent(name, version, sourceFile) {
  if (!name || !version) return;
  const key = `${name}@${version}`;
  if (components.has(key)) return;
  components.set(key, {
    type: "library",
    name,
    version,
    "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${version}`,
    properties: [
      {
        name: "humanswithai:source_lockfile",
        value: path.relative(root, sourceFile),
      },
    ],
  });
}

for (const lockFile of walk(serviceRoot)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (lock.name && lock.version) {
    addComponent(lock.name, lock.version, lockFile);
  }
  for (const [pkgPath, pkg] of Object.entries(lock.packages || {})) {
    if (!pkgPath.startsWith("node_modules/")) continue;
    addComponent(pkg.name || pkgPath.replace(/^node_modules\//, ""), pkg.version, lockFile);
  }
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${cryptoRandomUuid()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      {
        vendor: "Humanswith.ai",
        name: "scripts/generate-sbom.mjs",
        version: "1",
      },
    ],
    component: {
      type: "application",
      name: "Humanswith.ai MCP Stack",
      version: process.env.GITHUB_REF_NAME || "local",
    },
  },
  components: [...components.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)),
};

fs.writeFileSync(process.argv[2] || "sbom.cdx.json", `${JSON.stringify(bom, null, 2)}\n`);

function cryptoRandomUuid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

