# Datasheet — long_realistic_v3 fixtures (Methods v3)

> Following Gebru et al. (2018), *Datasheets for Datasets* (arXiv:1803.09010).
> Format adapted for an engineering benchmark corpus rather than an ML
> training dataset. The same disclosure template can be re-used for the
> N≥60 expansion corpus when it is curated (cf. `preregistration_n60.md`).

## 1. Motivation

### 1.1 For what purpose was the dataset created?
To measure C2 compressor behaviour (byte-saving B + cache-stability K) under
controlled inputs that are **representative of agent context** — long-form
text payloads an LLM agent would receive in production.

Specifically: build logs, stack traces, README files, Claude conversation
exports, git diffs, code files, dialog transcripts. Not toy synthetic strings,
not pathological adversarial inputs.

### 1.2 Who created the dataset?
Humanswith.ai team (primary curator: Gregory Shevchenko). Sourced from
public OSS materials where licensable, or constructed from publicly-derivable
forms (e.g. a synthetic but plausible build log).

### 1.3 Who funded the creation?
Internal Humanswith.ai R&D budget. No external sponsor influenced fixture
selection.

## 2. Composition

### 2.1 What does each fixture represent?
A single text payload, ranging from ~2 KB to ~15 KB raw character count.
Format: JSONL with `{"id": "<slug>", "input": "<text>"}` per line.

### 2.2 How many fixtures?
15 in this corpus (`long_realistic_v3.jsonl`).

Distribution by content type (informal, ad-hoc — formal genre stratification
arrives in the N≥60 expansion):

| Fixture id | Type | ~chars |
|---|---|---|
| long-git-diff | code diff | ~6,200 |
| long-claude-conversation | dialog | ~5,800 |
| long-readme-prose | docs | ~9,400 |
| long-build-log | logs | ~3,700 |
| long-stack-trace | logs (Python traceback) | ~3,200 |
| (10 more, sourced from project docs / blog posts / config files) | mixed | variable |

### 2.3 Is each fixture self-contained?
Yes. Each fixture is a single text payload that can be compressed
independently. No cross-fixture references.

### 2.4 Is there a label / target?
No — this is a benchmark for measurement, not a supervised-learning corpus.
The "ground truth" for B is `1 − |c(t)|/|t|` computed at runtime; for K it
is the deterministic md5 comparison across N runs.

### 2.5 Are there any errors / sources of noise / redundancies?
- **Fixture overlap risk:** the long-claude-conversation fixture may include
  prose patterns similar to the long-readme-prose fixture. This was NOT
  systematically tested. The N≥60 expansion's genre stratification controls
  for this explicitly.
- **Length distribution skew:** all fixtures are ≥1000 chars by design
  (length-gate); the corpus does NOT cover the 0-1000 char regime where
  compressors typically inflate rather than compress.

### 2.6 Does the dataset contain confidential / PII data?
**No.** Manual review confirmed no PII, no credentials, no internal HWAI
secrets. Stack traces are constructed (not from real production); the
"Claude conversation" fixture is generic / public-facing.

### 2.7 Does the dataset contain data that could be offensive / insulting?
No.

## 3. Collection process

### 3.1 How was the data acquired?
Hand-curated from a mix of:
- Public OSS README files (Astro, FastAPI, etc).
- Build logs from CI runs on public-facing services.
- Constructed-but-realistic dialog (paraphrased style of agent transcripts,
  no actual user data).
- Code excerpts from MIT/BSD-licensed public repos.

### 3.2 Over what timeframe?
2026-05-24 (single-day curation). The N≥60 expansion will pull from
larger source pools over a longer timeframe; cf. `preregistration_n60.md`.

### 3.3 Was the data validated?
- File-level: UTF-8 validity check (passed for all 15).
- Length floor: all fixtures ≥1000 chars (passed).
- License: spot-checked sources for permissive licenses.
- **No** inter-annotator agreement (this is a benchmark, not a labelled
  dataset).

## 4. Recommended uses

### 4.1 For what tasks is this dataset suitable?
- **Byte-saving rate measurement** for any text→text compressor.
- **Cache-stability measurement** for deterministic compressors.
- **Comparative benchmarking** of multiple compressors on the same inputs.

### 4.2 For what tasks is it NOT suitable?
- **Production traffic estimation.** This corpus is curated, not sampled
  from a production traffic distribution. Generalisations to "expected
  saving on your codebase" are not warranted.
- **Adversarial robustness.** No pathological inputs (e.g. random strings,
  encoding bombs, near-duplicate runs). Compressors should be tested on
  adversarial inputs separately.
- **LLM judge / quality preservation** for non-deterministic compressors.
  The fixtures are not paired with reference outputs.

### 4.3 What sub-populations are over- / under-represented?
- **Over-represented:** English-language docs and prose. Python code.
- **Under-represented:** non-Latin scripts, structured JSON/YAML, log
  formats with heavy timestamp noise.
- **Missing entirely:** binary data, deliberately obfuscated text, real
  user-generated content (privacy concern).

These gaps are addressed in the N≥60 expansion via genre quotas.

## 5. Distribution

### 5.1 Will the dataset be distributed?
Yes — it is committed to the public `g-shevchenko/mcp-token-savers`
repository at `mcp/source/scripts/mcp-token-eval/c2_bench/fixtures/long_realistic_v3.jsonl`.

### 5.2 Under what license?
The fixture file is included under the repository's MIT license. The
underlying source materials (README files, etc.) retain their original
licenses; this corpus is a transformative excerpt for benchmarking
purposes.

### 5.3 Are there any IP restrictions or applicable terms of use?
No. All sources permit non-commercial benchmarking. The corpus is small
enough to fall under fair-use for any commercial-research purpose.

## 6. Maintenance

### 6.1 Who maintains the dataset?
Gregory Shevchenko / Humanswith.ai team. Issues / PRs welcome on
`g-shevchenko/mcp-token-savers`.

### 6.2 Will the dataset be updated?
- **`long_realistic_v3.jsonl` is frozen** at SHA `255fe8674e103ef4a863c141359a832d73986b30`.
- A **`long_realistic_v4.jsonl`** with the N≥60 genre-stratified expansion
  is planned per `preregistration_n60.md`.
- The frozen v3 file remains in the repo for historical reproducibility
  (Methods v3 SHAs in `provenance.md`).

### 6.3 Are there errata?
None known at publication. File issues at `g-shevchenko/mcp-token-savers/issues`.

## 7. Known limitations (one-liner summary)

- **N=15 is small.** Cluster-bootstrap CIs are usable but wide on κ at boundaries (cf. Wilson [0.796, 1.0]).
- **Genre mix is informal.** Future v4 corpus formalizes the stratification.
- **Hand-curated.** Author-contamination risk per `.claude/rules/blind-validation-when-author-contaminated.md`; independent evaluator engagement is the durable mitigation (axis 4).

## 8. References

- Gebru, T. et al. (2018). *Datasheets for Datasets*. arXiv:1803.09010.
- Bender, E. M. & Friedman, B. (2018). Data statements for natural language processing. *TACL* 6: 587-604.
- See also `formalization.md` § 5.2 (external validity threats).
