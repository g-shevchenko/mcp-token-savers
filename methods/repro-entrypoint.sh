#!/bin/bash
# Methods v3 reproducibility entrypoint.
#
# Runs the c2_bench harness on the pinned 15-fixture corpus, captures JSON
# results, and emits the statistical analysis to /results/.
#
# Expected mounts:
#   /work     — repo root (read-only ok)
#   /results  — output directory (writable)
#
# Bytes-stable assertion: two consecutive invocations of this script against
# the same source tree at the same commit MUST produce byte-identical
# /results/statistical_analysis.txt files. This is checked by
# scripts/mcp-token-eval/c2_bench/tests/test_statistical_analysis.py (Wilson
# CI tests pin the bootstrap seed; the c2_bench measurements are deterministic
# because all included compressors are byte-deterministic).
set -euo pipefail

REPO=${REPO:-/work}
OUT=${OUT:-/results}
mkdir -p "$OUT"

BENCH_DIR="$REPO/scripts/mcp-token-eval/c2_bench"
if [ ! -d "$BENCH_DIR" ]; then
  # Public mcp-token-savers tree uses mcp/source/scripts/... layout
  if [ -d "$REPO/benchmark/c2_bench" ]; then
    BENCH_DIR="$REPO/benchmark/c2_bench"
  else
    echo "ERROR: cannot find c2_bench under /work" >&2
    exit 2
  fi
fi

CORPUS="${BENCH_DIR}/fixtures/long_realistic_v3.jsonl"
if [ ! -f "$CORPUS" ]; then
  echo "ERROR: corpus missing: $CORPUS" >&2
  exit 2
fi

echo "== Methods v3 reproducibility run =="
echo "  benchmark dir: $BENCH_DIR"
echo "  corpus:        $CORPUS ($(wc -l < "$CORPUS") fixtures)"
echo "  output dir:    $OUT"
echo "  sophon:        $(sophon --version 2>/dev/null || echo 'unknown')"
echo "  node:          $(node --version)"
echo "  python:        $(python3 --version)"
echo "  ripgrep:       $(rg --version 2>/dev/null | head -1)"
echo

cd "$BENCH_DIR"

# Step 1: capture per-compressor measurements
# Default: measure sophon only (public). To compare against a second
# compressor, add its name here (and ensure run_c2_bench.py knows it).
for compressor in sophon_500t; do
  echo "-- measuring $compressor --"
  python3 run_c2_bench.py \
    --compressor "$compressor" \
    --fixtures fixtures/long_realistic_v3.jsonl \
    --repeat 5 --json > "$OUT/${compressor}_v3.json"
done

# Step 2: run statistical analysis
echo "-- statistical analysis --"
python3 run_statistical_analysis.py \
  "$OUT/sophon_500t_v3.json" > "$OUT/statistical_analysis.txt"

echo
echo "== DONE =="
echo "  outputs:"
ls -la "$OUT/"
