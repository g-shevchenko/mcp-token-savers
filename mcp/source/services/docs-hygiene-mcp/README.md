# HWAI Docs Hygiene MCP

Local-first advisory documentation hygiene MCP for HWAI repo work.

It scans local Markdown/MDX docs for inventory, broken relative links, broken anchors, orphan docs, exact duplicate sections, stale code references, missing frontmatter, and possible SSOT conflicts. Inline links and used reference-style links are checked; file links with line suffixes such as `foo.py:31` resolve to the underlying file, and links to existing local directories count as resolved. It never deletes, moves, archives, or rewrites docs.

Root `.claude` docs such as rules and agents remain scannable, but generated parallel-worktree clones under `.claude/worktrees/*` are skipped by default so cleanup reports do not double-count branch copies. Imported seed skill/template docs under `templates/hwai_internal_seed/skills/imported/*` are also skipped by default so HWAI SSOT reports are not mixed with vendored template debt; pass `include_imported_templates: true` when deliberately auditing those imported docs.

Broken-link and stale-reference detection are intentionally conservative: they ignore URLs, absolute paths, home-relative paths, template placeholders, regex snippets, glob shorthands, shell-command snippets, NPM scope package names, generated live-snapshot page bodies, and bare filenames so evidence logs and examples do not swamp real repo-path findings.

Stale-reference checks resolve candidate paths from the repo root, the source document directory, and the nearest `projects/*`, `services/*`, or `experiments/*` local root. Cursor/Codex-style file mentions such as `@claude/CREDENTIALS.md` resolve to the workspace path before being classified.

## Tools

- `inventory_docs`
- `find_broken_links`
- `find_broken_anchors`
- `find_orphan_docs`
- `find_duplicate_sections`
- `find_stale_code_references`
- `check_doc_frontmatter`
- `check_ssot_conflicts`
- `propose_doc_merge_or_archive`
- `get_artifact`
- `get_measurement_report`

## Local stdio

```bash
services/docs-hygiene-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/docs-hygiene-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/docs-hygiene-mcp/requests.jsonl
```

## Proof loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/docs-hygiene-local-benchmark.json
node scripts/measurement-report.mjs --date=2026-04-25 --format=pantheon
```

## Data policy

- Raw document bodies are not written to request logs.
- Duplicate-section results return content hashes, headings, files, and line metadata, not section bodies.
- Pantheon exports are aggregate-only.
- Repo markdown remains SSOT; Notion mirrors are documentation surfaces, not source truth.
- Agents must still read exact docs before editing or archiving anything.
