# Pre-registration: N≥60 expansion of the C2 benchmark

> **Purpose of pre-registration:** convert any future analysis from
> *exploratory* (post-hoc model fitting, garden-of-forking-paths) to
> *confirmatory* (frozen hypothesis, frozen analysis plan, frozen criteria).
> A pre-registered protocol is the difference between "we ran 20 tests and one
> was significant" and "we predicted this test would be significant, and it
> was".
>
> Format inspired by **OSF Pre-Registration Templates** (Bowman et al. 2020)
> and the **AsPredicted** template (Simmons, Nelson & Simonsohn 2021),
> simplified for an engineering benchmark.

**Pre-registration date:** 2026-05-24
**Author:** Gregory Shevchenko (Humanswith.ai)
**Status:** DRAFT — NOT YET FROZEN. Freeze requires Greg sign-off + axis 4 (independent evaluator) selection.

---

## 1. Hypotheses (specified BEFORE running the experiment)

### Primary hypothesis (H1)
On a corpus of `M ≥ 60` long-form text fixtures drawn from 5+ distinct genres
(code, prose, dialog, logs, structured data), the **mean byte-saving** of
`compressor_B` will exceed the **mean byte-saving** of `sophon_500t` by
at least `Δ_min = 0.05` (5 percentage points), in steady state.

**Statistical test:** Welch's two-sided t-test on per-(fixture, run) byte-
saving observations pooled across genres, with cluster-bootstrap 95% CI for
the difference. Reject H_0 if the bootstrap CI excludes zero AND `Δ_observed
> Δ_min`. Power analysis (§ 5) estimates required N.

### Secondary hypothesis (H2)
Both `sophon_500t` and `compressor_B` will satisfy `κ ≥ 0.95` (Wilson
95% lower bound, cache-friendly proportion) on every genre subgroup. **Reject
H_0 if Wilson lower bound on any genre is < 0.95.**

### Tertiary hypothesis (H3, exploratory)
Fixture genre is a stronger predictor of byte-saving variance than compressor
choice (replicating the 74.8%/26.2% split observed on the N=15 corpus). This
is exploratory because we cannot pre-specify the genre-split percentages
without seeing the new corpus; we pre-commit only to the direction (genre >
compressor in variance attribution).

---

## 2. Frozen experimental design

### 2.1 Compressors (frozen)
- `sophon_500t` (mcp-sophon@0.5.4, `--max-tokens 500`, default query)
- `compressor_B` (placeholder for the second compressor under primary test (configure per your project))
- *Optional* (pre-registered as supplementary, not primary): `sophon_200t`,
  `sophon_1000t`, `compressor_B (default config)` (max_compact_chars=7000) — to enable
  monotonicity check across budget.

### 2.2 Corpus (frozen design — content drawn post-registration)
Source materials drawn from **public OSS repositories** (not HWAI-internal),
stratified by genre:

| Genre | Target fixtures | Source | Bias to disclose |
|---|---|---|---|
| Code (Python) | 12 | `pallets/flask`, `sindresorhus/got` (sample) | repo selection by author |
| Code (TypeScript) | 12 | `anthropic-ai/sdk-typescript`, `vercel/next.js` | repo selection by author |
| Prose docs | 12 | Astro / FastAPI / Vue.js docs sites | doc style varies |
| CI/test logs | 8 | Anonymized public GitHub Actions logs | log format varies |
| Structured data (JSON / YAML / config) | 8 | npm package.json, Cargo.toml, Compose files | format heterogeneity |
| Dialog (chat / commit messages) | 8 | OSS PR threads (BSD/MIT-licensed) | natural-language style |
| **TOTAL** | **60** | — | — |

Each fixture: 2 KB – 50 KB raw text. Distribution intentionally heavy on
long-form (>5 KB) per existing C2 length-gate ≥1000 chars at caller.

**Selection rule (frozen):** sample `n` fixtures uniformly at random from a
larger pool of candidates (≥3× the target per genre), with `random.seed(42)`.
Sampling done in one pass before measurement begins; the seed is published
with the protocol.

**Exclusion criteria (frozen):**
- Fixtures whose raw character count is < 1000 (below the length-gate where
  compressors inflate rather than compress).
- Fixtures containing PII, credentials, or proprietary content (auto-flagged
  by `screenshot-secret-scan`-style entropy + filename rules; manual review
  for residual matches).
- Fixtures that fail UTF-8 validation.

### 2.3 Measurement protocol (frozen)
- N = 5 runs per (compressor × fixture) — same as round 1 — captured in one
  contiguous process invocation per (compressor, corpus) pair.
- Wall-clock latency recorded per call; **NOT** used as a primary metric (it
  is descriptive only; cf. §4 below).
- Compressor binaries pinned by SHA in `provenance.md` (axis 3 reproducibility
  package).
- Workspace state pinned: repo at fixed commit, env vars frozen, no network
  calls during measurement (except for compressors that intrinsically require
  it, e.g. scraper-mcp; those are excluded from the per-compressor cell here).

### 2.4 Analysis plan (frozen, executed only after data collection complete)
- Per-compressor: cluster-bootstrap 95% CI on B (2000 resamples, seed=42,
  cluster=fixture).
- Per-compressor: Wilson 95% CI on κ (cache-friendly proportion).
- Pairwise compressors: Welch t-test on per-(fixture, run) B observations,
  Cohen's d effect size, Holm-Bonferroni adjustment across all pairs.
- Variance decomposition: method-of-moments two-way random-effects ANOVA
  (compressor × genre × fixture-within-genre × run).
- **Per-genre** repetition of the above (sub-analyses), with Holm-Bonferroni
  across genres for the cross-genre tests.

All analyses run from `scripts/mcp-token-eval/c2_bench/run_statistical_analysis.py`
without modification. No post-hoc model fitting allowed — if the data
suggests a different model would be more appropriate, that becomes a separate
exploratory analysis, clearly labeled as such, and does NOT contribute to
hypothesis testing.

---

## 3. Stopping rule (frozen)

- **Primary stop:** all 60 (compressor × fixture × 5-run) cells have been
  measured. No early stopping for "significance" (would inflate false-positive
  rate via optional stopping).
- **Early termination only for:**
  - Compressor binary unavailable (network outage, binary corruption) →
    document gap, do NOT impute.
  - Fixture decoding failure (UTF-8 corruption mid-stream) → exclude that
    fixture, replace from same-genre reserve pool.
  - Resource exhaustion (e.g. Mini OOM during compressor_B (default config) on a 50 KB
    fixture) → cap fixture size at 20 KB, document.

---

## 4. Metrics — what we DO NOT report as primary

The following are deliberately *NOT* primary metrics in this study because
they confound construct with measurement:

- **Wall-clock latency.** Latency varies by host load, network state, and
  compressor warm-cold start. Useful as a descriptive supplement; NOT a
  primary axis for compressor comparison.
- **Token-based byte saving** (vs character-based). Token boundary differs
  by tokenizer; not portable across providers. Character-based B is the
  standard.
- **Quality preservation Q via LLM judge** within the same analysis as B.
  Q is measured separately (`quality_eval/run_quality_eval.py`) because it
  introduces an LLM judge (sampling noise, author-judge contamination —
  see formalization.md § 5.3).
- **Production cost C_prod.** Derived from (B, K, Q) via the formalization.md
  § 2.4 cost model; not directly measured in this study.

---

## 5. Power analysis (pre-specified, before data collection)

For the primary hypothesis (Welch t-test on `Δ_B ≥ 0.05` with `α=0.05`):

- **Observed effect** in round 1 (N=15): `d = 0.77` (medium-large).
- **Target effect for round 2:** detect `d ≥ 0.5` (smallest interesting
  effect, per Cohen's "medium" threshold) with **power ≥ 0.80** at `α=0.05`.
- **Required total N** (Welch, two-sided, equal-variance approximation):

`N_total ≈ 2 · (z_{1-α/2} + z_{1-β})² / d² + 1`
`     ≈ 2 · (1.96 + 0.84)² / 0.25 + 1`
`     ≈ 64`

→ N=60 fixtures × 5 runs × 2 compressors = 600 observations / 2 compressors
= 300 per compressor, far exceeding the N=64 minimum. **Power for d ≥ 0.5
exceeds 0.99** at this corpus size.

For the cache-friendliness hypothesis (Wilson lower bound ≥ 0.95):
- Wilson formula requires ~75 success at full 95% level to give a lower bound
  of 0.95 (in the limit of all-success). At M=60 with all-success, the
  Wilson lower bound is 0.940 — JUST below the threshold. **The H2 test will
  be borderline-powered at M=60**; consider M=75 if H2 is the primary
  decision variable.

---

## 6. What freezes when this document freezes

Once Greg signs off and axis 4 (independent evaluator) is engaged, the
following become immutable (any change resets the pre-registration):

- Hypotheses H1-H3 (text).
- Corpus design (genre quotas, source-repo allowlist, selection seed=42).
- Compressors under primary test (sophon_500t, compressor_B).
- Statistical analysis pipeline (the library functions called, the order, the
  thresholds).
- Stopping rule.

The following may change without resetting:

- Documentation prose (formatting, examples, README polish).
- Bug fixes to the analysis library that do not change numerical output on
  unit tests already written.
- Adding *supplementary* compressors (cf. § 2.1) — labeled exploratory.

---

## 7. Cross-references

- `formalization.md` — formal definitions of B, K, Q, C_prod the protocol uses.
- `statistical_analysis_v3.md` — round 1 (N=15) results that motivated this design.
- `scripts/mcp-token-eval/c2_bench/statistical_analysis.py` — the library this protocol commits to using.
- `tests/test_statistical_analysis.py` — pins library behavior so future bug-fixes don't change registered analysis output silently.
- **OSF DOI:** TBD (allocate when freezing).
- **Independent evaluator:** TBD (axis 4, Greg D2 decision).

## 8. References

- Bowman, S. D., et al. (2020). OSF Pre-Registration Templates.
- Simmons, J. P., Nelson, L. D., & Simonsohn, U. (2021). Pre-registration: Why and how. *Journal of Consumer Psychology* 31: 151-162.
- Cohen, J. (1988). *Statistical Power Analysis for the Behavioral Sciences*. 2nd ed.
- Munafò, M. R., et al. (2017). A manifesto for reproducible science. *Nature Human Behaviour* 1: 0021.
