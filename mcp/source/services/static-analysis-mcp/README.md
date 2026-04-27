# HWAI Static Analysis MCP

Local-first MCP server for compact deterministic verification before frontier-model reasoning.

## Why

Use this service when an agent needs evidence from local checks instead of pasting raw CI/build/security logs into a model:

- TypeScript diagnostics
- ESLint findings
- focused test command summaries
- Semgrep local scan summaries
- gitleaks redacted secret-scan summaries
- SARIF summaries

It is not a replacement for frontier reasoning on ambiguous, high-risk, architecture-heavy, or final-output-sensitive work. It produces compact evidence; agents still inspect exact files before edits.

## Tools

- `get_command_policy` - resolves local package/repo command policy without running commands.
- `run_tsc` - runs local TypeScript checks and summarizes diagnostics.
- `run_eslint` - runs local ESLint when configured in the target package.
- `run_tests_changed` - runs a caller-provided or package test command and summarizes failures.
- `run_semgrep_local` - runs local `semgrep` if installed.
- `run_gitleaks` - runs local `gitleaks` if installed, using redacted output.
- `summarize_sarif` - converts SARIF JSON into compact findings.
- `get_artifact` - reads local raw/summary artifacts.
- `get_measurement_report` - returns local usage, token-savings, and quality rollups.

## Command Policy

Use `get_command_policy` before broad tests/lint/typecheck when the correct package command is unclear. It returns command decisions without running anything.

Supported built-in presets:

- `auto` - backwards-compatible package defaults.
- `node-package` - package-oriented defaults.
- `node-package-safe` - package-oriented defaults with narrow test preference.
- `repo-safe` - avoids broad `npm test` unless `test:changed`, `test:unit`, or `test:ci` exists.

Local package/repo policy files can override commands:

```json
{
  "schema_version": "static-analysis-command-policy.v1",
  "default_preset": "ci-lite",
  "presets": {
    "ci-lite": {
      "commands": {
        "tsc": ["npm", "run", "typecheck", "--", "--pretty", "false"],
        "eslint": ["npm", "run", "lint", "--", "--format", "json"],
        "tests": ["npm", "run", "test:unit"],
        "semgrep": ["semgrep", "scan", "--config", "auto", "--json"],
        "gitleaks": ["gitleaks", "detect", "--no-banner", "--redact", "--source", ".", "--report-format", "json"]
      }
    }
  }
}
```

Supported file names:

- `static-analysis.policy.json`
- `.static-analysis.policy.json`
- `.hwai/static-analysis.policy.json`

Policy resolution never uses a shell. Request logs store policy source/preset/counts, not raw command output or file bodies.

Built-in TypeScript fallback is local-only: when a package has `tsconfig.json` but no local `node_modules/.bin/tsc`, `run_tsc` returns `skipped` with a clear install/explicit-command note instead of invoking `npx` and producing placeholder noise.

## Local Setup

```bash
cd services/static-analysis-mcp
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/static-analysis-local-benchmark-2026-04-24-policy.json
```

Local stdio entrypoint:

```bash
services/static-analysis-mcp/scripts/local-stdio.sh
```

By default durable local traces live under:

```text
$HOME/.hwai/static-analysis-mcp/requests.jsonl
$HOME/.hwai/static-analysis-mcp/artifacts/
```

`local-stdio.sh` resolves `node` and `npm` from `NODE_BIN` / `NPM_BIN`, the active `PATH`, then common Homebrew/system paths. `npm run smoke` includes a reduced-`PATH` stdio proof so client-launched MCP sessions do not depend on an interactive shell environment.

## Data Policy

- Raw command output is stored locally only.
- Tool responses include compact findings and local artifact references.
- Request logs store metadata-only input/output summaries.
- Pantheon-safe exports are aggregate-only and exclude raw code, raw command output, local paths, notes, and artifact URLs.
