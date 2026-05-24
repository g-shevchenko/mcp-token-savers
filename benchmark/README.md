# `benchmark/` — measure your own compressor stack

Three small Python primitives (stdlib only, no network) that let you
measure any compressor under the same two-axis lens used to evaluate
`mcp-sophon` in the parent README:

1. **Byte saving** — `output_size / input_size` per fixture, plus
   variance (CV) across N repeats
2. **Cache-friendliness** — whether the output is byte-identical
   across N runs of the same input (the necessary condition for
   downstream LLM provider prefix-cache reuse)

The 12-anti-pattern audit script scans source trees for documented
cache-killing patterns. The DSA reference for the framing is at
[github.com/DenisSergeevitch/agents-best-practices](https://github.com/DenisSergeevitch/agents-best-practices)
(MIT, provider-neutral synthesis of OpenAI / Anthropic / MCP guidance).

## Files

| File | Role |
|---|---|
| `c2_benchmark.py` | byte-saving primitive: `measure_compression`, `aggregate_compression_runs`, `partition_runs_by_sample` |
| `cache_metrics.py` | cache-friendliness primitive: `measure_output_stability`, `cache_friendly_score` |
| `anti_pattern_audit.py` | 12-pattern grep audit against any source tree |
| `run_bench.py` | CLI runner over a JSONL fixture file |
| `examples/fixtures.jsonl` | 5 neutral example fixtures (prose, log, markdown, JSON, stack trace) |
| `examples/example_compressor.py` | toy compressors to smoke-test the harness |
| `tests/` | unit tests for both primitives (pytest) |

## Quickstart — measure your own compressor

```python
# 1. Import the primitive
import sys; sys.path.insert(0, 'benchmark')
from c2_benchmark import measure_compression, aggregate_compression_runs

# 2. Wrap your compressor as `(str) -> str`
def my_compressor(text: str) -> str:
    # ... your prep / regex / vendor MCP call here ...
    return compressed_text

# 3. Measure on your corpus
import json
runs = []
with open('my_fixtures.jsonl') as f:
    for line in f:
        rec = json.loads(line)
        for repeat in range(5):  # N=5 for variance probe
            r = measure_compression(
                rec['input'],
                my_compressor,
                sample_id=f"{rec['id']}#r{repeat+1}",
            )
            runs.append(r)

# 4. Aggregate
from c2_benchmark import partition_runs_by_sample
for fixture_id, group in partition_runs_by_sample(runs).items():
    agg = aggregate_compression_runs(group)
    print(f"{fixture_id}: ratio={agg['mean_ratio']:.4f} cv={agg['cv']:.4f} {agg['c2_bar_verdict']}")
```

Or via the CLI:

```bash
cd benchmark
python3 run_bench.py --compressor first200 --fixtures examples/fixtures.jsonl --repeat 5
python3 run_bench.py --compressor list  # show available compressors
```

## Cache-friendliness probe (the second axis)

```python
from cache_metrics import measure_output_stability, cache_friendly_score

measurements = []
for rec in fixtures:
    m = measure_output_stability(
        input_text=rec['input'],
        compressor_fn=my_compressor,
        n=5,
        sample_id=rec['id'],
    )
    measurements.append(m)

print(f"cache_friendly_score = {cache_friendly_score(measurements):.2%}")
for m in measurements:
    print(f"  {m.sample_id}: unique_md5={m.unique_md5_count} stable={m.cache_stable}")
```

A compressor at 100% cache_friendly_score is byte-identical on every
fixture across N=5 runs. A compressor below 100% will defeat the
provider prefix cache for that fraction of inputs — which means the
byte saving you measured single-shot may not show up in production
cost.

## 12-anti-pattern audit (the cache-killer scanner)

```bash
# Audit one MCP / source tree:
python3 anti_pattern_audit.py --mcp path/to/your-mcp/src

# Audit several at once, rooted at a parent dir:
python3 anti_pattern_audit.py --root services \
  --mcp mcp-a --mcp mcp-b --mcp mcp-c

# Machine-readable JSON output (for CI):
python3 anti_pattern_audit.py --mcp ./src --json
```

Output shows PASS / VIOLATION / N/A / MANUAL per rule per target,
with evidence (file + line) for each VIOLATION. A clean run prints
"Total violations: 0".

## Bar thresholds (methodology)

A compressor passes the byte-saving bar iff:

- **CV ≤ 0.05** (5% variation tolerated — covers parser timing jitter)
- **mean_ratio ≤ 0.70** (30% saving minimum)

Tune via:

```python
aggregate_compression_runs(runs, cv_threshold=0.10, ratio_threshold=0.50)
```

For cache-friendliness, there's no threshold to tune — `cache_friendly_score`
is simply the fraction of fixtures that are byte-stable. 100% is the goal;
anything lower is a real production cost surface.

## Tests

```bash
cd benchmark
python3 -m pytest tests/ -q
```

Expected: all green. The harness has no external dependencies (stdlib
only), so tests should pass on any Python 3.9+.

## Reproducibility

Everything in this directory is intentionally minimal. No HWAI-specific
fixtures, no measured numbers, no internal MCPs. Bring your own
compressor and your own corpus; the harness gives you the same lens.

## Why two axes?

Byte saving alone can hide production cost. A compressor that produces
different output bytes on every run defeats the downstream LLM
provider's prefix cache — every turn pays the full prefill again. The
byte saving you measured single-shot evaporates over multi-turn use.

A compressor with smaller byte saving but byte-identical output every
run (cache-friendly by construction) often produces a better
*end-to-end* cost than a more aggressive but stochastic alternative.

The DSA reference walks through the full reasoning + the 12 anti-patterns
that destroy cache reuse even when the compressor itself is deterministic:

  https://github.com/DenisSergeevitch/agents-best-practices/blob/main/references/prompt-caching-and-cost.md
