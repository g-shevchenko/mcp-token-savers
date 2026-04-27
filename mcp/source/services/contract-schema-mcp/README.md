# HWAI Contract Schema MCP

Local-first advisory MCP for contract/schema/env drift.

It indexes OpenAPI/Swagger JSON/YAML files, top-level and embedded Zod object schemas, and env contracts from `.env.example` plus `process.env.*` usages. It can create snapshots, diff snapshots, validate payload samples with local AJV, and summarize breaking changes.

## Tools

- `index_openapi`
- `index_zod`
- `index_env_contracts`
- `create_contract_snapshot`
- `diff_contracts`
- `validate_payload_sample`
- `summarize_breaking_changes`
- `get_artifact`
- `get_measurement_report`

## Local stdio

```bash
services/contract-schema-mcp/scripts/local-stdio.sh
```

The durable local cache defaults to:

```bash
$HOME/.hwai/contract-schema-mcp
```

Request traces are metadata/count/hash only:

```bash
$HOME/.hwai/contract-schema-mcp/requests.jsonl
```

## Proof loop

```bash
npm install
npm run build
npm run smoke
npm run benchmark -- --out=/tmp/contract-schema-local-benchmark.json
node scripts/measurement-report.mjs --date=2026-04-25 --format=pantheon
```

## Data policy

- Raw code bodies, env values, payload bodies, and secrets are not written to request logs.
- Pantheon exports are aggregate-only.
- Tool outputs may include repo-relative paths, endpoint templates, schema names, Zod object names, field names, schema kinds, and env variable names for local review.
- Agents must read exact contract files before edits.
