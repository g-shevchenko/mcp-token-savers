"""Tests for cache_metrics primitives."""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import pytest  # noqa: E402

from cache_metrics import (  # noqa: E402
    CacheMeasurement,
    cache_friendly_score,
    measure_output_stability,
)


def test_deterministic_compressor_has_unique_md5():
    m = measure_output_stability(
        input_text="hello world " * 20,
        compressor_fn=lambda x: x[:50],
        n=5,
        sample_id="fixture-a",
    )
    assert isinstance(m, CacheMeasurement)
    assert m.n == 5
    assert m.unique_md5_count == 1
    assert m.cache_stable is True


def test_stochastic_compressor_has_multiple_md5():
    counter = [0]

    def stochastic_fn(x: str) -> str:
        counter[0] += 1
        return x[: 50 + counter[0]]

    m = measure_output_stability(
        input_text="abc " * 30,
        compressor_fn=stochastic_fn,
        n=5,
        sample_id="fixture-b",
    )
    assert m.unique_md5_count == 5
    assert m.cache_stable is False


def test_sample_id_recorded():
    m = measure_output_stability(
        input_text="x" * 100,
        compressor_fn=lambda x: x[:10],
        n=3,
        sample_id="sample-xyz",
    )
    assert m.sample_id == "sample-xyz"


def test_n_below_two_raises():
    with pytest.raises(ValueError):
        measure_output_stability(
            input_text="text",
            compressor_fn=lambda x: x,
            n=1,
            sample_id="bad",
        )


def test_records_first_output_md5_for_audit():
    m = measure_output_stability(
        input_text="repeatable",
        compressor_fn=lambda x: x.upper(),
        n=2,
        sample_id="audit",
    )
    assert len(m.output_md5) == 32


def test_corpus_all_stable_returns_score_1():
    measurements = [
        CacheMeasurement(sample_id=f"f{i}", n=5, unique_md5_count=1,
                         cache_stable=True, output_md5="a" * 32)
        for i in range(10)
    ]
    assert cache_friendly_score(measurements) == 1.0


def test_corpus_all_unstable_returns_score_0():
    measurements = [
        CacheMeasurement(sample_id=f"f{i}", n=5, unique_md5_count=5,
                         cache_stable=False, output_md5="a" * 32)
        for i in range(5)
    ]
    assert cache_friendly_score(measurements) == 0.0


def test_corpus_mixed_returns_pass_rate():
    measurements = (
        [CacheMeasurement(sample_id=f"s{i}", n=5, unique_md5_count=1,
                          cache_stable=True, output_md5="a" * 32) for i in range(7)]
        +
        [CacheMeasurement(sample_id=f"u{i}", n=5, unique_md5_count=3,
                          cache_stable=False, output_md5="b" * 32) for i in range(3)]
    )
    assert cache_friendly_score(measurements) == 0.7


def test_corpus_empty_raises():
    with pytest.raises(ValueError):
        cache_friendly_score([])
