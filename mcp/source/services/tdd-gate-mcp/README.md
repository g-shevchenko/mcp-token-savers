# tdd-gate-mcp

Granular TDD discipline checks exposed as MCP tools.

Complementary to a PreToolUse hook that enforces TDD at the deterministic gate level: the hook is fast and binary; this MCP exposes rich introspection that agents call programmatically (per-violation detail, error-type classification, durable test↔impl link registry).

## Why

Multi-agent AI coding workflows need both layers:
- **Deterministic block** (PreToolUse hook) — blocks 100% of TDD violations at the gate
- **Rich introspection** (this MCP) — explains WHY a block would happen, classifies the failure, records bindings

This MCP gives the introspection. A companion PreToolUse hook (the deterministic gate) lives outside this stack.

## Tools (v0.1.0)

| Tool | Purpose |
|---|---|
| `check_edit_allowed(file_path, root_dir?)` | Predicate-with-explanation: returns `{allowed, reason, suggestion?}`. Same logic a TDD gate hook would use (extension/path bypass, 2-level walk-up for tests/ dir, legacy bypass when no tests/ exists, matching-stem detection). |
| `check_test_immutability(file_path, old_content, new_content)` | Diffs old vs new content of a test file. Flags removed assertions (`expect`/`assert`/`should`/`toBe`/`toEqual` lines that disappeared) and added skip markers (`.skip()`, `xfail`, `@pytest.mark.skip`, `test.skip`, `fit`, `fdescribe`). Returns per-violation `{type, line, snippet}`. |
| `verify_red_status(test_command, expected_failure_pattern?, cwd?, timeout_ms?)` | Spawns the test command, captures stdout/stderr + exit code, classifies output: `assertion` (valid TDD red), `import_error` / `syntax_error` (broken setup), `passed` (invalid — test passes immediately), `other` (timeout/spawn-error). Default timeout 30s. |
| `register_test_to_impl_link(test_file, impl_glob, root_dir?)` | Records durable test↔impl binding in `.agent/tdd-links/links.json`. Idempotent (duplicate pair returns existing entry). Supports multiple links per test file. |

## Status

v0.1.0 — initial scaffold.

## Build + smoke

```bash
npm install
npm run build
npm run smoke
```

The smoke script (`scripts/smoke-local.sh`) runs **12 checks**:

1-4. `check_edit_allowed`: .md bypass, legacy bypass, matching-test allows, no-matching-test blocks
5-7. `check_test_immutability`: pure additions allowed, removed expect detected, .skip marker detected
8-11. `verify_red_status`: passed (BAD), AssertionError (red), ImportError (broken setup), timeout handled
12. `register_test_to_impl_link`: new register + idempotent duplicate + persistence

## Data policy

- Pure filesystem ops for `check_edit_allowed` and `register_test_to_impl_link`
- `verify_red_status` spawns a child process with shell=true; caller is responsible for command safety (this MCP is intended to be called by trusted agents, not user-input)
- `register_test_to_impl_link` writes only to `<rootDir>/.agent/tdd-links/links.json` (default `process.cwd()`)
- No network, no telemetry

## License

MIT
