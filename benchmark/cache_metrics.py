"""Cache-friendliness metrics — output-stability dimension.

Byte saving is necessary but not sufficient for production token cost.
The second axis is whether the compressor's output is BYTE-IDENTICAL
across runs of the same input. Byte-identical output lets the
downstream LLM provider's prefix cache reuse work from prior turns —
turning a measured byte saving into a real cost reduction. Non-
deterministic output defeats the cache: every turn looks like a fresh
prompt to the provider and pays the full prefill again, often eating
the byte saving outright.

This module pins the cache-friendliness contract. It measures the
compressor's OUTPUT stability (necessary condition for downstream
provider-cache reuse). Provider-side cached_tokens telemetry is a
separate layer (requires Anthropic/OpenAI usage block) — out of scope
for this primitive.

Reference: the `stable prefix, dynamic suffix` rule and the 12-anti-
pattern catalog are documented in the agents-best-practices reference
repository (MIT, provider-neutral synthesis of OpenAI / Anthropic /
MCP guidance): https://github.com/DenisSergeevitch/agents-best-practices

Compose with `c2_benchmark.measure_compression` for the byte-saving
axis. Same deterministic-only design — pure functions, stdlib only,
no network.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Callable, List, Optional


@dataclass
class CacheMeasurement:
    """One cache-friendliness measurement (N runs of same compressor + input).

    Attributes:
        sample_id:        fixture identifier for audit + per-fixture grouping
        n:                number of repeats performed (>= 2)
        unique_md5_count: number of distinct md5(output) values across the N runs.
                          1 = perfectly cache-stable; N = fully stochastic
        cache_stable:     unique_md5_count == 1
        output_md5:       hex md5 of the FIRST run's output (for cross-run audit)
    """

    sample_id: str
    n: int
    unique_md5_count: int
    cache_stable: bool
    output_md5: str


def measure_output_stability(
    input_text: str,
    compressor_fn: Callable[[str], str],
    n: int = 5,
    sample_id: Optional[str] = None,
) -> CacheMeasurement:
    """Run `compressor_fn(input_text)` N times; record output-md5 stability.

    Raises:
        ValueError — when n < 2 (cache stability undefined for N=1)
    """
    if n < 2:
        raise ValueError(
            f"measure_output_stability requires n>=2; got n={n}. "
            "Cache stability is undefined for a single run."
        )

    md5s: List[str] = []
    for _ in range(n):
        output = compressor_fn(input_text)
        h = hashlib.md5(output.encode("utf-8")).hexdigest()
        md5s.append(h)

    unique = len(set(md5s))
    return CacheMeasurement(
        sample_id=sample_id or "",
        n=n,
        unique_md5_count=unique,
        cache_stable=(unique == 1),
        output_md5=md5s[0],
    )


def cache_friendly_score(measurements: List[CacheMeasurement]) -> float:
    """Corpus-level fraction of cache-stable fixtures.

    Returns:
        float in [0.0, 1.0]. 1.0 = every fixture's output was byte-identical
        across its N runs (fully cache-friendly compressor). 0.0 = every
        fixture varied (fully stochastic — defeats prefix cache).

    Raises:
        ValueError — empty input. Refuses to fabricate a score from nothing.
    """
    if not measurements:
        raise ValueError(
            "cache_friendly_score requires at least one measurement; "
            "refuses to fabricate stats from an empty corpus."
        )
    stable = sum(1 for m in measurements if m.cache_stable)
    return stable / len(measurements)
