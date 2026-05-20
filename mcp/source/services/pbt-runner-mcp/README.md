# pbt-runner-mcp

Property-based testing runner MCP. Wraps `hypothesis` (Python) + `fast-check` (TypeScript) with structured counterexample parsing.

## Why

Research shows property-based testing outperforms example-based testing for LLM-generated code:

- **PGS** (arxiv:2506.18315, 2026) — two-agent property-based TDD achieves **+23-37% relative pass@1** over example-based TDD on HumanEval, MBPP, LiveCodeBench. Solves the "cycle of self-deception" — when an LLM writes both test and code, they share blind spots.
- **Agentic Property-Based Testing** (arxiv:2510.09907, Oct 2025) — **56% valid bug rate** on real PyPI packages; 3 patches merged upstream.

**Token economy**: agent declares ONE property (~200 tokens), framework explores thousands of cases, returns ONE minimum counterexample (~30 tokens). vs writing 50 example tests (~5 KB code). Est. savings: **80-90% on bug-discovery loops**.

## Three property archetypes

| Archetype | Pattern | Example |
|---|---|---|
| **Invariant** | output property holds for all inputs | `sorted(xs)` is non-decreasing |
| **Inverse** | `f(g(x)) == x` | `decode(encode(x)) == x` |
| **Idempotence** | `f(f(x)) == f(x)` | `normalize(normalize(x)) == normalize(x)` |

## Tools (v0.1.0)

| Tool | Purpose |
|---|---|
| `run_property(language, archetype, strategies_code, property_code, ...)` | Spawns hypothesis (Python) or fast-check (TypeScript), captures stdout/stderr + exit, parses output. Structured `{outcome, counterexample, shrunk_input, examples_tried, raw_output, exec_ms, error_message}`. |
| `suggest_strategies(language, input_description)` | Maps natural-language input descriptions ('positive integer', 'non-empty string', 'list of integers') to hypothesis/fast-check strategy code. 13 mappings, most-specific first. |
| `record_property_run(property_name, archetype, run_result, code_under_test_ref?)` | Appends durable JSON line to `.agent/pbt/runs.jsonl` for audit/regression tracking. |

## Pre-requisites for `run_property`

Host env must have the appropriate library installed:

- Python: `pip install hypothesis`
- TypeScript: `npm install fast-check` (in the project under test)

The MCP detects missing libraries and returns `outcome: "error"` with a helpful `error_message`.

## Build + smoke

```bash
npm install
npm run build
npm run smoke
```

The smoke script (`scripts/smoke-local.sh`) runs **11 checks** validating parsers + suggester + recorder. `run_property` integration is NOT in smoke (requires hypothesis or fast-check in host env); verify manually with:

```bash
pip install hypothesis
# then construct a run_property call via the MCP
```

## Data policy

- `run_property` spawns a subprocess (python3 or node); caller is responsible for command safety
- `record_property_run` writes only to `<rootDir>/.agent/pbt/runs.jsonl` (default `process.cwd()`)
- Counterexamples + shrunk inputs are stored verbatim — callers concerned about sensitive content should hash before passing
- No network, no telemetry

## License

MIT
