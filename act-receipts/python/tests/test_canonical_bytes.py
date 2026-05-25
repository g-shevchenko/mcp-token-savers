"""Cross-runtime equivalence + correctness tests for act_receipts.py.

Same fixtures load in `../../js/tests/fixtures_cross_runtime.json`; the
Node test there asserts the same SHA-256 values. If JS and Python ever
disagree on a single byte, the design breaks.

Run:
    cd act-receipts/python
    python3 -m unittest tests.test_canonical_bytes -v

Standard library only. License: MIT.
"""
from __future__ import annotations

import json
import os
import sys
import unittest

# Allow `python3 -m unittest tests.test_canonical_bytes` from this dir
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from act_receipts import (  # noqa: E402
    SCHEMA_VERSION,
    assemble_receipt,
    cache_friendly_score,
    canonical_receipt_bytes,
    canonical_sha256,
    dom_region_hash,
    validate_receipt,
)

FIXTURES_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures_cross_runtime.json"
)


def load_fixtures():
    with open(FIXTURES_PATH, encoding="utf-8") as f:
        return json.load(f)


class CrossRuntimeEquivalenceTests(unittest.TestCase):
    """Each fixture must produce its expected canonical bytes + SHA-256."""

    def test_all_fixtures_match_golden(self):
        for fx in load_fixtures():
            with self.subTest(name=fx["name"]):
                sha = canonical_sha256(fx["receipt"])
                self.assertEqual(
                    sha,
                    fx["expected_canonical_sha256"],
                    f"SHA-256 mismatch for fixture {fx['name']!r}",
                )
                canon = canonical_receipt_bytes(fx["receipt"]).decode("utf-8")
                self.assertEqual(
                    canon,
                    fx["expected_canonical_bytes_utf8"],
                    f"canonical bytes mismatch for fixture {fx['name']!r}",
                )


class ObservabilityStrippingTests(unittest.TestCase):
    """Receipts that differ ONLY in observability + size_bytes must hash same."""

    def test_observability_strip(self):
        fixtures = {fx["name"]: fx for fx in load_fixtures()}
        a = fixtures["minimal_click"]["expected_canonical_sha256"]
        b = fixtures["click_with_observability_stripped"]["expected_canonical_sha256"]
        self.assertEqual(
            a, b,
            "Receipts differing only in observability + dom_region_size_bytes "
            "must produce the same canonical SHA-256",
        )


class SchemaConstantsTests(unittest.TestCase):
    def test_schema_version(self):
        self.assertEqual(SCHEMA_VERSION, "scraper-mcp.act_receipt.v1")


class ValidationTests(unittest.TestCase):
    def test_minimal_valid_receipt(self):
        fx = load_fixtures()[0]["receipt"]
        ok, errors = validate_receipt(fx)
        self.assertTrue(ok, f"valid receipt should pass: {errors}")
        self.assertEqual(errors, [])

    def test_missing_schema_version(self):
        bad = {
            "action": {"type": "click"},
            "pre_state": {"url": "x", "dom_region_hash": "sha256:" + "0"*64},
            "post_state": {
                "url": "x",
                "dom_region_hash": "sha256:" + "0"*64,
                "changed": False,
                "stable": True,
                "navigated": False,
            },
            "errors": {
                "console": [], "network": [],
                "selector_not_found": False, "timeout": False, "action_failed": None,
            },
        }
        ok, errors = validate_receipt(bad)
        self.assertFalse(ok)
        self.assertTrue(any("schema_version" in e for e in errors))

    def test_invalid_action_type(self):
        fx = load_fixtures()[0]["receipt"]
        fx2 = dict(fx)
        fx2["action"] = dict(fx["action"], type="nonsense-action")
        ok, errors = validate_receipt(fx2)
        self.assertFalse(ok)
        self.assertTrue(any("not in allowed set" in e for e in errors))


class CacheFriendlyScoreTests(unittest.TestCase):
    def test_all_identical(self):
        fx = load_fixtures()[0]["receipt"]
        self.assertEqual(cache_friendly_score([fx, fx, fx, fx, fx]), 1.0)

    def test_one_different(self):
        a = load_fixtures()[0]["receipt"]
        c = load_fixtures()[2]["receipt"]
        # 4 of a, 1 of c -> modal fraction = 4/5
        self.assertAlmostEqual(cache_friendly_score([a, a, a, a, c]), 0.8)

    def test_empty(self):
        self.assertIsNone(cache_friendly_score([]))

    def test_single(self):
        fx = load_fixtures()[0]["receipt"]
        self.assertEqual(cache_friendly_score([fx]), 1.0)


class DomRegionHashTests(unittest.TestCase):
    def test_stripping_noise_preserves_hash(self):
        clean = '<div class="card"><h1>Title</h1></div>'
        noisy = (
            '<div class="card" data-time="2026-05-25T20:00:00Z" '
            'data-frame="42"><h1>Title</h1></div>'
        )
        self.assertEqual(dom_region_hash(clean), dom_region_hash(noisy))

    def test_different_content_different_hash(self):
        a = dom_region_hash("<div>a</div>")
        b = dom_region_hash("<div>b</div>")
        self.assertNotEqual(a, b)


class AssembleReceiptTests(unittest.TestCase):
    def test_assemble_passes_validation(self):
        r = assemble_receipt(
            action={"type": "click", "selector": "a"},
            pre_url="https://example.com/",
            pre_dom_region_html="<header>nav</header>",
            post_url="https://example.com/about",
            post_dom_region_html="<header>nav</header>",  # same -> not changed
            navigated=True,
        )
        ok, errors = validate_receipt(r)
        self.assertTrue(ok, f"assembled receipt should validate: {errors}")
        self.assertFalse(r["post_state"]["changed"])  # same DOM region

    def test_assemble_changed_detection(self):
        r = assemble_receipt(
            action={"type": "click", "selector": "a"},
            pre_url="https://example.com/",
            pre_dom_region_html="<header>a</header>",
            post_url="https://example.com/",
            post_dom_region_html="<header>b</header>",
        )
        self.assertTrue(r["post_state"]["changed"])


if __name__ == "__main__":
    unittest.main()
