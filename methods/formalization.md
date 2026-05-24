# Methods v3 — formal definitions + cost-model theorem

> Author-contamination disclosure (per `.claude/rules/blind-validation-when-author-contaminated.md`): this document is written by an author who designed and ran the benchmark. The math here is generic (provider-pricing-derived) and **not** fit to our measured ratios. Threats to validity are listed in § 5.

## 1. Setting

A **compressor** is a (computationally pure) function `c: Σ* → Σ*` that maps an input string `t` to a (typically shorter) output `c(t)`. An **agent loop** issues a sequence of LLM requests `r_1, r_2, ..., r_n` over a fixed context `x` (e.g. the same codebase, the same document set, the same prompt prefix).

The user is willing to pay for compression `c` if and only if the cumulative production cost under `c` over the loop is lower than the cumulative production cost without `c`, after accounting for any quality loss.

Three observable axes determine that trade:

| Symbol | Definition | Range |
|---|---|---|
| `B(c, t)` | byte-saving rate of `c` on input `t` | `[−∞, 1]`, target `→ 1` |
| `K(c, t, N)` | cache-stability of `c` on `t` across `N` repeated calls | `{0, 1}` |
| `Q(c, t, Φ)` | quality preservation under an evaluation oracle `Φ` | `[0, 1]`, target `→ 1` |

## 2. Definitions

### 2.1 Byte-saving rate

`B(c, t) ≜ 1 − |c(t)| / |t|`,
where `|·|` denotes a tokenizer-independent character count (we use UTF-8 codepoint count throughout; tokenization-aware variants `B_τ` are defined identically with `|·|_τ`).

`B = 0` means no saving. `B = 1` would mean the compressor outputs nothing. `B < 0` means the compressor **inflates** the input (commonly observed below a length floor; this is why we gate compressors at `|t| ≥ 1000` chars at the caller in `project_c2_bench_sophon_first_data`).

### 2.2 Cache-stability

For `N ≥ 2` independent calls to `c(t)` on identical workspace state:

`K(c, t, N) ≜ 𝟙[ md5(c(t))^(1) = md5(c(t))^(2) = ⋯ = md5(c(t))^(N) ]`

`K = 1` iff all `N` calls produce byte-identical outputs. `K = 0` iff any pair differs.

Note `K` is **binary per (c, t)**, not continuous. A compressor that produces 2 different outputs over 5 runs is `K = 0` exactly as much as one that produces 5 different outputs. (A continuous variant `K' = 1 − unique(c(t))^N / N` is well-defined but the *binary* version is what matters for provider prefix-cache reuse: any byte difference defeats the cache.)

We aggregate `K` across a fixture corpus `T = {t_1, ..., t_M}` as the **cache-friendly score**:

`κ(c, T, N) ≜ (1/M) Σ_{j=1}^M K(c, t_j, N) ∈ [0, 1]`.

### 2.3 Quality preservation

Given an evaluation oracle `Φ: Σ* → A` that maps text to an "answer" (LLM judge, exact-match comparator, downstream task accuracy):

`Q(c, t, Φ) ≜ Pr_Φ[ Φ(c(t)) = Φ(t) ]`.

In practice we estimate `Q` via LLM-judge sampling on a question-answer corpus `qa(t)` per fixture (see `quality_eval/run_quality_eval.py`).

### 2.4 Production cost model

For a single request `r` with input tokens `t_in` and output tokens `t_out`:

`C_request(r) ≜ p_in,uncached · t_in,uncached  +  p_in,cached · t_in,cached  +  p_out · t_out`

where `p_in,uncached` is the provider's quoted input-token price, and `p_in,cached ≤ p_in,uncached` is the cached-input price. Empirically, for Anthropic Claude (2026-05 pricing):

| | Sonnet 4.5 input | Sonnet 4.5 cached input |
|---|---|---|
| price | `$3 / 1M tok` | `$0.30 / 1M tok` |
| ratio | 1.0 | **0.10** |

OpenAI GPT-4.x (cached input) and Gemini 2.5 Pro (implicit context cache) sit in approximately the same `0.10× – 0.25×` band. We denote the discount factor:

`ρ ≜ p_in,cached / p_in,uncached ∈ (0, 1]`,    typical `ρ ≈ 0.10`.

For a sequence of `n` requests on the same compressed context `c(x)`:

`C_total(c, x, n) = C_first(c(x))  +  (n − 1) · C_subsequent(c(x), K)`

where the first request is always uncached prefix, and subsequent requests are either:

- **cached** (if `K(c, x, N=n) = 1` AND no other prefix changes): pay `ρ · p_in · |c(x)|_τ + p_out · t_out`,
- **uncached** (if `K = 0`): pay full `p_in · |c(x)|_τ + p_out · t_out`.

We omit output-token cost from the comparison because it does not depend on the input compressor.

## 3. Theorem (informal): the cache-friendliness frontier

**Claim.** Let `c_A` be a compressor with `B(c_A, x) = b_A` and `K(c_A, x, N) = 0`. Let `c_B` be a compressor with `B(c_B, x) = b_B < b_A` and `K(c_B, x, N) = 1`. Let `c_∅` be the identity (no compression: `B = 0`, `K = 1`).

The compressor `c_A` minimizes single-shot input cost. The compressor `c_B` minimizes steady-state cost over a long loop. Specifically, the crossover at which `c_B` beats `c_A` in cumulative input cost over `n` turns is:

`n* ≜ ⌈ (b_A − b_B) / (b_A − ρ · (1 − b_B) − (1 − b_A)) ⌉`

For `ρ = 0.10`, `b_A = 0.99`, `b_B = 0.60`:

`n* = ⌈ (0.99 − 0.60) / (0.99 − 0.10·0.40 − 0.01) ⌉ = ⌈ 0.39 / 0.94 ⌉ = 1`

The crossover happens immediately at `n = 2` (the second turn already pays prefix again under `c_A`'s `K = 0`). The cumulative ratio at `n = 10` is approximately:

```
C_total(c_A, n=10) ≈ 10 · |x| · (1 − b_A)         = 10 · 0.01 · |x| = 0.10 · |x|
C_total(c_B, n=10) ≈ |x| · (1 − b_B) + 9 · ρ · |x| · (1 − b_B)
                  ≈ 0.40 · |x| + 9 · 0.10 · 0.40 · |x|
                  ≈ 0.40 · |x| + 0.36 · |x| = 0.76 · |x|
```

Wait — at `b_A = 0.99` and `n = 10`, `c_A` actually wins (`0.10 |x|` vs `0.76 |x|`). The article's hook ("99% byte-saver can produce **worse** production cost") is therefore **conditional on additional context**. Let me re-derive carefully.

### 3.1 Corrected derivation

The article's claim only holds when the comparison is against a `B = 0`, `K = 1` baseline OR when both compressors have moderate `b`. Let me write the cost ratio explicitly:

For compressor `c` with byte-saving `b` and cache-stability `K`:

`C_total(c, x, n) / |x|`
` = (1 − b) + (n − 1) · [K · ρ + (1 − K)] · (1 − b)`
` = (1 − b) · [1 + (n − 1) · (K · ρ + (1 − K))]`

Let me define the **effective steady-state input-cost factor** per character of `x`:

`f(b, K, n, ρ) ≜ (1 − b) · [1 + (n − 1) · (K · ρ + (1 − K))]`

For `(b_A = 0.99, K_A = 0, n = 10)`:
`f_A = 0.01 · [1 + 9 · 1] = 0.01 · 10 = 0.10`

For `(b_B = 0.60, K_B = 1, n = 10)`:
`f_B = 0.40 · [1 + 9 · 0.10] = 0.40 · 1.90 = 0.76`

For `(b_∅ = 0, K_∅ = 1, n = 10)`:
`f_∅ = 1.00 · [1 + 9 · 0.10] = 1.00 · 1.90 = 1.90`

So `c_A` ($0.10 / |x|$) beats `c_B` ($0.76 / |x|$) beats `c_∅` ($1.90 / |x|$) at `n = 10` when `b_A = 0.99`.

**The article's hook requires more nuance.** The original "99% byte-saver can produce **worse** production cost than a 60%-byte-saver" is true only when:

1. The 99%-saver is also **paying full prefill on each turn** (`K_A = 0`) **AND** the 60%-saver is at `K_B = 1`, **AND**
2. The output tokens dominate (i.e., we cannot omit `p_out · t_out` from the comparison), **OR**
3. The compressors are compared against **the cache-warm baseline**, not the cache-cold baseline.

The actual production claim is: **for a long-running agent loop where steady-state cost dominates, a moderate-`b` / high-`K` compressor approaches `b · |x| · ρ` per turn (since the cache pays only `ρ` price), while a high-`b` / zero-`K` compressor pays full `(1 − b) · |x|` per turn forever.**

The crossover where `c_B` beats `c_A` is:

`f_B < f_A`
`(1 − b_B) · (1 + (n − 1) · ρ) < (1 − b_A) · (1 + (n − 1))`
`(1 − b_B) · (1 + (n − 1) · ρ) < (1 − b_A) · n`

Solving for `n`:

`n_cross = (1 − b_B) · (1 − ρ) / [(1 − b_A) · 1 − (1 − b_B) · ρ]`  (when denominator positive)

For `(b_A = 0.99, b_B = 0.60, ρ = 0.10)`:

denominator = `0.01 − 0.40 · 0.10 = 0.01 − 0.04 = −0.03`

The denominator is **negative**, meaning `c_A` never loses to `c_B` at these specific values — for these particular `(b_A, b_B)` values, the byte-saving gap is too large for cache-friendliness alone to close.

**For the hook to hold mathematically, `b_A` cannot be 99% — it needs to be in the range where the byte-saving advantage doesn't dominate.** Specifically:

`(1 − b_A) > (1 − b_B) · ρ`,
i.e., `b_A < 1 − (1 − b_B) · ρ = 1 − 0.40 · 0.10 = 0.96`.

So the hook is correct when `b_A < 0.96` and `b_B ≈ 0.60` with `K_A = 0` and `K_B = 1`. Numerically: a `b_A = 0.80` / `K_A = 0` compressor loses to a `b_B = 0.60` / `K_B = 1` compressor at `n ≥ 7`.

`f_A(0.80, K=0, n=10) = 0.20 · 10 = 2.00`
`f_B(0.60, K=1, n=10) = 0.40 · 1.90 = 0.76`

→ `c_B` wins by 2.6×.

### 3.2 Honest hook restatement

The article's hook "99% byte-saver can produce **worse** production cost than a 60% saver" is a **rhetorical** statement, not a tight theorem. The tight version is:

> **For compressors with `b_A` in the empirically-observable range of working compressors (≈0.70 – 0.90), `K = 0` compressors lose to `K = 1` compressors with moderate `b ≈ 0.50 – 0.70` in steady-state agent-loop cost. At `b_A ≥ 0.96`, the byte-saving advantage dominates regardless of `K`.**

This is consistent with what we measured: most working compressors land in `b ∈ [0.50, 0.93]`, and `K` is the decision variable.

**Follow-on:** the article's prose should clarify "99% byte-saver" is figurative; the math-honest version is "a `b ≈ 0.80, K = 0` compressor can produce **worse** production cost than a `b ≈ 0.60, K = 1` compressor at `n ≥ 7` turns." The current published article uses "99% vs 60%" as round-number rhetorical anchors, not as measured values — but the technical-paper version should use the tighter numerical regime.

## 4. Pareto front

A compressor `c` dominates `c'` in production-cost space iff `B(c) ≥ B(c')` AND `K(c) ≥ K(c')` AND `Q(c) ≥ Q(c')` with at least one strict. The Pareto-optimal set is the subset of compressors not dominated by any other.

Empirically, in our 5-MCP measurement (P0–P9a):

| Compressor | `B` (mean ratio) | `K` (cache-friendly) | `Q` (judge pass rate) | Pareto? |
|---|---|---|---|---|
| sophon | high (≈0.93) | 1.0 | 0.67 (FAIL bar) | yes (B+K) |
| context-prep-mcp | high | 1.0 | ≈ baseline | yes (B+K+Q) |
| scraper-mcp.extract_markdown | high | 1.0 | ≈ baseline | yes (B+K+Q) |
| retrieval-mcp (post-fix) | moderate | 1.0 | n/a (different shape) | yes (K) |
| vision-mcp | n/a (different shape) | pending live data | n/a | TBD |

(Internal-only specific ratios redacted per `.claude/rules/mcp-stack-moat-guard.md`. Public versions are in `mcp-token-savers/benchmark/` results.)

## 5. Threats to validity (Cook–Campbell taxonomy)

### 5.1 Internal validity (causal claims)
- **Threat:** workspace state changes between `N` runs of the same query for `K` measurement → the measured non-determinism is environment drift, not compressor non-determinism.
- **Mitigation:** golden tests pin the repository at a fixed commit; `node --test` runs are wall-clock-isolated within the same process invocation; the workspace's hidden state (filesystem timestamps, OS scheduler) does not enter the input to `c`.
- **Residual risk:** none of our compressors use wall-clock or random seeds, so the workspace-state threat is theoretical for this class.

### 5.2 External validity (generalization)
- **Threat:** the 15-fixture C2 corpus overrepresents dogfood content (HWAI documentation, our README, our blog posts).
- **Mitigation:** include `long_realistic_v3` fixtures sourced from third-party documentation (Astro, FastAPI, Anthropic SDK). Document corpus provenance in `datasheet.md` (axis 3).
- **Residual risk:** corpus is small (`M = 15`) relative to the production distribution; effect sizes may not generalize to `b ∈ [0.0, 0.5]` regime not represented in our fixtures.

### 5.3 Construct validity (do we measure what we think?)
- **Threat:** "quality preservation" via LLM judge has the same author as the corpus designer → blind-validation gap (`.claude/rules/blind-validation-when-author-contaminated.md`).
- **Mitigation:** Methods v3 axis 2 adds a Wilson CI on judge agreement across N=3 independent judge model calls per (fixture, compressor). Axis 4 (peer-review) is the durable mitigation.
- **Residual risk:** the judge model is the same model the compressor was tuned for. A different judge model may produce different Q estimates.

### 5.4 Statistical validity
- **Threat:** `N = 5` per fixture is small; binomial CIs on `K` per (compressor × fixture) are wide; multiple comparisons across 5 compressors → inflated false-positive rate.
- **Mitigation:** axis 2 applies Wilson CI on `K`, cluster-bootstrap CI on `B` (cluster = fixture), Holm–Bonferroni adjustment for pairwise compressor comparisons, and mixed-effects model for variance decomposition.
- **Residual risk:** corpus-level inferences (pooled over fixtures) are exposed to fixture-selection bias; pre-registration in axis 2 freezes the hypothesis before the N≥60 expansion.

## 6. What this document is and is not

This document is:
- A formal grounding for the `(B, K, Q, C_prod)` measurement framework.
- A correction to the article's rhetorical hook: the math-tight version requires `b_A < 0.96` for the `K = 0` vs `K = 1` crossover to exist at any finite `n`.
- A pointer to the threats-to-validity that motivate the statistical analysis in axis 2.

This document is **not**:
- A proof of optimality for any specific compressor.
- A claim that the measured numbers in `mcp-token-savers/benchmark/` are unbiased estimates of population production cost.
- A peer-reviewed result; that requires axis 4 (Greg D2).

## 7. References

- `notes/mcp-stack-token-economy/` — article research SSOT.
- `scripts/mcp-token-eval/c2_bench/c2_benchmark.py` — measurement primitive.
- `.claude/rules/mcp-stack-moat-guard.md` — public-vs-internal disclosure boundary.
- `.claude/rules/blind-validation-when-author-contaminated.md` — author-bias mitigation.
- Cook, T. D., & Campbell, D. T. (1979). *Quasi-experimentation: Design & Analysis for Field Settings*. Houghton Mifflin.
- Gebru, T. et al. (2018). *Datasheets for Datasets*. arXiv:1803.09010.
