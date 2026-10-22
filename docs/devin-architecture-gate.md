# Devin client support architecture gate

Task class: runtime_infra. Protocol path: full_architecture_gate.
LLM-owned: choose an appropriate existing prep tool; no installer decisions.
Code-owned: explicit client dispatch, config merge/backups/dry-run, managed docs.
Existing assets: existing JSON installer, profile manifest, AGENTS managed block.
Schema: existing mcpServers command/args/env; new client label devin.
Validation: independent failing-first installer test, actual merge/idempotence
fixture, shell syntax and inspect-first public audit. No model calls or quota claim.
Runtime: installation only; dry-run does not claim built-service health.
Human gate: no credentials/accounts changed; public release follows repository audit.
Rollback: remove installed project entries/managed block using backup if needed;
no global client config changes. No private runtime code is included.

CI service builds have a 12-minute job cap and bounded registry fetches with HTTP
progress logs. npm ci keeps lockfile integrity checks; its informational audit is
disabled in the build lane (it did not fail builds on advisories). Public audit,
CodeQL and dependency update workflows remain required.
