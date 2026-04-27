# Repo History MCP

Local-first MCP for compact git history evidence before frontier-model repo reasoning.

Current local version: `1.1.0`.

`repo-history-mcp` is not a code search engine and not a replacement for reading exact files before edits. It answers "what changed, where, and how often?" with git metadata only, so agents can avoid pasting raw diffs, long logs, or file bodies into chat.

## Tools

- `summarize_recent_commits` - compact commit list, optional name-status changed files.
- `search_commits` - commit-message search with compact changed-file context.
- `summarize_file_history` - `git log --follow` summary for one file.
- `summarize_blame` - blame/authorship summary for a file or line range without source lines.
- `summarize_diff_stat` - range name-status and shortstat.
- `find_change_hotspots` - frequently touched files over a history window.
- `find_cochange_files` - files commonly changed with one or more target paths.
- `get_artifact` - read local JSON artifacts.
- `get_measurement_report` - local usage, quality, token savings, and Pantheon-safe aggregate export.

## Local stdio

```bash
services/repo-history-mcp/scripts/local-stdio.sh
```

Default durable cache:

```bash
$HOME/.hwai/repo-history-mcp
```

Durable local traces:

```bash
$HOME/.hwai/repo-history-mcp/requests.jsonl
$HOME/.hwai/repo-history-mcp/artifacts/
```

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

## Data Policy

- No raw diffs.
- No file bodies.
- Git commands use argv arrays, not a shell.
- Tool output may include relative paths, commit subjects, and author names because agents need local evidence.
- `search_commits` hashes the query in output/log summaries.
- `summarize_blame` never returns source lines.
- Request logs store metadata-only counts, hashes, refs-present booleans, token estimates, and artifact file names.
- Pantheon-safe export excludes raw diffs, file bodies, absolute repo paths, artifact URLs, commit subjects, relative file paths, author names, local log paths, and raw command output.

## Proof Loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/repo-history-local-benchmark.json
npm run measurement:report -- --date=2026-04-24 --format=pantheon
```

Golden benchmark creates a temporary git repo and verifies:

- recent commits are summarized
- commit-message search returns safe hits
- file history follows rename history
- blame returns authorship without source lines
- diff stat returns name-status only
- hotspots return counted files
- co-change finds related files
- measurement export is Pantheon-safe
- no raw file body appears in benchmark output

Latest v1.1 proof on 2026-04-24:

- golden benchmark: 10 cases, 0 failures
- smoke: tool list includes `search_commits`, `summarize_blame`, and `find_cochange_files`
- Pantheon-safe report: 18 calls, 0 errors, 14,934 saved-token estimate, 62.2% savings, p95 273 ms

## Product Role

Commercial analog gap covered:

- Cursor / Sourcegraph / Cody style repository-history context, but local-first and smaller.
- GitHub PR/file history summaries, but exposed as a shared MCP for Claude Code, Codex, Cursor, Windsurf, and automations.
- GitLens-style blame/authorship summary, but as an MCP artifact instead of IDE UI.

Still missing versus paid products:

- persistent semantic code graph
- PR review UI
- blame-aware ownership maps
- branch/PR search UI
- branch/remote indexing
- hosted collaboration and annotations

Next hardening should come from real retrieval misses or repo tasks where history context would have prevented a false start.
