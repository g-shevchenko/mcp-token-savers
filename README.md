# Humanswith.ai MCP Token Savers

> **Repo renamed 2026-05-24:** `g-shevchenko/hwai-mcp-stack` → `g-shevchenko/mcp-token-savers`. Old URLs still redirect via GitHub. The local install path `~/.hwai/hwai-mcp-stack/` is preserved for backward compatibility — existing users do not need to reinstall.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/ci.yml/badge.svg)](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/ci.yml)
[![CodeQL](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/codeql.yml/badge.svg)](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/scorecard.yml/badge.svg)](https://github.com/g-shevchenko/mcp-token-savers/actions/workflows/scorecard.yml)
[![Last commit](https://img.shields.io/github/last-commit/g-shevchenko/mcp-token-savers)](https://github.com/g-shevchenko/mcp-token-savers/commits/main)
[![MCP](https://img.shields.io/badge/MCP-21%20local%20servers-blue)](./mcp/manifest.json)

Local-first **Token Efficiency Platform for Agentic IDEs**.

The product goal is to help Claude Code, Codex, Cursor, and Windsurf spend
fewer tokens on noisy context while preserving the quality bar. The technical
core is **HWAI Context Router**: a local pre-reasoning layer that routes tasks
to the smallest useful prep/evidence MCP before a frontier model spends tokens.

The public stack is local-only. It does not install external web/search/crawl
MCPs by default, and it does not require API keys for the default or full
profile.

> **Deep-dive write-up:** *How I cut my Claude Code token usage by 75.5% with
> 17 local MCPs* — public research article with the pattern, the measured
> numbers, and the comparison against Cursor, Cody, Continue, Aider,
> Firecrawl, LLMLingua, Martian, RouteLLM, Helicone, Langfuse, and the
> Anthropic / Cloudflare *Code Execution with MCP* primary sources.
> [Read it on gregshevchenko.com](https://gregshevchenko.com/research/mcp-stack-token-economy/).

## Why

Modern coding agents are strongest when they see the right evidence, not the
largest possible prompt. HWAI Context Router gives them deterministic prep
tools:

- find the right files before editing;
- compact huge logs, specs, traces, screenshots, and dependency reports;
- catch repo/documentation drift early;
- keep raw local evidence local by default;
- work across Claude Code, Codex, Cursor, and Windsurf with the same MCP config.

In product terms, the 21 local MCP servers are modules behind one Token
Efficiency Platform. Agents should experience one workflow: classify the task,
prepare the right compact local evidence, and reserve frontier model context for
judgment rather than raw search, logs, traces, or screenshots.

## Verify First, Then Install

Recommended inspect-first path:

```bash
git clone https://github.com/g-shevchenko/mcp-token-savers.git
cd mcp-token-savers
bash scripts/agent-preinstall-check.sh
bash install.sh --dry-run
bash install.sh
```

This gives a human or agentic IDE a concrete trust path before anything is
installed: inspect the installer, run the public audit, run doctor, and see the
exact write targets in dry-run output.

See [Trust and verification](./TRUST.md) and
[Verify before install](./VERIFY_BEFORE_INSTALL.md). Agents can also read the
machine-readable [trust manifest](./trust/hwai-mcp-stack.trust.json).

## 60-Second Install

Fast local-first install after inspection:

```bash
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/mcp-token-savers/main/install.sh)"
```

For repeatable installs, prefer a release tag or commit SHA instead of `main`:

```bash
HWAI_MCP_BRANCH=76540dcfbcd12284fc2b783d22c5c091624eaf82 \
/bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/mcp-token-savers/76540dcfbcd12284fc2b783d22c5c091624eaf82/install.sh)"
```

Install all 21 local MCP servers:

```bash
HWAI_MCP_PROFILE=full /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/mcp-token-savers/main/install.sh)"
```

Install only for selected clients:

```bash
HWAI_MCP_PROFILE=full HWAI_MCP_CLIENTS=codex,cursor /bin/bash -lc "$(curl -fsSL https://raw.githubusercontent.com/g-shevchenko/mcp-token-savers/main/install.sh)"
```

Requirements: macOS/Linux shell, `git`, Node.js, and `npm`.

After installation, restart Claude Code, Codex, Cursor, or Windsurf, or open a
new chat so stdio MCP configs reload.

By default the installer also teaches the local project how to use the stack:
Claude Code, Codex, Cursor, and Windsurf get repo-local guidance, managed
Humanswith.ai blocks/rules, and a natural-language trigger vocabulary. This is
intentional for beginner-friendly Agentic Engineering workflows: users should be
able to write "find where this is implemented", "summarize this CI log", or
"check this screenshot", and the agent should know which MCP to consider.

The installer updates only managed Humanswith.ai blocks/rules and creates
`docs/humanswithai-mcp-stack.md`. To skip that project-teaching layer for a
config-only repair, set `HWAI_MCP_AGENT_DOCS=skip`.

## What You Get

| Need | MCPs |
| --- | --- |
| Route ambiguous agent tasks to the right prep tool | **HWAI Context Router** via `router-lite-mcp` |
| Prepare a stable resume point before context compaction | `context-handoff-mcp` |
| Retrieve compact repo context before edits | `retrieval-mcp`, `context-prep-mcp` |
| Understand code structure and history | `language-graph-mcp`, `repo-history-mcp` |
| Run local static checks and quality gates | `static-analysis-mcp`, `repo-quality-gate-mcp` |
| Keep a growing repo clean | `repo-hygiene-mcp`, `docs-hygiene-mcp`, `docs-sync-mcp` |
| Review contracts and dependency risk | `contract-schema-mcp`, `dependency-risk-mcp` |
| Build regression datasets from real misses | `golden-dataset-mcp`, `agent-trace-mcp` |
| Debug browser traces and visual changes | `playwright-trace-mcp`, `vision-mcp`, `visual-baseline-mcp` |
| Track test/feature pass-fail contracts between AI agent roles | `test-results-mcp` |
| Enforce TDD discipline at MCP-tool level (edit gate + test immutability + verify red) | `tdd-gate-mcp` |
| Property-based testing with hypothesis / fast-check (counterexample extraction) | `pbt-runner-mcp` |

## Measurement-Driven Routing

Different deterministic compressors win in different regimes. The same input,
the same agent task, the same output budget — but the right compressor depends
on whether the LLM needs a one-line gist, a specific fact buried in document
metadata, or a full extractive summary. Picking the wrong tier silently
loses quality.

Humanswith.ai operates an internal **measurement-driven routing layer** that
maps `(input_size, output_budget, task_type)` to the Pareto-best compressor
for that case. The mapping is deterministic — no LLM in the routing path —
and the rules are derived from a paired-corpus benchmark that scores each
candidate compressor on both byte-saving and content-preservation. Inputs
below a length threshold are routed past compression entirely (some
compressors inflate short inputs by adding wrapper sections).

The philosophy: **measurement is the moat, not the compressor.**
- Tools like `mcp-sophon` (below) are valuable in their regime.
- The agency value is knowing *when* to call which one.
- That routing intelligence is HWAI's internal stack; this public repo
  exposes the measured vendor candidates, not the routing engine.

A long-form write-up of the methodology and per-tier measurements lives
at the [research article](https://gregshevchenko.com/research/mcp-stack-token-economy/).

## Two Primary Axes: Byte Saving AND Cache-Friendliness

Byte saving is necessary but not sufficient. The second metric that decides
production cost is whether the compressor's output is **byte-identical across
runs of the same input**. Byte-identical output lets the downstream provider's
prefix cache reuse work from prior turns — turning a measured byte saving
into a real cost reduction. Non-deterministic output defeats the cache:
every turn looks like a fresh prompt to the provider and pays the full
prefill again, often eating the byte saving outright.

This framing is canon in the
[agents-best-practices](https://github.com/DenisSergeevitch/agents-best-practices)
reference (MIT, provider-neutral synthesis of OpenAI / Anthropic / MCP
guidance). The core rule: **stable prefix, dynamic suffix**. Tool definitions
and static instructions appear first in deterministic order; dynamic
runtime state appears at the end. Any volatile value injected before a
stable block destroys the cache for every downstream turn that shares
the prefix.

Our deterministic-compressor benchmark records both axes:

- **Byte-saving ratio** = `output_chars / input_chars` (lower is better).
- **Cache-friendly score** = fraction of fixtures whose output is
  byte-identical across N ≥ 2 runs of the same input
  (`unique_md5_count == 1`). 100% means full byte-stability; lower means
  downstream cache reuse drops proportionally.

A compressor that wins byte savings but loses output stability is a
single-axis benchmark hiding the other half of the cost. We report both
axes for every measured MCP — including failure modes the vendor docs
don't disclose. See the
[research article's cache-friendliness section](https://gregshevchenko.com/research/mcp-stack-token-economy/#cache-heading)
for the long-form treatment.

## Measured Vendor MCPs

The repo's local MCPs are the core stack. We also measure third-party MCPs
through our deterministic-compressor benchmark (input → output ratio + CV
variance + LLM-judged content preservation) and publish the honest result
— including failure modes the vendor docs don't disclose.

### `mcp-sophon` (npm, MIT, by lacausecrypto) — *measured 2026-05-24*

**Byte saving (passes the bar):** 92.7% mean char-saving on a 15-fixture
realistic corpus × N=5 (75 measurements). Latency 60–200 ms per call.

**Cache-friendly score: 100% (15/15 fixtures byte-stable).** CV = 0.0
across all runs — sophon's section-selector is deterministic by
construction (no LLM in the path), so downstream provider prefix-cache
reuse works correctly across turns. This is the necessary condition
for byte savings to translate into real production cost reduction.

**Content preservation (caveat-heavy):** on the same 15 fixtures with one
gpt-4o-mini-judged QA pair per fixture, sophon at `--max-tokens 500`
preserved 10/15 = 67% of correct answers vs full-context baseline (87%).
Pattern: sophon's section-selector drops document **headers, titles,
bylines, status codes, and version metadata** in favor of body content.

**`--query` parameter is ignored in CLI mode** at default budget — we
tested 4 different queries on the same input and got byte-identical
output (same SHA-256). Sophon's "query-aware" branding does not hold at
this configuration.

#### When to route to sophon

✅ **USE for:** long-document summarization where the answer is in body
content (≥1000 chars input). E.g. "give me the gist of this 24k-char
build log."

❌ **DO NOT USE for:** specific-fact lookups (version numbers, IDs,
status codes, author bylines, config values). Sophon may drop the
answer entirely.

⚠️ **Caller plumbing required:** length-gate ≥ 1000 chars (sophon
inflates shorter inputs by adding a `<general>...</general>` wrapper).

#### Install (separate from this stack)

```bash
npm install -g mcp-sophon   # MIT, no API keys
sophon doctor                # verify
```

Sophon is **not bundled** with this stack — it's a third-party MCP we've
measured. Install it on your own; route to it per the guidance above.

#### Methodology

Full measurement details: research article on the
[token-economy axes (C1/C2/C3)](https://gregshevchenko.com/research/mcp-stack-token-economy/).
Our deterministic-compressor harness measures any MCP that exposes a pure
`text → text` interface and emits per-fixture + corpus-level verdicts
against documented CV/ratio/quality bars.

## Profiles

| Profile | Installs | Best for |
| --- | ---: | --- |
| `core` | 7 MCPs | First install, safe local repo work |
| `repo` | 18 MCPs | Large codebases, docs, hygiene, local regression cases |
| `browser-debug` | 11 MCPs | Playwright traces, screenshots, visual checks |
| `full` | 21 MCPs | All local token-efficiency MCPs, no external context required |

## Verification

The installer runs `doctor` automatically. You can rerun it anytime:

```bash
~/.hwai/hwai-mcp-stack/mcp/bin/hwai-mcp.mjs doctor \
  --manifest=~/.hwai/hwai-mcp-stack/mcp/manifest.json \
  --source-root=~/.hwai/hwai-mcp-stack/mcp/source \
  --profile=full
```

Expected result for the full profile:

```text
services: 21
ok: 21
needs_attention: 0
warnings: 0
```

## Token Efficiency Claims

This stack is designed to reduce token waste by preparing compact local evidence
before an agent spends frontier-model context. It is fair to claim:

- it can reduce prompt stuffing for repo-wide questions by retrieving likely
  files/snippets first;
- it can reduce noisy context from long logs, specs, traces, and screenshots by
  turning them into compact evidence;
- it can reduce repeated manual search by teaching Claude Code, Codex, Cursor,
  and Windsurf the same local trigger vocabulary;
- raw local evidence stays local by default.

Measured local dogfood evidence
([details](./docs/local-dogfood-eval-2026-04-30.md)):

- In a 2026-04-30 local deterministic dogfood eval on 12 reviewed-public tasks,
  Humanswith.ai MCP Stack reduced aggregate context-token usage by 75.5% and
  aggregate total-token usage by 70.5% versus the baseline path.
- The same run passed the quality gate: baseline success was 91.7%, stack
  success was 100.0%, and critical false positives did not increase.
- Context-token reduction by family ranged from 35.0% to 80.8% across repo
  hygiene, traces, screenshots, logs, retrieval, and compression tasks.

This is internal dogfood evidence, not an external benchmark or leaderboard
claim.


Do **not** claim a universal percentage reduction from the public README. Token
savings depend on repo size, task type, agent behavior, and whether the agent
would otherwise paste entire files/logs/screenshots into context.

Publicly verified scope:

- `core` and `full` profile install dry-runs;
- `doctor` checks for bundled local services;
- local repo retrieval and context-prep smoke paths;
- local screenshot/trace preparation surfaces in the browser-debug profile;
- public release audit that checks for secrets and internal references.

See [Token efficiency claims](./docs/token-efficiency-claims.md) for the exact
wording to use in public materials.

## Benchmark Your Own Stack

The `benchmark/` directory contains the same primitives we use to measure
compressors under both axes (byte saving AND cache-friendliness), stripped
of any HWAI-specific fixtures or measurements. Pure Python, stdlib only,
no network.

```bash
# Run the harness on the example fixtures (5 neutral samples):
cd benchmark
python3 run_bench.py --compressor first200 --fixtures examples/fixtures.jsonl --repeat 5

# Audit any MCP / source tree against the 12 DSA cache-killing anti-patterns:
python3 anti_pattern_audit.py --mcp path/to/your-mcp/src

# Run the unit tests:
python3 -m pytest tests/ -q
```

Plug your own compressor as a `(str) -> str` function. See
[`benchmark/README.md`](./benchmark/README.md) for the full API + how to
register your own compressor in the harness. The framing for the
cache-friendliness axis comes from the canonical DSA reference at
[github.com/DenisSergeevitch/agents-best-practices](https://github.com/DenisSergeevitch/agents-best-practices)
(MIT, provider-neutral).

## Privacy And Security

- Do not trust the repository from GitHub stars or social proof; inspect and
  verify it with `bash scripts/agent-preinstall-check.sh`.
- Local repo/file evidence stays local by default.
- Durable traces live under `~/.hwai/<service-name>`.
- Generated client configs point to local stdio wrappers.
- The default install path does not use `sudo` and does not install daemons.
- Aggregate reports should not export raw code, prompts, URLs, screenshots,
  lockfiles, env files, or private docs.
- The public `full` profile is local-only and does not require API keys.
- Never commit `~/.hwai/mcp-stack/env` or generated request logs.

## Repository Layout

```text
.
├── install.sh                 # one-command public installer
├── mcp/
│   ├── manifest.json          # profiles and server catalog
│   ├── install.sh             # local bundle installer
│   ├── bin/hwai-mcp.mjs       # install/doctor CLI
│   ├── docs/                  # module docs
│   └── source/services/       # bundled local MCP servers
└── PUBLIC_RELEASE_AUDIT.md    # release safety checklist
```

## Documentation

External long-form context and background:

- [Research article — How I cut my Claude Code token usage by 75.5% with 17 local MCPs](https://gregshevchenko.com/research/mcp-stack-token-economy/)
- [Author profile — Gregory Shevchenko](https://gregshevchenko.com/) (founder of [Humanswith.ai](https://humanswith.ai/))

Repo-internal:

- [MCP bundle details](./mcp/README.md)
- [Module docs](./mcp/docs/README.md)
- [Agent autopilot docs](./mcp/docs/AGENT_AUTOPILOT.md)
- [Token efficiency claims](./docs/token-efficiency-claims.md)
- [Local dogfood eval - 2026-04-30](./docs/local-dogfood-eval-2026-04-30.md)

- [Trust and verification](./TRUST.md)
- [Verify before install](./VERIFY_BEFORE_INSTALL.md)
- [Machine-readable trust manifest](./trust/hwai-mcp-stack.trust.json)
- [Public release audit](./PUBLIC_RELEASE_AUDIT.md)
- [Security policy](./SECURITY.md)

## Daily Readiness Collector (Local launchd)

The optional daily measurement-readiness aggregator runs from a launchd
LaunchAgent. macOS TCC blocks launchd-spawned processes from reading
`~/Documents`, so running the aggregator directly from a clone under
`~/Documents` fails with `Operation not permitted` and silently stops
producing reports.

Install a standalone, TCC-safe copy into a non-protected directory instead:

```bash
# from an interactive shell (it has Documents access)
bash scripts/install-token-efficiency-collector.sh
# verify the install is byte-identical to the repo source closure
bash scripts/install-token-efficiency-collector.sh --check
```

This copies the builtins-only aggregator closure (no extra runtime deps)
into `~/.hwai/token-efficiency-collector/`, preserving the relative
`scripts/` + `mcp/source/scripts/` + `mcp/manifest.json` layout the
scripts expect. Point the LaunchAgent's `ProgramArguments` at
`~/.hwai/token-efficiency-collector/scripts/greg-dogfood-catchup.sh`
and add an `EnvironmentVariables` `PATH` (launchd's minimal `PATH` does
not include `/usr/local/bin`, so `node` would otherwise not be found).
Re-run `--check` after pulling updates to detect a stale install.

A custom MCP scope manifest can be passed with
`--manifest=/abs/path/to/manifest.json` (default: this repo's
`mcp/manifest.json`).

## Roadmap

- Improve local context compression for logs, specs, traces, and screenshots.
- Add more one-click client installers.
- Publish public-safe task examples for repo retrieval, log prep, trace prep,
  and screenshot prep.
- Keep the public install local-first and API-key-free by default.

## License

MIT. See [LICENSE](./LICENSE).
