"""Artifact-detection guards for A/B measurements on browser-MCP scenarios.

Companion to https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/
(see § "The almost-public mistake").

The guard pattern exists because a first A/B run reported a huge "win"
(+77.8 percentage points on Hacker News) that turned out to be an
artifact: the CSS selector `table.itemlist` doesn't exist on HN's
current homepage. Both control and treatment hashed the same empty
region -> 100% byte-stable -> false 100% cache-friendliness.

A deterministic Python repro caught it. The guard is in the harness
permanently now. Useful to anyone running LLM evals against
CSS-selectored regions.

Standard library only. License: MIT.
"""
from __future__ import annotations

from typing import Optional

# Below this byte threshold across ALL N runs, the selector is almost
# certainly missing or hashing an empty/near-empty region. 200 bytes is
# chosen because:
# - An empty <body></body> serializes well under 200 bytes
# - A real HN front-page row is on the order of 8 KB
# - Smallest legitimate region we've measured is ~600 bytes
# Tune via the optional `min_legit_bytes` argument if your evidence differs.
DEFAULT_MIN_LEGIT_BYTES = 200


def detect_selector_miss_artifact(
    treatment_runs: list[dict],
    *,
    min_legit_bytes: int = DEFAULT_MIN_LEGIT_BYTES,
    field_name: str = "post_region_size_bytes",
) -> tuple[bool, Optional[str]]:
    """Detect the empty-region artifact (CSS selector miss on the target).

    Args:
        treatment_runs: list of per-run dicts; each must carry the
            byte-size of the post-action region (default field
            `post_region_size_bytes`).
        min_legit_bytes: below this, across ALL runs, we flag as artifact.
        field_name: override the dict key carrying the byte size.

    Returns:
        (is_artifact, reason). On a real artifact, `is_artifact=True` and
        `reason` is a short human-readable string suitable for a CI/log
        message. Otherwise `(False, None)`.

    Use the negative case to REJECT a result before it lands as a "win"
    in a report.

    Examples:
        >>> runs = [{"post_region_size_bytes": 12}, {"post_region_size_bytes": 14}]
        >>> detect_selector_miss_artifact(runs)
        (True, 'empty content: max post_region_size_bytes=14 across 2 runs (threshold=200)')

        >>> runs = [{"post_region_size_bytes": 8421}, {"post_region_size_bytes": 8019}]
        >>> detect_selector_miss_artifact(runs)
        (False, None)
    """
    if not treatment_runs:
        return False, None

    sizes = [run.get(field_name, 0) for run in treatment_runs]
    max_size = max(sizes)

    if max_size < min_legit_bytes:
        reason = (
            f"empty content: max {field_name}={max_size} across "
            f"{len(treatment_runs)} runs (threshold={min_legit_bytes})"
        )
        return True, reason

    return False, None


def detect_constant_hash_artifact(
    treatment_runs: list[dict],
    *,
    field_name: str = "post_region_hash",
    require_runs: int = 3,
) -> tuple[bool, Optional[str]]:
    """Detect the constant-hash artifact (identical hashes across all runs).

    Identical hashes across N >= require_runs is suspicious only when paired
    with selector-miss evidence; otherwise it can be a genuine cache-friendly
    result. Use this as a *secondary* check after selector-miss; never as the
    sole gate.

    Returns (is_artifact_candidate, reason).
    """
    if len(treatment_runs) < require_runs:
        return False, None

    hashes = {run.get(field_name) for run in treatment_runs}
    if len(hashes) == 1 and None not in hashes:
        return True, (
            f"all {len(treatment_runs)} {field_name} values are identical: "
            f"{next(iter(hashes))!r} — sanity-check with selector-miss guard"
        )
    return False, None
