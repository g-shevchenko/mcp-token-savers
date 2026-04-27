# Language Graph MCP

Local-first structural repo graph for HWAI agents. It indexes files into compact symbol/import/reference metadata so agents can navigate large codebases, estimate blast radius, and avoid reading broad raw source when a structural answer is enough.

## Why

- Reduce tokens on "where is this implemented", "what imports this", and "what could this edit break" tasks.
- Keep raw code local. Request logs store hashes and counts, not file bodies or raw repo paths.
- Support repo hygiene work before edits: find definitions, references, import neighbors, and affected files.

This MCP is not a replacement for exact file reads. Agents still read exact files before edits.

## Tools

- `index_repo` - build or refresh the local graph.
- `get_graph_status` - freshness and aggregate counts.
- `get_file_outline` - symbols/imports/importers for one file.
- `find_symbol` - compact symbol search.
- `find_references` - symbol references by file and line, without source line text.
- `get_import_neighbors` - imports and importers for a file.
- `get_blast_radius` - local impact set for a file or symbol.
- `get_artifact` - read local artifacts.
- `get_measurement_report` - UTC usage, quality counters, token estimates, and Pantheon-safe export.

Lookup tools do not build a missing index silently. Call `index_repo` first, pass `refresh: true`, or opt into `auto_index: true` for small/proof fixtures.

## Local stdio

```bash
cd services/language-graph-mcp
npm install
npm run build
./scripts/local-stdio.sh
```

`local-stdio.sh` resolves `node` / `npm` from explicit `NODE_BIN` / `NPM_BIN`, then common Homebrew locations. The smoke suite includes a reduced-PATH stdio check because Claude/Codex/Cursor/Windsurf clients may not inherit an interactive shell environment.

The default durable local cache is:

```text
$HOME/.hwai/language-graph-mcp
```

Important files:

- `requests.jsonl` - local aggregate request trace. Inputs are hashed/summarized.
- `indexes/*.json` - local graph metadata.
- `artifacts/*.json` - local compact summaries.

## Data Policy

Pantheon/team exports are aggregates only. They exclude:

- raw code
- file bodies
- raw queries
- relative paths
- absolute repo paths
- artifact URLs
- local log paths

Local MCP responses can return repo-relative paths because the agent needs exact files for follow-up reads. Do not forward those raw local responses to public/shared systems.

## Proof Loop

```bash
cd services/language-graph-mcp
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/language-graph-local-benchmark.json
npm run measurement:report -- --date=$(date -u +%F) --format=pantheon
npm run measurement:report -- --date=$(date -u +%F) --format=pantheon --out=/tmp/language-graph-pantheon.json
```

The smoke suite uses a per-run temp cache and validates the current-day Pantheon-safe report counters after the stdio calls finish. This keeps proof traffic out of the durable `$HOME/.hwai/language-graph-mcp` learning view while still catching measurement/report regressions.

## v0.1 Scope

The parser is deliberately dependency-light and regex-based, reusing the proven retrieval-mcp style:

- TypeScript/JavaScript static imports, re-exports, `require`, dynamic imports, functions, classes, types, routes, MCP tool names
- Python functions/classes/imports
- shell functions
- Markdown headings
- YAML/JSON keys

Tree-sitter or richer language-server indexing should be added only after a golden benchmark proves better recall or lower token use on real misses.
