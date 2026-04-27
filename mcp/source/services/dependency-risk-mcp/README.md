# HWAI Dependency Risk MCP

Local-first advisory MCP for dependency, license, lockfile, audit, OSV, package-age, and supply-chain lockfile risk.

It summarizes dependency evidence before agents spend frontier reasoning on huge lockfiles or raw audit JSON. Networked scanners are opt-in: `run_npm_audit`, `summarize_npm_audit_fix_plan`, and `run_osv_scanner` prefer local JSON/output input and skip by default unless `allow_network=true`.
`summarize_npm_audit_fix_plan` accepts saved stdout from `npm audit fix --dry-run --json`, including npm outputs that prepend `add`/`remove` action lines before the JSON body, and reports compact change counts plus whether proposed fixes require semver-major upgrades.

Supply-chain lockfile checks are local-only. `summarize_supply_chain_risk` flags install-script packages, missing integrity, insecure HTTP tarballs, git/file/link sources, and external HTTPS sources without returning raw `resolved` URLs.

## Tools

- `summarize_lockfile_diff`
- `run_npm_audit`
- `summarize_npm_audit_fix_plan`
- `run_osv_scanner`
- `check_licenses`
- `package_age_report`
- `summarize_supply_chain_risk`
- `get_artifact`
- `get_measurement_report`

## Local Stdio

```bash
services/dependency-risk-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/dependency-risk-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/dependency-risk-mcp/requests.jsonl
```

## Proof Loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/dependency-risk-local-benchmark.json
node scripts/measurement-report.mjs --date=2026-04-25 --format=pantheon
```

## Data Policy

- Raw lockfiles, audit JSON, OSV JSON, package manager output, resolved URLs, local paths, and artifact URLs are not written to request logs.
- Pantheon exports are aggregate-only.
- Tool outputs may include package names, versions, license names, vulnerability IDs, hashed resolved hosts, and repo-relative file labels for local review.
- Agents must read exact dependency files before edits.
