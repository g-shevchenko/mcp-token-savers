"""CLI runner — measure any compressor against a fixture corpus.

Usage:
    python3 run_bench.py --compressor first200 --fixtures examples/fixtures.jsonl
    python3 run_bench.py --compressor first200 --repeat 5 --json
    python3 run_bench.py --compressor list

Register your own compressor by importing it and adding to
COMPRESSOR_REGISTRY (see `examples/example_compressor.py`).

Reports BOTH axes:
- byte-saving (input_size / output_size ratio, per-fixture + corpus mean)
- variance (CV — coefficient of variation across N repeats)

Pair with `cache_metrics.measure_output_stability` for the
cache-friendliness axis.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import statistics
from typing import Callable, Iterable

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from c2_benchmark import (  # noqa: E402
    aggregate_compression_runs,
    measure_compression,
    partition_runs_by_sample,
)


# ---------------------------------------------------------------------------
# Built-in compressors for harness smoke + sanity. Replace with your own.
# ---------------------------------------------------------------------------


def _first_n_chars_factory(n: int) -> Callable[[str], str]:
    def _impl(x: str) -> str:
        return x[:n]
    return _impl


def _passthrough(x: str) -> str:
    return x


def _whitespace_collapse(x: str) -> str:
    """Collapse runs of whitespace — toy deterministic compressor."""
    return " ".join(x.split())


COMPRESSOR_REGISTRY: dict[str, Callable[[str], str]] = {
    "first200": _first_n_chars_factory(200),
    "first1k": _first_n_chars_factory(1000),
    "passthrough": _passthrough,
    "ws_collapse": _whitespace_collapse,
}


# Optional: load extra compressors from examples/example_compressor.py if available
try:
    from examples.example_compressor import register as _register_examples  # type: ignore
    _register_examples(COMPRESSOR_REGISTRY)
except Exception:
    pass


def _iter_fixtures(path: str) -> Iterable[dict]:
    """Yield {"id": str, "input": str} records from a JSONL file."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--compressor", default="first200",
                    help="name in COMPRESSOR_REGISTRY (or 'list' to print)")
    ap.add_argument("--fixtures", default=os.path.join(HERE, "examples", "fixtures.jsonl"),
                    help="path to JSONL fixture file ({id, input} per line)")
    ap.add_argument("--repeat", type=int, default=1,
                    help="run each fixture N times (variance probe)")
    ap.add_argument("--json", action="store_true",
                    help="emit machine-readable JSON instead of text")
    args = ap.parse_args()

    if args.compressor == "list":
        for name in sorted(COMPRESSOR_REGISTRY):
            print(name)
        return 0

    if args.compressor not in COMPRESSOR_REGISTRY:
        print(f"ERROR: unknown compressor '{args.compressor}'. "
              f"Available: {sorted(COMPRESSOR_REGISTRY)}", file=sys.stderr)
        return 2
    fn = COMPRESSOR_REGISTRY[args.compressor]

    if not os.path.isfile(args.fixtures):
        print(f"ERROR: fixtures file not found: {args.fixtures}", file=sys.stderr)
        return 2

    all_runs = []
    per_sample_lines = []
    for record in _iter_fixtures(args.fixtures):
        sid = record.get("id", "<unknown>")
        for repeat_idx in range(args.repeat):
            result = measure_compression(
                input_text=record["input"],
                compressor_fn=fn,
                sample_id=f"{sid}#r{repeat_idx + 1}",
            )
            all_runs.append(result)
            per_sample_lines.append({
                "sample_id": result.sample_id,
                "input_size": result.input_size,
                "output_size": result.output_size,
                "ratio": round(result.ratio, 4),
                "latency_ms": round(result.latency_ms or 0.0, 3),
            })

    groups = partition_runs_by_sample(all_runs)
    per_fixture_aggs = {fid: aggregate_compression_runs(grp) for fid, grp in groups.items()}
    fixture_means = [a["mean_ratio"] for a in per_fixture_aggs.values()]
    corpus_mean_ratio = statistics.mean(fixture_means) if fixture_means else 0.0
    corpus_median_ratio = statistics.median(fixture_means) if fixture_means else 0.0

    fixture_verdicts = [a["c2_bar_verdict"] for a in per_fixture_aggs.values()]
    n_pass = sum(1 for v in fixture_verdicts if v == "PASS")
    n_fixtures = len(fixture_verdicts)
    corpus_pass_rate = n_pass / n_fixtures if n_fixtures else 0.0

    if args.json:
        payload = {
            "compressor": args.compressor,
            "fixtures": args.fixtures,
            "repeat_per_fixture": args.repeat,
            "per_sample": per_sample_lines,
            "per_fixture": per_fixture_aggs,
            "corpus": {
                "n_fixtures": n_fixtures,
                "n_pass": n_pass,
                "pass_rate": corpus_pass_rate,
                "mean_ratio": corpus_mean_ratio,
                "median_ratio": corpus_median_ratio,
            },
        }
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(f"=== compressor bench — compressor={args.compressor} ===")
        print(f"fixtures: {args.fixtures}  repeat={args.repeat}\n")
        print(f"{'sample_id':32s} {'in':>8s} {'out':>8s} {'ratio':>7s} {'lat_ms':>8s}")
        for row in per_sample_lines:
            print(f"{row['sample_id']:32s} {row['input_size']:>8d} "
                  f"{row['output_size']:>8d} {row['ratio']:>7.4f} "
                  f"{row['latency_ms']:>8.3f}")
        print()
        print("--- per-fixture (determinism: low CV good) ---")
        print(f"{'fixture':32s} {'n':>3s} {'mean':>7s} {'cv':>7s} {'verdict':>16s}")
        for fid, a in per_fixture_aggs.items():
            print(f"{fid:32s} {a['n']:>3d} {a['mean_ratio']:>7.4f} "
                  f"{a['cv']:>7.4f} {a['c2_bar_verdict']:>16s}")
        print()
        print("--- corpus aggregate ---")
        print(f"n_fixtures   = {n_fixtures}")
        print(f"pass_rate    = {n_pass}/{n_fixtures} = {corpus_pass_rate:.2%}")
        print(f"mean_ratio   = {corpus_mean_ratio:.4f}  "
              f"(mean across per-fixture means)")
        print(f"median_ratio = {corpus_median_ratio:.4f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
