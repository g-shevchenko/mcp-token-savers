# Statistical analysis — applied to a public sophon measurement

> Real-data demonstration of the `methods/lib/` library on the public
> `mcp-sophon@0.5.4` compressor and the 15-fixture corpus in this repo.
> Reproducible from a clean clone with no HWAI-internal dependencies.
>
> If you measure your own compressor, this file is the template for what
> a peer-reviewable result table looks like.

## 1. What this document is

Three numbers are commonly reported about a compressor:

- **Mean byte-saving** (a point estimate of `B = 1 − |c(t)|/|t|`)
- **Cache-friendly score** (a point estimate of `κ`, the fraction of
  fixtures on which the compressor's output is byte-identical across `N`
  repeated runs)
- **Pass rate against a byte-saving bar** (e.g. 14 of 15 fixtures
  achieve `B ≥ 0.30`)

Point estimates without uncertainty are easy to overinterpret. This
document re-presents the same measurement with:

- **Cluster-bootstrap 95% CI** on mean byte-saving (cluster = fixture,
  because runs within the same fixture are not iid).
- **Wilson 95% CI** on cache-friendly score (binomial proportion CI
  that works correctly at the 0/N and N/N boundaries, where the Wald
  normal-approximation CI degenerates to a point).
- **Variance decomposition** of byte-saving into fixture / compressor /
  residual via method-of-moments two-way random-effects ANOVA.
- **Pre-registered protocol** for the next-round expansion (see
  `preregistration_n60.md`), converting future analyses from
  exploratory to confirmatory.

## 2. Sophon@0.5.4 on long_realistic_v3 (N=5 runs × M=15 fixtures = 75 observations)

The numbers below were measured on a clean public clone of this repo
at the commit pinned in `provenance.md`. Anyone with the listed env
should reproduce the same numbers to byte identity (cluster-bootstrap
RNG seed = 42; sophon is deterministic on this input).

| metric | point | 95% CI | notes |
|---|---|---|---|
| mean byte-saving `B̄` | **0.828** | **[0.721, 0.900]** (cluster-bootstrap, 2000 resamples, cluster=fixture) | CI captures between-fixture variability |
| cache-friendly `κ` | **1.000** (15/15) | **[0.796, 1.000]** (Wilson 95%) | Wald would degenerate to `[1.0, 1.0]`; Wilson correctly reports the population uncertainty even at full success |
| pass rate at `B ≥ 0.30` bar | 14/15 = 0.933 | [0.701, 0.988] (Wilson) | one fixture didn't clear the bar |

**Why the Wilson CI matters.** A naive reader sees "100% cache-friendly
on 15 fixtures" and infers the population proportion is 100%. The
Wilson interval — the standard binomial-proportion CI used in clinical
trials and engineering benchmarks — shows the honest answer:
**≥79.6% with 95% confidence** on a population this corpus is a sample
of. The point estimate is 100%, but the binomial CI is wide at small N.
Anyone publishing or citing a "100% cache-friendly" number without that
caveat is over-claiming on small N.

## 3. Variance decomposition

For a single-compressor analysis, the question "where does the
between-fixture spread in byte-saving come from?" is answered by
variance decomposition. The 15 fixtures × 5 runs design has zero
residual variance (sophon is byte-deterministic), so the between-
fixture component captures everything:

| component | σ² | % of total |
|---|---|---|
| between-fixture (which fixture you measured) | 0.018 | **100.0%** |
| residual (run-to-run noise) | 0.000 | **0.0%** (sophon deterministic) |

For a multi-compressor comparison (e.g. sophon vs another candidate),
the decomposition adds a `between-compressor` component and tells you
whether the choice of compressor matters more than the choice of input.
On a typical mixed corpus, `between-fixture` dominates — meaning your
benchmark verdict depends heavily on which inputs you sample. Pre-
registered genre stratification (see `preregistration_n60.md` § 2.2)
controls for this.

## 4. Adding your compressor to this analysis

```bash
# (1) Run the c2_bench harness on YOUR compressor, capture JSON output:
cd benchmark/c2_bench
python3 run_c2_bench.py \
  --compressor <your_compressor> \
  --fixtures fixtures/long_realistic_v3.jsonl \
  --repeat 5 --json > /tmp/your_compressor.json

# (2) Compare against sophon (or any second JSON):
python3 ../../methods/lib/run_statistical_analysis.py \
  /tmp/sophon_500t_v3.json \
  /tmp/your_compressor.json
```

The output includes all three CIs above, a pairwise Welch t-test with
Cohen's d effect size, and Holm-Bonferroni-adjusted p-values for
multiple-comparison control. The library is pure Python stdlib (no
scipy, no statsmodels) and runs in any Python 3.11+ environment.

If your compressor is also byte-deterministic, your `κ` will be 1.0
(15/15) with the same Wilson `[0.796, 1.000]` CI on a 15-fixture
corpus. The point estimates differ; the CI width is identical at fixed
N. Beat that uncertainty by expanding the corpus (see `preregistration_n60.md`).

## 5. The mathematical hook that founded this analysis

The article that motivates this benchmark suite includes a rhetorical
hook: "a 99% byte-saver can produce *worse* production cost than a
60% saver". Section 3 of `formalization.md` derives the **exact
condition** under which that hook holds:

`b_A < 1 − (1 − b_B) · ρ`

where `b_A` is the high-byte-saving compressor's saving, `b_B` is the
moderate-saving compressor's saving, and `ρ ≈ 0.10` is the provider's
cached-input-token discount ratio (Anthropic Sonnet 4.5, OpenAI
GPT-4.x, Gemini 2.5 sit in 0.10 – 0.25). For typical `(b_B = 0.60,
ρ = 0.10)` the hook holds for `b_A < 0.96`. At literal `b_A = 0.99`,
the byte-saving advantage dominates and the hook does **not** apply.

The hook IS correct for the band of measured compressors that exist
(typically `b ≈ 0.7 – 0.95`), but it's rhetorical, not mathematical, at
the boundary value of 99%. Future article revisions should clarify.

## 6. Threats to validity (Cook-Campbell taxonomy)

See `formalization.md` § 5 for the full enumeration. Headline:

- **Internal validity** — workspace state doesn't enter the input, and
  sophon doesn't use wall-clock or randomness; non-determinism would
  surface as `κ < 1.0` and is therefore observable.
- **External validity** — the 15-fixture corpus is small. CIs are wide.
  Future N≥60 expansion stratifies by genre to bound this.
- **Construct validity** — quality preservation `Q` is measured
  separately (see `benchmark/quality_eval/`); we deliberately do not
  pool quality and byte-saving into one statistical test.
- **Statistical validity** — N=5 per fixture is small but cluster
  bootstrap properly accounts for the dependence. Holm-Bonferroni
  controls family-wise error for the pairwise compressor comparison
  in multi-compressor reports.

## 7. References

- Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference. *JASA* 22(158): 209-212.
- Efron, B. & Tibshirani, R. J. (1993). *An Introduction to the Bootstrap*. Chapman & Hall/CRC.
- Welch, B. L. (1947). The generalization of "Student's" problem when several different population variances are involved. *Biometrika* 34: 28-35.
- Holm, S. (1979). A simple sequentially rejective multiple test procedure. *Scandinavian Journal of Statistics* 6(2): 65-70.
- Cohen, J. (1988). *Statistical Power Analysis for the Behavioral Sciences*. 2nd ed.
- Searle, S. R., Casella, G., & McCulloch, C. E. (1992). *Variance Components*. Wiley.
- Cook, T. D. & Campbell, D. T. (1979). *Quasi-experimentation: Design & Analysis for Field Settings*. Houghton Mifflin.
