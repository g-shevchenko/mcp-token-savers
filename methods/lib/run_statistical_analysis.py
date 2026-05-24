"""Methods v3 axis 2 — apply statistical_analysis library to c2_bench JSON outputs.

Reads one or more c2_bench JSON outputs (produced by `run_c2_bench.py --json`),
extracts per-(compressor, fixture, run) byte-saving observations + per-fixture
cache-stability indicators, and prints a deterministic statistical report:

    - Per-compressor: cluster-bootstrap 95% CI on mean byte-saving B
    - Per-compressor: Wilson 95% CI on cache-friendly score κ
    - Pairwise: Welch t-test + Cohen's d + Holm-Bonferroni-adjusted p-values
    - Variance decomposition: % variance from compressor / fixture / residual

Usage:
    python3 run_statistical_analysis.py /tmp/sophon_500t_v3.json [/tmp/another_compressor.json ...]

The output is plain text — pipe to a file to capture for the methods v3 report.
This script writes NO state and has NO side effects beyond stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from typing import Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from statistical_analysis import (  # noqa: E402
    build_compressor_report,
    variance_decomposition,
    welch_t_test,
    cohens_d,
    holm_bonferroni,
)


SAMPLE_ID_PATTERN = re.compile(r"^(?P<fixture>.+)#r(?P<run>\d+)$")


def parse_c2_bench_json(path: str) -> Tuple[str, Dict[str, List[float]], Dict[str, bool]]:
    """Extract compressor name + per-fixture byte-saving runs + cache-stability."""
    with open(path) as f:
        doc = json.load(f)
    name = doc["compressor"]
    by_fixture_runs: Dict[str, List[float]] = defaultdict(list)
    for record in doc["per_sample"]:
        m = SAMPLE_ID_PATTERN.match(record["sample_id"])
        if not m:
            continue
        fixture = m.group("fixture")
        # B = byte-saving = 1 - ratio
        b = 1.0 - float(record["ratio"])
        by_fixture_runs[fixture].append(b)
    # Cache-stability per fixture: stdev == 0 → K = 1
    cache_friendly: Dict[str, bool] = {}
    for fid, runs in by_fixture_runs.items():
        # Byte-identical output across runs → all ratios identical → stdev = 0
        if len(runs) < 2:
            cache_friendly[fid] = False
        else:
            cache_friendly[fid] = max(runs) - min(runs) < 1e-9
    return name, dict(by_fixture_runs), cache_friendly


def main(paths: List[str]) -> int:
    if not paths:
        print("usage: run_statistical_analysis.py <c2_bench.json> [<more.json> ...]", file=sys.stderr)
        return 2
    print("=" * 78)
    print("Methods v3 axis 2 — statistical analysis of c2_bench JSON outputs")
    print("=" * 78)
    print()
    compressors: List[str] = []
    observations: Dict[str, Dict[str, List[float]]] = {}
    cache: Dict[str, Dict[str, bool]] = {}
    for p in paths:
        name, b_runs, k = parse_c2_bench_json(p)
        compressors.append(name)
        observations[name] = b_runs
        cache[name] = k
        print(f"  loaded: {name} ({len(b_runs)} fixtures × N={len(next(iter(b_runs.values()), []))} runs) from {p}")
    print()

    # --- Per-compressor reports ---
    print("=" * 78)
    print("Per-compressor: byte-saving CI (cluster-bootstrap, cluster=fixture)")
    print("                cache-friendly score CI (Wilson)")
    print("=" * 78)
    print(f"{'compressor':<32}{'B̄':>10}{'B_lo':>10}{'B_hi':>10}{'κ':>8}{'κ_lo':>8}{'κ_hi':>8}")
    print("-" * 78)
    reports = []
    for c in compressors:
        r = build_compressor_report(c, observations[c], cache[c], seed=42)
        reports.append(r)
        print(
            f"{r.name:<32}"
            f"{r.byte_saving_mean:>10.4f}"
            f"{r.byte_saving_ci_lower:>10.4f}"
            f"{r.byte_saving_ci_upper:>10.4f}"
            f"{r.cache_friendly_score:>8.2f}"
            f"{r.cache_friendly_ci_lower:>8.3f}"
            f"{r.cache_friendly_ci_upper:>8.3f}"
        )
    print()

    # --- Pairwise comparisons ---
    print("=" * 78)
    print("Pairwise byte-saving comparison: Welch t-test + Cohen's d + Holm-Bonferroni")
    print("=" * 78)
    raw_p_values: Dict[str, float] = {}
    pairwise: Dict[str, dict] = {}
    fixtures_a = list(observations[compressors[0]].keys())
    for i, c_a in enumerate(compressors):
        for c_b in compressors[i + 1:]:
            # Pool all runs (across fixtures) per compressor
            vals_a = [v for fid in observations[c_a] for v in observations[c_a][fid]]
            vals_b = [v for fid in observations[c_b] for v in observations[c_b][fid]]
            t, df, p = welch_t_test(vals_a, vals_b)
            d = cohens_d(vals_a, vals_b)
            label = f"{c_a} vs {c_b}"
            raw_p_values[label] = p
            pairwise[label] = {
                "t": t,
                "df": df,
                "p": p,
                "d": d,
                "mean_a": sum(vals_a) / len(vals_a),
                "mean_b": sum(vals_b) / len(vals_b),
                "n_a": len(vals_a),
                "n_b": len(vals_b),
            }
    adjusted = holm_bonferroni(raw_p_values)
    print(f"{'comparison':<50}{'B̄_diff':>10}{'t':>8}{'p_raw':>9}{'p_holm':>9}{'d':>7}")
    print("-" * 95)
    for ac in adjusted:
        info = pairwise[ac.label]
        diff = info["mean_a"] - info["mean_b"]
        flag = "*" if ac.rejected_at_005 else " "
        print(
            f"{ac.label:<50}"
            f"{diff:>+10.4f}"
            f"{info['t']:>+8.2f}"
            f"{ac.raw_p:>9.4f}"
            f"{ac.adjusted_p:>9.4f}"
            f"{info['d']:>+7.2f}"
            f" {flag}"
        )
    print()
    print("(* = rejected at α=0.05 family-wise, Holm-Bonferroni adjusted)")
    print()

    # --- Variance decomposition ---
    if len(compressors) >= 2:
        print("=" * 78)
        print("Variance decomposition (method-of-moments, two-way random-effects)")
        print("=" * 78)
        vd = variance_decomposition(observations)
        print(f"  grand mean B:        {vd.grand_mean:.4f}")
        print(f"  total variance σ²:   {vd.total_variance:.6f}")
        print(f"  compressor effect:   {vd.between_compressor:.6f}  ({vd.pct_compressor*100:5.1f}%)")
        print(f"  fixture effect:      {vd.between_fixture:.6f}  ({vd.pct_fixture*100:5.1f}%)")
        print(f"  residual (within):   {vd.within_residual:.6f}  ({vd.pct_residual*100:5.1f}%)")
        print(f"  cells: {vd.n_compressors} compressor × {vd.n_fixtures} fixture × {vd.n_runs_per_cell} runs")
        print()

    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    args = ap.parse_args()
    sys.exit(main(args.paths))
