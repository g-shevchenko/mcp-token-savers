"""Tests for the artifact-detection guards used in A/B measurement.

Run:
    cd act-receipts/python
    python3 -m unittest tests.test_artifact_guard -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from artifact_guard import (  # noqa: E402
    detect_constant_hash_artifact,
    detect_selector_miss_artifact,
)


class SelectorMissArtifactTests(unittest.TestCase):
    def test_all_runs_below_threshold_flagged(self):
        runs = [
            {"post_region_size_bytes": 12},
            {"post_region_size_bytes": 14},
            {"post_region_size_bytes": 18},
        ]
        is_artifact, reason = detect_selector_miss_artifact(runs)
        self.assertTrue(is_artifact)
        self.assertIn("empty content", reason)
        self.assertIn("threshold=200", reason)

    def test_real_size_not_flagged(self):
        runs = [
            {"post_region_size_bytes": 8421},
            {"post_region_size_bytes": 8019},
            {"post_region_size_bytes": 8132},
        ]
        is_artifact, reason = detect_selector_miss_artifact(runs)
        self.assertFalse(is_artifact)
        self.assertIsNone(reason)

    def test_mixed_runs_not_flagged(self):
        # If even ONE run is above threshold, not an artifact — could be a
        # legitimate intermittent rendering issue, not a selector miss.
        runs = [
            {"post_region_size_bytes": 12},
            {"post_region_size_bytes": 14},
            {"post_region_size_bytes": 8421},
        ]
        is_artifact, reason = detect_selector_miss_artifact(runs)
        self.assertFalse(is_artifact)
        self.assertIsNone(reason)

    def test_empty_input(self):
        is_artifact, reason = detect_selector_miss_artifact([])
        self.assertFalse(is_artifact)
        self.assertIsNone(reason)

    def test_custom_threshold(self):
        runs = [{"post_region_size_bytes": 300}, {"post_region_size_bytes": 400}]
        # default 200 threshold -> not artifact
        self.assertFalse(detect_selector_miss_artifact(runs)[0])
        # raised threshold 500 -> artifact
        self.assertTrue(detect_selector_miss_artifact(runs, min_legit_bytes=500)[0])

    def test_custom_field_name(self):
        runs = [{"size": 12}, {"size": 14}]
        is_artifact, _ = detect_selector_miss_artifact(runs, field_name="size")
        self.assertTrue(is_artifact)


class ConstantHashArtifactTests(unittest.TestCase):
    def test_all_hashes_identical_flagged(self):
        runs = [
            {"post_region_hash": "sha256:" + "a"*64} for _ in range(5)
        ]
        is_artifact, reason = detect_constant_hash_artifact(runs)
        self.assertTrue(is_artifact)
        self.assertIn("identical", reason)

    def test_hashes_differ_not_flagged(self):
        runs = [
            {"post_region_hash": "sha256:" + "a"*64},
            {"post_region_hash": "sha256:" + "b"*64},
            {"post_region_hash": "sha256:" + "a"*64},
        ]
        is_artifact, _ = detect_constant_hash_artifact(runs)
        self.assertFalse(is_artifact)

    def test_too_few_runs(self):
        runs = [
            {"post_region_hash": "sha256:" + "a"*64},
            {"post_region_hash": "sha256:" + "a"*64},
        ]
        # require_runs=3 default -> not enough to conclude
        is_artifact, _ = detect_constant_hash_artifact(runs)
        self.assertFalse(is_artifact)


if __name__ == "__main__":
    unittest.main()
