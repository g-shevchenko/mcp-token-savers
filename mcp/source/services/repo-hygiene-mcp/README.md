# Repo Hygiene MCP

Local-first advisory cleanup MCP for keeping the repo from accumulating dead exports, unused dependencies, duplicate helpers, import cycles, and unbounded complexity.

It is not an auto-delete tool. Every result is evidence for a human or agent to review with exact files, focused tests, and the normal HWAI proof loop.

## Goal

`repo-hygiene-mcp` is the bloat-control layer in the HWAI utility MCP stack:

- find cleanup candidates before agents add more code around stale code
- keep raw code and local paths out of Pantheon
- make cleanup measurable before any quality gate becomes blocking
- preserve frontier reasoning for architecture-heavy or risky cleanup decisions

## Entrypoint

```bash
services/repo-hygiene-mcp/scripts/local-stdio.sh
```

Default durable cache:

```bash
$HOME/.hwai/repo-hygiene-mcp
```

Durable local traces:

```bash
$HOME/.hwai/repo-hygiene-mcp/requests.jsonl
$HOME/.hwai/repo-hygiene-mcp/artifacts/
```

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

Root `.claude`, `.cursor`, and `.windsurf` policy/config files are scanned, but generated parallel-worktree clones under `.claude/worktrees/*` are skipped by default to avoid false cleanup candidates from branch copies. Imported seed skill/template files under `templates/hwai_internal_seed/skills/imported/*` are also skipped by default so maintained-repo cleanup reports are not mixed with vendored template debt; pass `include_imported_templates: true` when deliberately auditing those imported packages.

## Tools

- `scan_unused_code` - advisory exported-symbol candidates using local reference counting.
- `scan_unused_dependencies` - package dependency candidates from `package.json` plus static import, re-export, `require`, dynamic import, Astro frontmatter imports, CSS `@import`, package scripts, common config files, package-lock binary/peer-dependency evidence, and matching `@types/*` usage.
- `scan_duplicate_code` - normalized duplicate source blocks without returning block text.
- `scan_dependency_cycles` - relative JS/TS import cycles.
- `scan_complexity_hotspots` - simple lines/functions/branches/imports ranking.
- `propose_cleanup_plan` - combined reviewed cleanup plan; no file changes.
- `get_artifact` - read local artifacts.
- `get_measurement_report` - aggregate local usage, quality counters, token savings, and Pantheon-safe export.

## Data Policy

- Raw code and file bodies are never returned by duplicate scans.
- Tool output may include repo-relative paths and symbol/dependency names for local agent use.
- Request logs store counts, hashes, and artifact file names, not raw file bodies or absolute repo paths.
- Pantheon export is aggregate-only and excludes raw code, file bodies, absolute paths, and artifact URLs.
- No tool deletes, moves, quarantines, or rewrites files in v0.1.

## Proof Loop

```bash
cd services/repo-hygiene-mcp
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/repo-hygiene-local-benchmark-2026-04-25.json
node scripts/measurement-report.mjs --date=2026-04-25 --format=pantheon
```

## Benchmark Bar

- `tools/list` exposes all hygiene tools.
- Smoke covers unused dependencies, unused code, duplicate code, dependency cycles, complexity hotspots, cleanup plan, measurement, and reduced-`PATH` stdio.
- Golden benchmark uses a temp repo fixture with:
  - one unused dependency, one static-imported dependency, and one dynamic-imported dependency guard
  - one unused export candidate
  - one duplicate code group
  - one relative import cycle
  - one complexity hotspot
  - one cleanup plan
  - a generated `.claude/worktrees/*` branch copy that must not produce candidates
  - imported seed skill/template files skipped by default and available through explicit opt-in
  - no raw code-body leakage in combined output

## Current Role in HWAI Stack

Use `repo-hygiene-mcp` before broad cleanup, refactors, dependency pruning, or when a task risks adding more code around stale utilities. It complements:

- `retrieval-mcp`: where behavior is implemented
- `language-graph-mcp`: symbol/import/reference/blast-radius context
- `repo-history-mcp`: what changed before
- `static-analysis-mcp`: deterministic build/lint/test evidence after edits

Agents still read exact files before edits and run proof loops before deleting or refactoring anything.
