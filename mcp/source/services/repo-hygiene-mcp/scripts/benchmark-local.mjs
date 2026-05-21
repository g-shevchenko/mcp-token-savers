#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-hygiene-mcp-benchmark-"));
process.env.REPO_HYGIENE_CACHE_DIR = path.join(tempDir, "cache");
await fs.mkdir(path.join(tempDir, "fixture", "src"), { recursive: true });
await fs.mkdir(path.join(tempDir, "fixture", "aaa-noise"), { recursive: true });
for (let index = 0; index < 80; index += 1) {
  await fs.writeFile(path.join(tempDir, "fixture", "aaa-noise", `${String(index).padStart(3, "0")}.md`), "# generated note\n", "utf8");
}
await fs.writeFile(
  path.join(tempDir, "fixture", "package.json"),
  JSON.stringify(
    {
      name: "fixture",
      type: "module",
      scripts: {
        build: "tsc && example-run build",
      },
      dependencies: {
        chalk: "^5.0.0",
        "framework-shell": "^1.0.0",
        lodash: "^4.17.21",
        "left-pad": "^1.3.0",
        marked: "^18.0.0",
        react: "^19.0.0",
        "styled-components": "^6.0.0",
      },
      devDependencies: {
        "@example/cli": "^1.0.0",
        "@tailwindcss/postcss": "^4.0.0",
        "@types/node": "^22.0.0",
        "@types/react": "^19.0.0",
        postcss: "^8.0.0",
        tailwindcss: "^4.0.0",
        typescript: "^5.0.0",
      },
    },
    null,
    2,
  ),
  "utf8",
);
await fs.writeFile(
  path.join(tempDir, "fixture", "package-lock.json"),
  JSON.stringify(
    {
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture",
          devDependencies: {
            "@example/cli": "^1.0.0",
          },
        },
        "node_modules/@example/cli": {
          version: "1.0.0",
          bin: {
            "example-run": "bin/example-run.js",
          },
        },
        "node_modules/framework-shell": {
          version: "1.0.0",
          peerDependencies: {
            "styled-components": "^6.0.0",
          },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);
await fs.writeFile(
  path.join(tempDir, "fixture", "postcss.config.mjs"),
  'export default { plugins: { "@tailwindcss/postcss": {} } };\n',
  "utf8",
);
await fs.writeFile(path.join(tempDir, "fixture", "tsconfig.json"), '{"compilerOptions":{"jsx":"react-jsx"}}\n', "utf8");
await fs.writeFile(
  path.join(tempDir, "fixture", "src", "app.ts"),
  'import lodash from "lodash";\nexport function usedUtility(value: string) { return lodash.camelCase(value); }\nexport function orphanUtility(value: string) { return value.trim().toUpperCase(); }\n',
  "utf8",
);
await fs.writeFile(path.join(tempDir, "fixture", "src", "style.css"), '@import "tailwindcss";\n', "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "view.tsx"), 'import React from "react";\nexport function View() { return React.createElement("div"); }\n', "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "content.astro"), '---\nimport { marked } from "marked";\nconst html = marked.parse("# Hello");\n---\n<div set:html={html} />\n', "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "framework.ts"), 'import { boot } from "framework-shell";\nexport function start() { return boot(); }\n', "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "a.ts"), 'import { b } from "./b";\nexport const a = b + 1;\n', "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "b.ts"), 'import { a } from "./a";\nexport const b = a + 1;\n', "utf8");
await fs.writeFile(
  path.join(tempDir, "fixture", "src", "lazy.ts"),
  'export async function colorize(value: string) { const chalk = await import("chalk"); return chalk.default.green(value); }\n',
  "utf8",
);
const duplicateBody = `  const normalized = input.trim().toLowerCase();
  const parts = normalized.split("-");
  const filtered = parts.filter(Boolean);
  const joined = filtered.join("_");
  const finalValue = joined.replace(/_/g, "-");
  return finalValue;
`;
await fs.writeFile(path.join(tempDir, "fixture", "src", "dup-one.ts"), `export function one(input: string) {\n${duplicateBody}}\n`, "utf8");
await fs.writeFile(path.join(tempDir, "fixture", "src", "dup-two.ts"), `export function two(input: string) {\n${duplicateBody}}\n`, "utf8");
await fs.writeFile(
  path.join(tempDir, "fixture", "src", "complex.ts"),
  'export function complex(items: string[]) { let total = 0; for (const item of items) { if (item.includes("a") && item.length > 2) total += 1; if (item.includes("b") || item.includes("c")) total += 1; switch (item[0]) { case "x": total += 1; break; default: total += 0; } } return total > 2 ? total : 0; }\n',
  "utf8",
);
// module-depth fixtures (newline-proper — the scorer reads indentation)
await fs.writeFile(
  path.join(tempDir, "fixture", "src", "deep-mod.py"),
  [
    "def score_app(app):",
    "    s = 50",
    "    flags = []",
    '    if app.get("x"):',
    "        for k in app:",
    "            if k:",
    "                s += 1",
    "                flags.append(k)",
    "    if s > 40:",
    "        s -= 5",
    '    return {"s": s, "flags": flags}',
    "",
  ].join("\n"),
  "utf8",
);
await fs.writeFile(
  path.join(tempDir, "fixture", "src", "shallow-wrap.py"),
  ["import requests", "", "def post_it(payload):", '    return requests.post("u", json=payload).json()', ""].join("\n"),
  "utf8",
);
await fs.mkdir(path.join(tempDir, "fixture", ".claude", "worktrees", "generated-branch", "src"), { recursive: true });
await fs.writeFile(
  path.join(tempDir, "fixture", ".claude", "worktrees", "generated-branch", "src", "noisy.ts"),
  "export function noisyWorktreeFunction(value: string) { return value.trim().toUpperCase(); }\n",
  "utf8",
);
await fs.mkdir(path.join(tempDir, "fixture", "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill"), {
  recursive: true,
});
await fs.writeFile(
  path.join(tempDir, "fixture", "templates", "hwai_internal_seed", "skills", "imported", "vendor-skill", "package.json"),
  JSON.stringify(
    {
      name: "vendor-skill",
      dependencies: {
        "vendor-left-pad": "^1.0.0",
      },
    },
    null,
    2,
  ),
  "utf8",
);

const { getRepoHygieneConfig } = await import("../dist/config.js");
const {
  proposeCleanupPlan,
  scanComplexityHotspots,
  scanDependencyCycles,
  scanDuplicateCode,
  scanUnusedCode,
  scanUnusedDependencies,
} = await import("../dist/hygiene.js");
const { buildMeasurementReport } = await import("../dist/measurement.js");
const { scoreModuleDepth } = await import("../dist/module-depth.js");

const config = getRepoHygieneConfig();
const args = { repo_root: path.join(tempDir, "fixture"), max_files: 50, max_findings: 20, block_lines: 5, metadata: { source: "benchmark-local" } };
const importedArgs = { ...args, include_imported_templates: true };
const failures = [];
function assert(name, condition, details = {}) {
  if (!condition) failures.push({ name, details });
}

const unusedDeps = await scanUnusedDependencies(config, args);
const importedUnusedDeps = await scanUnusedDependencies(config, importedArgs);
const unusedCode = await scanUnusedCode(config, args);
const duplicates = await scanDuplicateCode(config, args);
const cycles = await scanDependencyCycles(config, args);
const hotspots = await scanComplexityHotspots(config, args);
const plan = await proposeCleanupPlan(config, args);
const measurement = await buildMeasurementReport(config, { date: new Date().toISOString().slice(0, 10) });
const combined = JSON.stringify({ unusedDeps, unusedCode, duplicates, cycles, hotspots, plan, measurement });

assert("unused-dep-left-pad", unusedDeps.candidates.some((item) => item.dependency_name === "left-pad"), unusedDeps.candidates);
assert("used-dep-lodash-not-candidate", !unusedDeps.candidates.some((item) => item.dependency_name === "lodash"), unusedDeps.candidates);
assert("dynamic-import-chalk-not-candidate", !unusedDeps.candidates.some((item) => item.dependency_name === "chalk"), unusedDeps.candidates);
assert("astro-import-marked-not-candidate", !unusedDeps.candidates.some((item) => item.dependency_name === "marked"), unusedDeps.candidates);
assert("peer-dep-styled-components-not-candidate", !unusedDeps.candidates.some((item) => item.dependency_name === "styled-components"), unusedDeps.candidates);
assert(
  "tooling-and-types-deps-not-candidates",
  !["@example/cli", "@tailwindcss/postcss", "@types/node", "@types/react", "postcss", "tailwindcss", "typescript"].some((name) =>
    unusedDeps.candidates.some((item) => item.dependency_name === name),
  ),
  unusedDeps.candidates,
);
assert("dynamic-import-counted", unusedDeps.dynamic_imports_seen >= 1, unusedDeps);
assert("unused-code-orphan", unusedCode.candidates.some((item) => item.symbol_name === "orphanUtility"), unusedCode.candidates);
assert("duplicate-group", duplicates.duplicate_groups >= 1, duplicates);
assert("cycle-found", cycles.cycles_count >= 1, cycles);
assert("hotspot-found", hotspots.hotspots_count >= 1, hotspots);
assert("plan-items", plan.plan_items_count >= 4, plan);
assert("measurement-safe", measurement.pantheon_export.safe_for_pantheon === true, measurement.pantheon_export);
assert("generated-worktree-code-skipped", !combined.includes(".claude/worktrees/") && !combined.includes("noisyWorktreeFunction"), {});
assert("imported-template-code-skipped-by-default", !combined.includes("templates/hwai_internal_seed/skills/imported/"), {});
assert(
  "imported-template-code-can-be-included-explicitly",
  importedUnusedDeps.candidates.some(
    (item) =>
      item.package_file === "templates/hwai_internal_seed/skills/imported/vendor-skill/package.json" &&
      item.dependency_name === "vendor-left-pad",
  ),
  importedUnusedDeps,
);
assert("no-raw-code-leak", !combined.includes("value.trim().toUpperCase") && !combined.includes("joined.replace"), {});

// module-depth scorer (Ousterhout depth proxy) — must agree with the blind LLM precision direction
const deepScore = await scoreModuleDepth(config, { repo_root: path.join(tempDir, "fixture"), path: "src/deep-mod.py" });
const shallowScore = await scoreModuleDepth(config, { repo_root: path.join(tempDir, "fixture"), path: "src/shallow-wrap.py" });
const depthCompare = await scoreModuleDepth(config, {
  repo_root: path.join(tempDir, "fixture"),
  path: "src/deep-mod.py",
  compare_to: "src/shallow-wrap.py",
});
const depthCombined = JSON.stringify({ deepScore, shallowScore, depthCompare });
assert("module-depth-deep", deepScore.band === "deep", deepScore);
assert("module-depth-shallow", shallowScore.band === "shallow", shallowScore);
assert("module-depth-ratio-orders", deepScore.depth_ratio > shallowScore.depth_ratio, {
  deep: deepScore.depth_ratio,
  shallow: shallowScore.depth_ratio,
});
assert("module-depth-compare-deeper", depthCompare.compare?.direction === "deeper", depthCompare.compare);
assert(
  "module-depth-no-raw-code-leak",
  !depthCombined.includes("requests.post") && !depthCombined.includes("flags.append"),
  {},
);

const result = {
  benchmark: "repo-hygiene-local-golden",
  cases: 22,
  failures,
  rows: [
    { name: "module-depth-deep-ratio", value: deepScore.depth_ratio },
    { name: "module-depth-shallow-ratio", value: shallowScore.depth_ratio },
    { name: "unused-dependency-candidates", value: unusedDeps.candidates_count },
    { name: "dynamic-imports-seen", value: unusedDeps.dynamic_imports_seen },
    { name: "unused-code-candidates", value: unusedCode.candidates_count },
    { name: "duplicate-groups", value: duplicates.duplicate_groups },
    { name: "cycles", value: cycles.cycles_count },
    { name: "hotspots", value: hotspots.hotspots_count },
    { name: "plan-items", value: plan.plan_items_count },
    { name: "measurement-calls", value: measurement.usage.calls },
  ],
};

const outPath = argValue("--out");
if (outPath) {
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
