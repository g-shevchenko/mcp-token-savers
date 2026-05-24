# Methods — formalization, statistical rigor, reproducibility

> This directory is the peer-review-ready backing for the `benchmark/`
> harness. If `benchmark/` is the *measurement primitive*, `methods/`
> is the *statistical and methodological framework* that makes the
> numbers defensible.

## Why this exists

The `benchmark/` directory ships a working harness with point-estimate
results. That is enough for a quick "does my compressor work" smoke
test. It is **not** enough to publish a claim or defend a comparison
between compressors. To go from "I measured a number" to "I measured a
number with a defensible confidence bound", you need:

1. **A formal definition** of what `byte-saving`, `cache-friendliness`,
   `quality preservation`, and `production cost` mean as functions of
   the compressor and the input. → `formalization.md`
2. **Statistical analysis with proper CIs**: not just point estimates,
   but confidence intervals that respect the clustered (per-fixture)
   structure of the data. → `statistical_analysis.md` + `lib/`
3. **Pre-registration** for any future-round expansion, so the
   analysis is confirmatory instead of exploratory. → `preregistration_n60.md`
4. **Reproducibility**: pinned environment, pinned RNG seeds, a
   Datasheet for the corpus, a Dockerfile for the harness. → `Dockerfile`
   + `provenance.md` + `datasheet.md` + `repro-entrypoint.sh`
5. **Independent evaluation**: someone who didn't build the harness
   should run it and report their numbers. → out of scope for this
   directory; see § "What's missing" below.

## Reading order

| When you want to... | Read |
|---|---|
| Understand the formal model + cost-model theorem | `formalization.md` |
| See the real numbers with CIs (sophon on the 15-fixture corpus) | `statistical_analysis.md` |
| Add your own compressor to the comparison | `statistical_analysis.md` § 4 |
| Understand the corpus + its biases | `datasheet.md` |
| Reproduce the numbers turnkey | `Dockerfile` + `repro-entrypoint.sh` + `provenance.md` |
| Contribute to the N≥60 expansion under a frozen protocol | `preregistration_n60.md` |
| Read or extend the statistical library | `lib/statistical_analysis.py` + `lib/tests/` |

## Quick reproduction

```bash
# Direct (requires Python 3.11+, Node 18+, mcp-sophon 0.5.4):
cd benchmark/c2_bench
python3 run_c2_bench.py --compressor sophon_500t \
  --fixtures fixtures/long_realistic_v3.jsonl --repeat 5 --json \
  > /tmp/sophon.json
python3 ../../methods/lib/run_statistical_analysis.py /tmp/sophon.json

# Containerized (pinned env; bytes-identical across hosts):
docker build -t methods-bench -f methods/Dockerfile .
mkdir -p results
docker run --rm -v $PWD:/work -v $PWD/results:/results methods-bench
cat results/statistical_analysis.txt
```

## The headline numerical finding

Sophon@0.5.4 on the 15-fixture `long_realistic_v3` corpus
(N=5 runs per fixture, deterministic):

| metric | point | 95% CI | source |
|---|---|---|---|
| mean byte-saving | 0.828 | [0.721, 0.900] | cluster-bootstrap |
| cache-friendly score | 1.000 (15/15) | [0.796, 1.000] | Wilson |
| pass rate at `B ≥ 0.30` | 14/15 = 0.933 | [0.701, 0.988] | Wilson |

**The Wilson CI on cache-friendly score is the lesson.** A
point-estimate "100% cache-friendly" is a sample statistic. The
population proportion is `≥79.6% at 95% confidence` on a corpus this
size — wide, not tight. Anyone publishing a "100% cache-friendly"
claim without that caveat is over-claiming on small N. Wider corpora
narrow the CI; see `preregistration_n60.md`.

## Library quality

The `lib/` Python module is pure stdlib (no scipy, no statsmodels, no
numpy). This is deliberate: the library should work in any
constrained Python environment (Docker minimum image, restricted CI,
embedded). Test coverage is **16 tests, all passing** at the
`tests/test_statistical_analysis.py` level, including textbook
reference values for Wilson at the 0/N and N/N boundaries.

```
$ cd methods/lib
$ python3 -m unittest tests.test_statistical_analysis
................
Ran 16 tests in 0.052s
OK
```

## What's missing (honest disclosure)

This directory provides the **methodology** for peer review. It is
**not yet itself peer-reviewed**. Specifically:

1. **No independent evaluator has run this harness and reported their
   numbers.** The reference numbers in `statistical_analysis.md` were
   produced by the same person who built the harness — a known
   author-contamination risk for any benchmark. The right antidote is
   ≥2 independent groups running the same harness on the same
   corpus and reporting their results; until that happens the
   reference numbers should be read as "what the author measured",
   not "what the population is".

2. **The N=15 corpus is small.** All CIs are wide. `preregistration_n60.md`
   describes the protocol for the N≥60 expansion that narrows them.

3. **The cost-model theorem in `formalization.md` § 3 is provider-
   pricing-dependent.** The `ρ = 0.10` cached-input discount used in
   the theorem reflects 2026-05 Anthropic Sonnet 4.5 pricing. Other
   providers and other times will change `ρ`; the crossover condition
   `b_A < 1 − (1 − b_B) · ρ` does not depend on the specific value
   but the numerical examples do.

4. **The "99% byte-saver" hook in the upstream article is rhetorical,
   not mathematical, at literal `b_A = 0.99`.** The cost-model
   derivation in `formalization.md` § 3.1 shows the hook holds for
   `b_A < 0.96` (with `b_B = 0.60`, `ρ = 0.10`). The hook is correct
   for measured-compressor values (typically `b ≈ 0.7 – 0.95`) but
   not at the literal boundary value. See `statistical_analysis.md` § 5.

## Suggested peer-review targets

This directory contains the artefacts you'd cite in a workshop
submission or technical-paper:

- **ICML EvalEval workshop** (benchmark-methodology track).
- **NeurIPS ML Reproducibility Challenge.**
- **EMNLP system demonstrations** (engineering-eval track).
- Direct outreach to **LMSys Chatbot-Arena eval team**, **Anthropic
  devrel**, **Stanford CRFM HELM team**, **Sourcegraph eval team**.

If you do submit and want to cite this directory in stable form, pin
the URL to a tagged commit (see the repo's release tags) rather than
`HEAD`.

## License

This directory inherits the repository's license (MIT). The
statistical library, the formal definitions, and the protocol are
free for any use including commercial. The fixture corpus
(`benchmark/c2_bench/fixtures/`) is also MIT-licensed per the
repository.
