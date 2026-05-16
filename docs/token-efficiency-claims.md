# Token Efficiency Claims

Humanswith.ai MCP Stack is a local-first prep layer for Claude Code, Codex,
Cursor, and Windsurf. It helps agents spend less frontier-model context on raw
local evidence.

## What We Can Claim

It is safe to say:

- The stack prepares compact local evidence before the frontier model reasons.
- `retrieval-mcp` helps avoid pasting or reading an entire repo when the task
  needs only likely files and snippets.
- `context-prep-mcp` helps summarize noisy local inputs such as logs, long specs,
  terminal output, and copied text before they enter the main prompt.
- `playwright-trace-mcp`, `vision-mcp`, and `visual-baseline-mcp` help turn
  traces, screenshots, and visual diffs into smaller review evidence.
- `static-analysis-mcp`, `repo-quality-gate-mcp`, dependency, contract, repo,
  and docs hygiene MCPs help agents ask for deterministic local evidence before
  making broad judgments.
- Raw repo evidence stays local by default.

## Measured Local Dogfood Evidence

The strongest measured result we can currently cite is a local deterministic
dogfood run, not an external benchmark or leaderboard result.

In the [2026-04-30 paired dogfood eval](./local-dogfood-eval-2026-04-30.md) on
12 reviewed-public tasks, Humanswith.ai MCP Stack reduced aggregate
context-token usage by **75.5%** and aggregate total-token usage by **70.5%**
versus the baseline path. The quality gate passed: baseline success was
**91.7%**, stack success was **100.0%**, and critical false positives did not
increase.

Context-token reduction by task family:

| Task family | Cases | Context-token reduction |
| --- | ---: | ---: |
| Compression | 2 | 80.8% |
| Retrieval / finding relevant files | 2 | 76.0% |
| Logs | 2 | 71.8% |
| Screenshots | 2 | 55.3% |
| Browser traces | 2 | 48.3% |
| Repo hygiene | 2 | 35.0% |

Good public wording:

> In a local deterministic dogfood eval on 12 reviewed-public tasks,
> Humanswith.ai MCP Stack reduced aggregate context-token usage by 75.5% and
> total-token usage by 70.5%, with no increase in critical false positives. This
> is internal dogfood evidence, not an external benchmark.

For course materials or talks, the safer plain-English version is:

> On our local checks, the stack showed 35-80% context-token reduction depending
> on task family. The strongest effect appears when agents would otherwise paste
> or read a lot of raw context: project search, logs, browser traces,
> screenshots, and long text compression.


## What Not To Claim Yet

Do not claim a universal percentage such as "saves 80% tokens" or "keeps quality
identical on every task".

Token savings depend on:

- repo size;
- task type;
- whether the user pasted a huge log/spec/screenshot;
- whether the agent would otherwise read many full files;
- which IDE client is using the MCP tools;
- how the agent routes and verifies the result.

## Publicly Verified Scope

The public repository currently verifies:

- `core` install dry-run;
- `full` local profile doctor;
- installer writes only expected client config and managed agent-doc targets;
- no API keys are required for the public `core` or `full` profile;
- public audit checks for secrets and internal references;
- local prep surfaces exist for repo retrieval, noisy context prep, static
  checks, git history, quality gates, docs/repo hygiene, dependency/contract
  review, trace review, screenshot review, and visual baseline comparison.

## Good Public Wording

Use:

> Humanswith.ai MCP Stack reduces token waste by routing agent tasks through
> compact local evidence before the model spends context on raw files, logs,
> traces, or screenshots.

Use:

> The public stack is local-first: the default and full local profiles do not
> require external API keys.

Avoid:

> Guaranteed X% token savings.

Avoid:

> No quality drop in all tasks.

Avoid:

> Fully automated proof that every agent will use fewer tokens.

Avoid:

> External benchmark proof or Terminal-Bench proof of MCP Stack quality.


## Lesson 8.1 Framing

For the course, explain it simply:

> Long Claude Code sessions get expensive because the model sees too much.
> MCP Stack gives Claude a local prep layer: first find, compress, summarize, and
> check the right evidence; then spend model context on the actual decision.
