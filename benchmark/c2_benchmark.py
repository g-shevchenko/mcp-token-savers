"""Deterministic compressor benchmark — measurement primitive.

A compressor is any pure function `str -> str` that takes input text and
returns a (typically smaller) representation suitable for downstream
consumption by an agent or LLM. This module provides three primitives:

- `measure_compression(input, fn)` — single-shot ratio + latency
- `aggregate_compression_runs(runs)` — N-run stats + CV + bar verdict
- `partition_runs_by_sample(runs)` — group repeats of the same fixture

Together they let you measure ANY compressor (your own MCP, a vendor MCP
like `mcp-sophon`, a custom regex-based preprocessor, etc.) under the
same two-axis lens: byte saving AND cache-friendliness (the latter via
the sibling `cache_metrics.py` module).

The bar verdict is a methodology heuristic. A compressor passes iff:
  1. CV (stdev/mean of ratio) <= CV_THRESHOLD   ("deterministic enough")
  2. mean_ratio                <= RATIO_THRESHOLD ("actually saves > 30%")

Defaults: CV_THRESHOLD = 0.05, RATIO_THRESHOLD = 0.70. Tune per case
via `aggregate_compression_runs(runs, cv_threshold=..., ratio_threshold=...)`.

Char-based size (not token-based) is intentional:
- portable (no tokenizer dependency)
- ratio is invariant to encoding when input + output share a tokenizer
- downstream cost models can plug in token-based sizing via a thin wrapper

Compose with `cache_metrics.measure_output_stability` for the second
axis. Pure functions, stdlib only, no network.
"""
from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

# ---------------------------------------------------------------------------
# Bar thresholds (methodology decision rule)
# ---------------------------------------------------------------------------
# A compressor passes the savings bar if BOTH hold:
#   1. CV (stdev/mean of ratio) <= CV_THRESHOLD  — "deterministic enough"
#   2. mean_ratio                 <= RATIO_THRESHOLD — "actually saves >= (1 - threshold)"
#
# Defaults chosen for a strict pass:
#   CV_THRESHOLD     = 0.05  (5% variation tolerated — covers parser timing jitter)
#   RATIO_THRESHOLD  = 0.70  (30% saving minimum; below this, output ~ input → no saving)
#
# These are tunable per-candidate via `aggregate_compression_runs(runs, cv_threshold=…, ratio_threshold=…)`.

DEFAULT_CV_THRESHOLD: float = 0.05
DEFAULT_RATIO_THRESHOLD: float = 0.70


@dataclass
class CompressionResult:
    """A single compression measurement.

    Fields:
        input_size:  characters in the input.
        output_size: characters in the output of the compressor.
        ratio:       output_size / input_size; range [0.0, ∞) but usually (0, 1].
        sample_id:   optional fixture/sample identifier for audit + per-class aggregation.
        latency_ms:  wall-clock duration of the compressor call. Float, milliseconds.
    """

    input_size: int
    output_size: int
    ratio: float
    sample_id: Optional[str] = None
    latency_ms: Optional[float] = None


def measure_compression(
    input_text: str,
    compressor_fn: Callable[[str], str],
    sample_id: Optional[str] = None,
) -> CompressionResult:
    """Measure one compression: ratio = |output| / |input|, plus wall-clock latency.

    `compressor_fn` is called exactly once with `input_text`. Its return value is
    treated as the compressed output and its length (in characters) becomes
    `output_size`.

    For deterministic compressors (parser-only, regex, deterministic prep) you can
    call this directly. For potentially-stochastic compressors (LLM-backed prep,
    external network calls), pair this with `aggregate_compression_runs(runs)`
    over N>=3 invocations to surface the variance the bar tests against.
    """
    input_size = len(input_text)
    start = time.perf_counter()
    output = compressor_fn(input_text)
    latency_ms = (time.perf_counter() - start) * 1000.0
    output_size = len(output)
    ratio = output_size / input_size if input_size > 0 else 0.0
    return CompressionResult(
        input_size=input_size,
        output_size=output_size,
        ratio=ratio,
        sample_id=sample_id,
        latency_ms=latency_ms,
    )


def aggregate_compression_runs(
    runs: List[CompressionResult],
    *,
    cv_threshold: float = DEFAULT_CV_THRESHOLD,
    ratio_threshold: float = DEFAULT_RATIO_THRESHOLD,
) -> dict:
    """Aggregate N runs into mean / stdev / CV / min / max + bar verdict.

    Returns:
        dict with keys:
            n               — count of runs
            mean_ratio      — arithmetic mean of ratio
            stdev_ratio     — sample stdev (0.0 when n=1)
            cv              — stdev_ratio / mean_ratio (the variance instrument)
            min_ratio       — best (smallest output, most saving) ratio observed
            max_ratio       — worst (largest output, least saving) ratio observed
            c2_bar_verdict  — one of:
                                "PASS"             — deterministic AND saves
                                "FAIL_NO_SAVING"   — deterministic but mean_ratio above threshold
                                "FAIL_STOCHASTIC"  — CV above threshold (suspect LLM/race)

    Raises:
        ValueError — when runs is empty (refuses to fabricate zero-mean stats).
    """
    if not runs:
        raise ValueError(
            "aggregate_compression_runs requires at least one run; refuses "
            "to fabricate zero-mean stats from an empty list."
        )
    ratios = [r.ratio for r in runs]
    n = len(runs)
    mean_ratio = statistics.mean(ratios)
    stdev_ratio = statistics.stdev(ratios) if n >= 2 else 0.0
    cv = (stdev_ratio / mean_ratio) if mean_ratio > 0 else 0.0
    verdict = _bar_verdict(
        mean_ratio=mean_ratio,
        cv=cv,
        cv_threshold=cv_threshold,
        ratio_threshold=ratio_threshold,
    )
    return {
        "n": n,
        "mean_ratio": mean_ratio,
        "stdev_ratio": stdev_ratio,
        "cv": cv,
        "min_ratio": min(ratios),
        "max_ratio": max(ratios),
        "c2_bar_verdict": verdict,
        "cv_threshold": cv_threshold,
        "ratio_threshold": ratio_threshold,
    }


def partition_runs_by_sample(
    runs: List[CompressionResult],
) -> dict:
    """Group runs by their sample_id base (everything before the first '#').

    Convention:
        sample_id = "<base>#<repeat-suffix>"  — e.g. "log-001#r3"
    Strip the suffix and use `<base>` as the group key. Missing sample_id
    groups under the key "unknown".

    Why this matters: CV across the full flat list mixes
    `compressor_determinism` and `input_heterogeneity` — useless. Per-fixture
    CV (computed on multiple runs of the SAME input) is the clean instrument
    for determinism; partition first, then aggregate per group.

    Returns:
        dict[str, list[CompressionResult]]
    """
    groups: dict[str, List[CompressionResult]] = {}
    for run in runs:
        sid = run.sample_id or "unknown"
        base = sid.split("#", 1)[0] if "#" in sid else sid
        groups.setdefault(base, []).append(run)
    return groups


def _bar_verdict(
    *,
    mean_ratio: float,
    cv: float,
    cv_threshold: float,
    ratio_threshold: float,
) -> str:
    """Return the methodology verdict string for the savings bar."""
    if cv > cv_threshold:
        return "FAIL_STOCHASTIC"
    if mean_ratio > ratio_threshold:
        return "FAIL_NO_SAVING"
    return "PASS"
