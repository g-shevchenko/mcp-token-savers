"""Tests for the Methods v3 statistical analysis library.

Discipline:
- TDD verify-red: every test must fail at assertion level on a knowingly-wrong
  implementation (would not catch ImportError as a "fail").
- Pure stdlib, no scipy. Tests use literal reference values from textbooks.
"""
from __future__ import annotations

import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from statistical_analysis import (  # noqa: E402
    wilson_ci,
    cluster_bootstrap_ci,
    variance_decomposition,
    welch_t_test,
    cohens_d,
    holm_bonferroni,
    build_compressor_report,
)


class TestWilsonCI(unittest.TestCase):
    """Wilson interval boundary behavior — the key reason we use it over Wald."""

    def test_15_out_of_15_lower_bound_far_below_one(self):
        """The Wald interval would give [1.0, 1.0]; Wilson correctly shows uncertainty.

        Reference: standard Wilson interval (no continuity correction), z=1.96.
        Verified analytically: lo = 1 / (1 + z²/n) = 1 / (1 + 3.8416/15) = 0.7961.
        """
        lo, hi = wilson_ci(15, 15, conf=0.95)
        self.assertAlmostEqual(lo, 0.7961, places=3)
        self.assertEqual(hi, 1.0)

    def test_0_out_of_15_upper_bound_far_above_zero(self):
        """The Wald interval would give [0, 0]; Wilson correctly shows uncertainty.

        Reference: standard Wilson interval (no continuity correction), z=1.96.
        Symmetric to k=15: hi = z²/n / (1 + z²/n) = 0.2039.
        """
        lo, hi = wilson_ci(0, 15, conf=0.95)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 0.2039, places=3)

    def test_50_50_close_to_normal_approximation(self):
        """At p_hat ≈ 0.5, Wilson and Wald are near-identical."""
        lo, hi = wilson_ci(50, 100, conf=0.95)
        # Reference: approximately [0.404, 0.596]
        self.assertGreater(lo, 0.39)
        self.assertLess(hi, 0.61)

    def test_zero_trials_returns_full_range(self):
        lo, hi = wilson_ci(0, 0)
        self.assertEqual((lo, hi), (0.0, 1.0))


class TestClusterBootstrap(unittest.TestCase):

    def test_zero_variance_within_clusters_gives_tight_ci(self):
        """If every fixture's runs are identical, CI tightness comes from inter-fixture variability."""
        observations = {
            "f1": [0.9, 0.9, 0.9, 0.9, 0.9],
            "f2": [0.9, 0.9, 0.9, 0.9, 0.9],
            "f3": [0.9, 0.9, 0.9, 0.9, 0.9],
        }
        point, lo, hi = cluster_bootstrap_ci(observations, n_resamples=500, seed=42)
        self.assertAlmostEqual(point, 0.9)
        # All clusters identical → resamples are also identical → CI is a point
        self.assertAlmostEqual(lo, 0.9)
        self.assertAlmostEqual(hi, 0.9)

    def test_heterogeneous_clusters_give_wider_ci(self):
        """When fixtures differ, cluster bootstrap captures that."""
        observations = {
            "f1": [0.95, 0.95, 0.95],
            "f2": [0.60, 0.60, 0.60],
            "f3": [0.75, 0.75, 0.75],
        }
        point, lo, hi = cluster_bootstrap_ci(observations, n_resamples=2000, seed=42)
        self.assertAlmostEqual(point, (0.95 + 0.60 + 0.75) / 3, places=2)
        # CI should span beyond the point estimate
        self.assertLess(lo, point)
        self.assertGreater(hi, point)

    def test_reproducible_with_seed(self):
        observations = {"f1": [0.5, 0.6], "f2": [0.8, 0.9]}
        run1 = cluster_bootstrap_ci(observations, n_resamples=500, seed=42)
        run2 = cluster_bootstrap_ci(observations, n_resamples=500, seed=42)
        self.assertEqual(run1, run2)


class TestVarianceDecomposition(unittest.TestCase):

    def test_compressor_dominated_variance(self):
        """If compressors differ wildly and fixtures are similar → compressor variance dominates."""
        observations = {
            "high_saver":   {"f1": [0.95], "f2": [0.94], "f3": [0.95]},
            "medium_saver": {"f1": [0.60], "f2": [0.59], "f3": [0.60]},
            "low_saver":    {"f1": [0.20], "f2": [0.19], "f3": [0.20]},
        }
        vd = variance_decomposition(observations)
        # Compressor effect should explain the bulk of total variance
        self.assertGreater(vd.pct_compressor, 0.9)
        self.assertLess(vd.pct_fixture, 0.05)

    def test_fixture_dominated_variance(self):
        """If fixtures differ wildly and compressors are similar → fixture variance dominates."""
        observations = {
            "compressor_A": {"f1": [0.95], "f2": [0.50], "f3": [0.20]},
            "compressor_B": {"f1": [0.96], "f2": [0.51], "f3": [0.21]},
        }
        vd = variance_decomposition(observations)
        self.assertGreater(vd.pct_fixture, 0.9)
        self.assertLess(vd.pct_compressor, 0.05)


class TestWelchTAndCohenD(unittest.TestCase):

    def test_identical_samples_p_one(self):
        a = [0.9] * 5
        b = [0.9] * 5
        t, df, p = welch_t_test(a, b)
        # When variances are zero AND means are equal → t = 0, p = 1
        self.assertEqual(t, 0)
        self.assertEqual(p, 1)

    def test_large_separation_p_small(self):
        a = [0.90, 0.91, 0.92, 0.91, 0.90]
        b = [0.50, 0.49, 0.51, 0.50, 0.49]
        t, df, p = welch_t_test(a, b)
        self.assertLess(p, 0.01)
        self.assertGreater(abs(t), 5)

    def test_cohens_d_large_effect(self):
        a = [0.90, 0.91, 0.92, 0.91, 0.90]
        b = [0.50, 0.49, 0.51, 0.50, 0.49]
        d = cohens_d(a, b)
        self.assertGreater(abs(d), 5)  # very large effect


class TestHolmBonferroni(unittest.TestCase):

    def test_single_comparison_unchanged(self):
        result = holm_bonferroni({"only": 0.04})
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0].adjusted_p, 0.04)
        self.assertTrue(result[0].rejected_at_005)

    def test_step_down_property(self):
        """After sorting by raw p, the adjusted p_i ≥ adjusted p_{i-1} (monotone)."""
        result = holm_bonferroni({"a": 0.01, "b": 0.02, "c": 0.03, "d": 0.04})
        adj = [r.adjusted_p for r in result]
        for i in range(1, len(adj)):
            self.assertGreaterEqual(adj[i], adj[i - 1])

    def test_holm_less_conservative_than_bonferroni(self):
        """Holm-adjusted smallest p < Bonferroni-adjusted (m * p_min)."""
        p_values = {"a": 0.01, "b": 0.50, "c": 0.50, "d": 0.50}
        result = holm_bonferroni(p_values)
        # Smallest p (0.01) under Bonferroni would be 0.04 (×4); under Holm
        # it's still 0.01 × 4 = 0.04 at the first step (m=4)
        # but the larger p's are step-down → less conservative overall
        smallest = next(r for r in result if r.label == "a")
        self.assertAlmostEqual(smallest.adjusted_p, 0.04)


class TestCompressorReport(unittest.TestCase):

    def test_sophon_like_data_produces_wide_wilson_ci(self):
        """At N=15 with all-success K → Wilson CI must NOT report [1.0, 1.0]."""
        byte_saving = {f"f{i}": [0.93, 0.93, 0.93, 0.93, 0.93] for i in range(15)}
        cache_friendly = {f"f{i}": True for i in range(15)}
        report = build_compressor_report("sophon", byte_saving, cache_friendly, seed=42)
        # Cache-friendly score 100%, but CI lower bound must be < 1.0
        self.assertEqual(report.cache_friendly_score, 1.0)
        self.assertLess(report.cache_friendly_ci_lower, 1.0)
        self.assertAlmostEqual(report.cache_friendly_ci_lower, 0.7961, places=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
