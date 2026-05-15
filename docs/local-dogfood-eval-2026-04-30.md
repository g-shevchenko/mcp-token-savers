# Local Dogfood Eval - 2026-04-30

This page summarizes the current measured token-efficiency evidence for
Humanswith.ai MCP Stack.

Status: **local deterministic dogfood run**.

This is not an external benchmark, a leaderboard submission, or a universal
performance guarantee. It is a public-safe summary of an internal paired
baseline-versus-stack run on reviewed-public task families.

## Aggregate Result

| Metric | Result |
| --- | ---: |
| Cases | 12 |
| Baseline success | 91.7% |
| Stack success | 100.0% |
| Success delta | +8.3% |
| Context-token reduction | 75.5% |
| Total-token reduction | 70.5% |
| Critical false-positive delta | 0 |
| Gate | PASS |

## By Task Family

| Task family | Cases | Baseline success | Stack success | Context-token reduction |
| --- | ---: | ---: | ---: | ---: |
| Compression | 2 | 100.0% | 100.0% | 80.8% |
| Retrieval / finding relevant files | 2 | 50.0% | 100.0% | 76.0% |
| Logs | 2 | 100.0% | 100.0% | 71.8% |
| Screenshots | 2 | 100.0% | 100.0% | 55.3% |
| Browser traces | 2 | 100.0% | 100.0% | 48.3% |
| Repo hygiene | 2 | 100.0% | 100.0% | 35.0% |

## What The Tasks Covered

The 12 cases covered tasks where agents often waste context:

- finding installer and `doctor` entrypoints in a repo;
- finding trust and preinstall documentation before running an installer;
- compacting Node build and test failure logs;
- preserving quality-gate details during context compression;
- preserving Terminal-Bench planning details during context compression;
- summarizing repo hygiene issues such as committed generated artifacts and a
  missing license;
- preparing browser trace evidence for a 404 after click and an API 500 before
  an empty table;
- preparing screenshot evidence for mobile CTA overlap and a clipped desktop
  modal.

## Safe Public Wording

Use:

> In a local deterministic dogfood eval on 12 reviewed-public tasks,
> Humanswith.ai MCP Stack reduced aggregate context-token usage by 75.5% and
> total-token usage by 70.5%, with no increase in critical false positives. This
> is internal dogfood evidence, not an external benchmark.

Use:

> On these local checks, context-token reduction ranged from 35.0% to 80.8%
> depending on task family. The strongest effect appears when agents would
> otherwise paste or read lots of raw context: project search, logs, browser
> traces, screenshots, and long text compression.

Avoid:

> Guaranteed 75% token savings.

Avoid:

> Quality never drops.

Avoid:

> Terminal-Bench proves MCP Stack quality.

Avoid:

> External benchmark proof.
