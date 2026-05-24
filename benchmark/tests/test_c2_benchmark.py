"""Tests for c2_benchmark primitives."""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import pytest  # noqa: E402

from c2_benchmark import (  # noqa: E402
    CompressionResult,
    aggregate_compression_runs,
    measure_compression,
    partition_runs_by_sample,
)


# ---------------------------------------------------------------------------
# measure_compression
# ---------------------------------------------------------------------------


def test_measure_compression_returns_compression_result():
    result = measure_compression(
        input_text="Long input text " * 100,
        compressor_fn=lambda x: x[:50],
    )
    assert isinstance(result, CompressionResult)
    assert result.input_size == len("Long input text " * 100)


def test_measure_compression_computes_ratio():
    result = measure_compression(
        input_text="A" * 1000,
        compressor_fn=lambda x: x[:100],
    )
    assert result.input_size == 1000
    assert result.output_size == 100
    assert abs(result.ratio - 0.1) < 1e-9


def test_measure_compression_handles_no_op_compressor():
    result = measure_compression(
        input_text="hello world",
        compressor_fn=lambda x: x,
    )
    assert result.ratio == 1.0


def test_measure_compression_records_sample_id():
    result = measure_compression(
        input_text="abc",
        compressor_fn=lambda x: x,
        sample_id="fixture-001",
    )
    assert result.sample_id == "fixture-001"


def test_measure_compression_records_latency_ms():
    result = measure_compression(
        input_text="x" * 100,
        compressor_fn=lambda x: x[:10],
    )
    assert result.latency_ms is not None
    assert result.latency_ms >= 0.0


# ---------------------------------------------------------------------------
# aggregate_compression_runs
# ---------------------------------------------------------------------------


def test_aggregate_computes_basic_stats():
    runs = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=200, ratio=0.20),
        CompressionResult(input_size=1000, output_size=300, ratio=0.30),
    ]
    agg = aggregate_compression_runs(runs)
    assert agg["n"] == 3
    assert abs(agg["mean_ratio"] - 0.20) < 1e-9
    assert agg["min_ratio"] == 0.10
    assert agg["max_ratio"] == 0.30


def test_aggregate_deterministic_compressor_has_low_cv():
    runs = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
    ]
    agg = aggregate_compression_runs(runs)
    assert agg["n"] == 3
    assert abs(agg["mean_ratio"] - 0.10) < 1e-9
    assert agg["cv"] < 1e-9


def test_aggregate_high_variance_compressor_has_high_cv():
    runs = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=300, ratio=0.30),
        CompressionResult(input_size=1000, output_size=50, ratio=0.05),
    ]
    agg = aggregate_compression_runs(runs)
    assert agg["cv"] > 0.5


def test_aggregate_empty_runs_raises_value_error():
    with pytest.raises(ValueError):
        aggregate_compression_runs([])


def test_aggregate_single_run_returns_zero_stdev():
    runs = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
    ]
    agg = aggregate_compression_runs(runs)
    assert agg["n"] == 1
    assert agg["stdev_ratio"] == 0.0
    assert agg["cv"] == 0.0


def test_aggregate_includes_c2_bar_verdict():
    runs_saves = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
    ]
    assert aggregate_compression_runs(runs_saves)["c2_bar_verdict"] == "PASS"

    runs_no_saving = [
        CompressionResult(input_size=1000, output_size=900, ratio=0.90),
        CompressionResult(input_size=1000, output_size=900, ratio=0.90),
        CompressionResult(input_size=1000, output_size=900, ratio=0.90),
    ]
    assert aggregate_compression_runs(runs_no_saving)["c2_bar_verdict"] == "FAIL_NO_SAVING"

    runs_stochastic = [
        CompressionResult(input_size=1000, output_size=100, ratio=0.10),
        CompressionResult(input_size=1000, output_size=300, ratio=0.30),
        CompressionResult(input_size=1000, output_size=50, ratio=0.05),
    ]
    assert aggregate_compression_runs(runs_stochastic)["c2_bar_verdict"] == "FAIL_STOCHASTIC"


# ---------------------------------------------------------------------------
# partition_runs_by_sample
# ---------------------------------------------------------------------------


def test_partition_groups_by_sample_id_base():
    runs = [
        CompressionResult(input_size=100, output_size=10, ratio=0.10, sample_id="foo#r1"),
        CompressionResult(input_size=100, output_size=11, ratio=0.11, sample_id="foo#r2"),
        CompressionResult(input_size=200, output_size=20, ratio=0.10, sample_id="bar#r1"),
    ]
    groups = partition_runs_by_sample(runs)
    assert set(groups.keys()) == {"foo", "bar"}
    assert len(groups["foo"]) == 2
    assert len(groups["bar"]) == 1


def test_partition_handles_sample_id_without_repeat_suffix():
    runs = [
        CompressionResult(input_size=100, output_size=10, ratio=0.10, sample_id="alpha"),
        CompressionResult(input_size=100, output_size=10, ratio=0.10, sample_id="alpha"),
    ]
    groups = partition_runs_by_sample(runs)
    assert set(groups.keys()) == {"alpha"}
    assert len(groups["alpha"]) == 2


def test_partition_uses_unknown_for_missing_sample_id():
    runs = [
        CompressionResult(input_size=100, output_size=10, ratio=0.10),
        CompressionResult(input_size=100, output_size=10, ratio=0.10, sample_id="foo#r1"),
    ]
    groups = partition_runs_by_sample(runs)
    assert "unknown" in groups
    assert "foo" in groups
