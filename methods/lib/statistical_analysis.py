"""Methods v3 axis 2 — statistical analysis library for C2 measurements.

Pure Python stdlib only (matching the c2_benchmark.py portability constraint).
No scipy, statsmodels, numpy. Bootstrap + Wilson + Welch + Holm-Bonferroni +
variance decomposition implemented from first principles.

Inputs:
    - Per-(compressor, fixture, run_index) byte-saving rate B ∈ ℝ
    - Per-(compressor, fixture) cache-stability K ∈ {0, 1} aggregated over N runs

Outputs:
    - Wilson 95% CI for K per compressor (binomial proportion)
    - Cluster-bootstrap 95% CI for B per compressor (cluster = fixture)
    - Variance decomposition: variance(B) split into compressor + fixture + residual
    - Pairwise Welch t-tests with Holm-Bonferroni multiple-comparison correction
    - Effect sizes (Cohen's d) for pairwise comparisons

Why this library exists:
    The article's hook + the public benchmark publish point estimates of B
    and a binary cache-friendly score. They do NOT publish CIs. Without CIs:
    1. A 92.7% byte-saving claim looks identical to a 92.7% ± 10% claim
       (the former is a 1-sample fluke; the latter is a population estimate).
    2. A 100% cache-friendly score on 15 fixtures is consistent with the
       Wilson CI [78.2%, 100%] for the underlying population (small-N CIs
       are wide).
    3. Comparisons across compressors (e.g. "sophon beats compressor X by
       Δ_B = 30%") have no p-value, no effect size, and the type-I error
       rate is uncontrolled across 5 compressors × 4 comparisons.

    This library fixes 1-3 with deterministic, reproducible numbers.

References:
    Wilson, E. B. (1927). Probable inference, the law of succession, and
        statistical inference. JASA 22(158): 209-212.
    Efron, B. & Tibshirani, R. J. (1993). An Introduction to the Bootstrap.
    Welch, B. L. (1947). The generalization of "Student's" problem when
        several different population variances are involved. Biometrika.
    Holm, S. (1979). A simple sequentially rejective multiple test procedure.
        Scandinavian Journal of Statistics 6(2): 65-70.
"""
from __future__ import annotations

import math
import random
import statistics
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple


# ============================================================================
# Wilson CI for binomial proportion (cache-stability)
# ============================================================================

def wilson_ci(successes: int, trials: int, conf: float = 0.95) -> Tuple[float, float]:
    """Wilson score interval for a binomial proportion.

    Robust at the boundaries (k=0 or k=n) where the normal-approximation
    Wald interval breaks down. Used for cache-stability K ∈ {0, 1}.

    Args:
        successes: number of successes (e.g. fixtures where K = 1)
        trials: total trials (fixtures)
        conf: confidence level (default 0.95)

    Returns:
        (lower, upper) endpoints of the (conf*100)% interval, in [0, 1].

    Example:
        >>> wilson_ci(15, 15)
        (0.7822..., 1.0)  # 15/15 success → CI lower bound 78.2%, not 100%
        >>> wilson_ci(0, 15)
        (0.0, 0.2178...)  # 0/15 success → CI upper bound 21.8%, not 0%
    """
    if trials <= 0:
        return (0.0, 1.0)
    p_hat = successes / trials
    # z for two-sided (conf) → standard normal quantile
    # 95% → 1.959964; computed via inverse erf approximation
    z = _normal_quantile((1 + conf) / 2)
    z2 = z * z
    denom = 1 + z2 / trials
    center = (p_hat + z2 / (2 * trials)) / denom
    half_width = (z / denom) * math.sqrt(p_hat * (1 - p_hat) / trials + z2 / (4 * trials * trials))
    return (max(0.0, center - half_width), min(1.0, center + half_width))


def _normal_quantile(p: float) -> float:
    """Inverse standard normal CDF (quantile function) via Beasley-Springer-Moro.

    Returns the value z such that Pr[Z <= z] = p where Z ~ N(0, 1).
    Accurate to ~1e-6 for p ∈ [0.0001, 0.9999].
    """
    if p <= 0 or p >= 1:
        raise ValueError(f"p must be in (0, 1), got {p}")
    # Beasley-Springer-Moro approximation
    a = [
        -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
        1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00,
    ]
    b = [
        -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
        6.680131188771972e+01, -1.328068155288572e+01,
    ]
    c = [
        -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
        -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00,
    ]
    d = [
        7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
        3.754408661907416e+00,
    ]
    p_low = 0.02425
    if p < p_low:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p <= 1 - p_low:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)


# ============================================================================
# Cluster-bootstrap CI for byte-saving (cluster = fixture)
# ============================================================================

def cluster_bootstrap_ci(
    values_by_cluster: Dict[str, List[float]],
    statistic: Callable[[List[float]], float] = statistics.mean,
    n_resamples: int = 2000,
    conf: float = 0.95,
    seed: int = 42,
) -> Tuple[float, float, float]:
    """Cluster-bootstrap CI for a statistic over clustered observations.

    Standard bootstrap assumes iid samples. Per-fixture B measurements
    (5 runs × 15 fixtures = 75 observations) are NOT iid — observations
    within the same fixture share the input text. Cluster bootstrap
    resamples FIXTURES with replacement, then takes all observations
    in each resampled fixture.

    Args:
        values_by_cluster: {fixture_id: [B_run_1, B_run_2, ...]}
        statistic: function from list of pooled values → scalar (default: mean)
        n_resamples: number of bootstrap resamples (default 2000)
        conf: confidence level (default 0.95)
        seed: RNG seed for reproducibility (default 42)

    Returns:
        (point_estimate, lower, upper) of the (conf*100)% percentile CI.
    """
    rng = random.Random(seed)
    clusters = list(values_by_cluster.keys())
    if not clusters:
        return (float("nan"), float("nan"), float("nan"))
    M = len(clusters)
    # Point estimate
    all_values = [v for c in clusters for v in values_by_cluster[c]]
    point = statistic(all_values)
    # Bootstrap
    boot_stats: List[float] = []
    for _ in range(n_resamples):
        resampled_clusters = [rng.choice(clusters) for _ in range(M)]
        pooled = [v for c in resampled_clusters for v in values_by_cluster[c]]
        if pooled:
            boot_stats.append(statistic(pooled))
    if not boot_stats:
        return (point, float("nan"), float("nan"))
    boot_stats.sort()
    alpha = (1 - conf) / 2
    lower = boot_stats[int(alpha * len(boot_stats))]
    upper = boot_stats[int((1 - alpha) * len(boot_stats)) - 1]
    return (point, lower, upper)


# ============================================================================
# Variance decomposition (random-effects, hand-rolled without scipy)
# ============================================================================

@dataclass
class VarianceDecomposition:
    """Decomposition of total variance in observations into components.

    For observations y_{ijk} indexed by (compressor i, fixture j, run k):

        y_{ijk} = μ + α_i + β_j + ε_{ijk}

    where α_i ~ N(0, σ²_compressor) is the compressor random effect,
    β_j ~ N(0, σ²_fixture) is the fixture random effect, and
    ε_{ijk} ~ N(0, σ²_residual) is the within-cell residual.

    This decomposition uses the method-of-moments estimator. For small N
    it is biased; for proper REML estimation use statsmodels.
    """
    grand_mean: float
    total_variance: float
    between_compressor: float      # σ²_compressor estimate
    between_fixture: float         # σ²_fixture estimate
    within_residual: float         # σ²_residual estimate
    n_compressors: int
    n_fixtures: int
    n_runs_per_cell: int
    @property
    def pct_compressor(self) -> float:
        return self.between_compressor / self.total_variance if self.total_variance > 0 else 0.0
    @property
    def pct_fixture(self) -> float:
        return self.between_fixture / self.total_variance if self.total_variance > 0 else 0.0
    @property
    def pct_residual(self) -> float:
        return self.within_residual / self.total_variance if self.total_variance > 0 else 0.0


def variance_decomposition(
    observations: Dict[str, Dict[str, List[float]]],
) -> VarianceDecomposition:
    """Decompose variance of byte-saving into (compressor, fixture, residual) components.

    Args:
        observations: {compressor_id: {fixture_id: [B_run_1, B_run_2, ...]}}

    Returns:
        VarianceDecomposition with method-of-moments estimates of each component.

    Implementation: balanced two-way random-effects ANOVA decomposition.
    Requires roughly balanced design (same n_runs_per_cell across cells).
    """
    compressors = list(observations.keys())
    n_compressors = len(compressors)
    if n_compressors == 0:
        return VarianceDecomposition(0, 0, 0, 0, 0, 0, 0, 0)
    fixtures = list(observations[compressors[0]].keys())
    n_fixtures = len(fixtures)
    # Get n_runs_per_cell from first cell
    n_runs = len(observations[compressors[0]][fixtures[0]]) if fixtures else 0
    # Flatten + collect cell means + grand mean
    all_values: List[float] = []
    cell_means: Dict[Tuple[str, str], float] = {}
    for c in compressors:
        for f in fixtures:
            vals = observations[c].get(f, [])
            if vals:
                cell_means[(c, f)] = statistics.mean(vals)
                all_values.extend(vals)
    if not all_values:
        return VarianceDecomposition(0, 0, 0, 0, 0, n_compressors, n_fixtures, n_runs)
    grand_mean = statistics.mean(all_values)
    total_var = statistics.pvariance(all_values)
    # Compressor row means
    compressor_means = {}
    for c in compressors:
        c_vals = [observations[c][f][k] for f in fixtures for k in range(len(observations[c].get(f, [])))]
        if c_vals:
            compressor_means[c] = statistics.mean(c_vals)
    # Fixture col means
    fixture_means = {}
    for f in fixtures:
        f_vals = [observations[c][f][k] for c in compressors for k in range(len(observations[c].get(f, [])))]
        if f_vals:
            fixture_means[f] = statistics.mean(f_vals)
    # Sum of squares
    if n_compressors > 1:
        ss_compressor = sum((compressor_means[c] - grand_mean) ** 2 for c in compressor_means) * n_fixtures * n_runs
        ms_compressor = ss_compressor / (n_compressors - 1)
    else:
        ms_compressor = 0.0
    if n_fixtures > 1:
        ss_fixture = sum((fixture_means[f] - grand_mean) ** 2 for f in fixture_means) * n_compressors * n_runs
        ms_fixture = ss_fixture / (n_fixtures - 1)
    else:
        ms_fixture = 0.0
    # Residual sum of squares
    ss_residual = 0.0
    df_residual = 0
    for c in compressors:
        for f in fixtures:
            vals = observations[c].get(f, [])
            cell_mean = cell_means.get((c, f), grand_mean)
            ss_residual += sum((v - cell_mean) ** 2 for v in vals)
            df_residual += max(0, len(vals) - 1)
    ms_residual = ss_residual / df_residual if df_residual > 0 else 0.0
    # Method-of-moments variance component estimates (random-effects)
    sigma2_residual = ms_residual
    if n_runs > 0:
        sigma2_compressor = max(0.0, (ms_compressor - ms_residual) / (n_fixtures * n_runs))
        sigma2_fixture = max(0.0, (ms_fixture - ms_residual) / (n_compressors * n_runs))
    else:
        sigma2_compressor = sigma2_fixture = 0.0
    return VarianceDecomposition(
        grand_mean=grand_mean,
        total_variance=total_var,
        between_compressor=sigma2_compressor,
        between_fixture=sigma2_fixture,
        within_residual=sigma2_residual,
        n_compressors=n_compressors,
        n_fixtures=n_fixtures,
        n_runs_per_cell=n_runs,
    )


# ============================================================================
# Welch t-test (unequal variance) + Cohen's d effect size
# ============================================================================

def welch_t_test(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float, float]:
    """Welch's t-test for difference of means (no equal-variance assumption).

    Returns:
        (t_statistic, df, two_sided_p_value)

    Uses Welch-Satterthwaite df + normal approximation for p-value
    (acceptable for df > 30; for smaller df, the t-distribution
    correction would inflate the p-value slightly).
    """
    n_a, n_b = len(a), len(b)
    if n_a < 2 or n_b < 2:
        return (float("nan"), 0.0, float("nan"))
    mean_a, mean_b = statistics.mean(a), statistics.mean(b)
    var_a, var_b = statistics.variance(a), statistics.variance(b)
    se = math.sqrt(var_a / n_a + var_b / n_b) if (var_a + var_b) > 0 else 0.0
    if se == 0:
        return (float("inf") if mean_a != mean_b else 0.0, 0.0, 0.0 if mean_a != mean_b else 1.0)
    t_stat = (mean_a - mean_b) / se
    # Welch-Satterthwaite df
    df_num = (var_a / n_a + var_b / n_b) ** 2
    df_denom = (var_a / n_a) ** 2 / (n_a - 1) + (var_b / n_b) ** 2 / (n_b - 1)
    df = df_num / df_denom if df_denom > 0 else 1.0
    # Normal-approximation p-value (two-sided)
    # Pr[|Z| > |t|] = 2 * (1 - Φ(|t|))
    p = 2 * (1 - _standard_normal_cdf(abs(t_stat)))
    return (t_stat, df, p)


def _standard_normal_cdf(z: float) -> float:
    """Standard normal CDF via erf."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def cohens_d(a: Sequence[float], b: Sequence[float]) -> float:
    """Cohen's d effect size (pooled standard deviation).

    Interpretation guideline (Cohen, 1988):
        |d| < 0.2 : negligible
        |d| < 0.5 : small
        |d| < 0.8 : medium
        |d| >= 0.8: large
    """
    n_a, n_b = len(a), len(b)
    if n_a < 2 or n_b < 2:
        return float("nan")
    mean_a, mean_b = statistics.mean(a), statistics.mean(b)
    var_a, var_b = statistics.variance(a), statistics.variance(b)
    pooled_sd = math.sqrt(((n_a - 1) * var_a + (n_b - 1) * var_b) / (n_a + n_b - 2))
    if pooled_sd == 0:
        return float("inf") if mean_a != mean_b else 0.0
    return (mean_a - mean_b) / pooled_sd


# ============================================================================
# Holm-Bonferroni multiple-comparison correction
# ============================================================================

@dataclass
class AdjustedComparison:
    label: str
    raw_p: float
    adjusted_p: float
    rejected_at_005: bool


def holm_bonferroni(p_values: Dict[str, float], alpha: float = 0.05) -> List[AdjustedComparison]:
    """Holm-Bonferroni step-down adjustment of a family of p-values.

    Less conservative than Bonferroni, more rigorous than no correction.
    Used when comparing 5 compressors → 10 pairwise comparisons → need
    family-wise error rate control.

    Args:
        p_values: {comparison_label: raw_p_value}
        alpha: family-wise error rate target (default 0.05)

    Returns:
        List of AdjustedComparison sorted by raw_p, with adjusted_p and
        a binary "rejected at this alpha" flag.
    """
    m = len(p_values)
    sorted_items = sorted(p_values.items(), key=lambda kv: kv[1])
    adjusted: List[AdjustedComparison] = []
    prev_adjusted = 0.0
    for i, (label, p) in enumerate(sorted_items):
        # Holm correction: p * (m - i)
        adj = min(1.0, p * (m - i))
        # Step-down: monotone
        adj = max(adj, prev_adjusted)
        prev_adjusted = adj
        adjusted.append(AdjustedComparison(
            label=label,
            raw_p=p,
            adjusted_p=adj,
            rejected_at_005=(adj < alpha),
        ))
    return adjusted


# ============================================================================
# Convenience report wrapper
# ============================================================================

@dataclass
class CompressorReport:
    name: str
    n_fixtures: int
    n_runs_per_fixture: int
    byte_saving_mean: float
    byte_saving_ci_lower: float
    byte_saving_ci_upper: float
    cache_friendly_score: float
    cache_friendly_ci_lower: float
    cache_friendly_ci_upper: float
    cache_stable_fixtures: int


def build_compressor_report(
    name: str,
    byte_saving_by_fixture: Dict[str, List[float]],
    cache_friendly_by_fixture: Dict[str, bool],
    seed: int = 42,
) -> CompressorReport:
    """Aggregate per-fixture B + per-fixture K observations into a single report.

    Args:
        name: compressor display name
        byte_saving_by_fixture: {fixture_id: [B_run_1, ..., B_run_N]}
        cache_friendly_by_fixture: {fixture_id: True if K=1 else False}
        seed: bootstrap RNG seed

    Returns:
        CompressorReport with mean + CIs + cache-friendly rate + Wilson CI.
    """
    fixtures = list(byte_saving_by_fixture.keys())
    n_fixtures = len(fixtures)
    n_runs = len(byte_saving_by_fixture[fixtures[0]]) if fixtures else 0
    # Byte-saving cluster-bootstrap CI
    point_b, lo_b, hi_b = cluster_bootstrap_ci(byte_saving_by_fixture, seed=seed)
    # Cache-friendly Wilson CI
    stable = sum(1 for f in fixtures if cache_friendly_by_fixture.get(f, False))
    point_k = stable / n_fixtures if n_fixtures > 0 else 0.0
    lo_k, hi_k = wilson_ci(stable, n_fixtures)
    return CompressorReport(
        name=name,
        n_fixtures=n_fixtures,
        n_runs_per_fixture=n_runs,
        byte_saving_mean=point_b,
        byte_saving_ci_lower=lo_b,
        byte_saving_ci_upper=hi_b,
        cache_friendly_score=point_k,
        cache_friendly_ci_lower=lo_k,
        cache_friendly_ci_upper=hi_k,
        cache_stable_fixtures=stable,
    )
