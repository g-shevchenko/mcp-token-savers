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

## Lesson 8.1 Framing

For the course, explain it simply:

> Long Claude Code sessions get expensive because the model sees too much.
> MCP Stack gives Claude a local prep layer: first find, compress, summarize, and
> check the right evidence; then spend model context on the actual decision.
