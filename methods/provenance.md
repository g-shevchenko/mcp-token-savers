# Provenance — public Methods v3 mirror

> Pins exactly what environment + code state produced the numbers in
> `statistical_analysis.md` on **this** public repo. Anyone reproducing
> the study must match these inputs or document why they diverged.

## 1. Reference host environment

These versions reproduced byte-identical results on the original
measurement host (2026-05-24). The Dockerfile in this directory pins
**these specific versions**; if you build the image, you get the same
env regardless of your host.

| Layer | Pinned version |
|---|---|
| Python | `3.13.0-slim-bookworm` (Docker base) |
| Node.js | `22.11.0-bookworm-slim` (Docker base; mcp-sophon needs ≥18) |
| mcp-sophon | `0.5.4` (npm) |
| ripgrep | `14.x` (apt-pinned) |

Direct-host minimum (without Docker): Python 3.11+, Node 18+,
mcp-sophon 0.5.4 reachable via `$SOPHON_BIN` or `~/.npm-global/bin/sophon`.

## 2. Repository state

Public repo: `https://github.com/g-shevchenko/mcp-token-savers`.

The numbers in `statistical_analysis.md` were measured against the
fixture `benchmark/c2_bench/fixtures/long_realistic_v3.jsonl`. Any
later modification of that file would invalidate the SHA below; the
file is expected to be **append-only** so historical numbers remain
citable. If you need to retest at a later commit, regenerate the
numbers and update this provenance — never silently report old
numbers against a different fixture state.

## 3. RNG seeds (frozen)

| Function | Seed |
|---|---|
| Cluster-bootstrap CI (`methods/lib/statistical_analysis.py::cluster_bootstrap_ci`) | `42` |
| Future genre sampling for N≥60 expansion (per `preregistration_n60.md` § 2.2) | `42` |

Both seeds are hard-coded in source. Changing them is a measured action
that requires re-running both rounds for parity.

## 4. Bootstrap parameters

| Parameter | Value | Justification |
|---|---|---|
| `n_resamples` | 2000 | Standard upper-mid range (Efron & Tibshirani 1993 recommend 1000+; 2000 keeps Monte-Carlo error of CI bounds under 1% of bound width for typical statistics) |
| `conf` | 0.95 | Standard two-sided 95% |
| z-quantile | 1.95996 | Computed via Beasley-Springer-Moro inverse-normal, library-internal |

## 5. Repeatability guarantee

Two consecutive runs of `repro-entrypoint.sh` against this repo at the
same commit + Docker image produce **byte-identical**
`statistical_analysis.txt` outputs. This is guaranteed by:

- sophon being byte-deterministic on this fixture corpus (verified —
  `κ = 1.0` across 15 fixtures × N=5 runs in `statistical_analysis.md`).
- Cluster-bootstrap RNG seed pinned at 42.
- Wilson CI being closed-form deterministic.
- Welch t + Cohen's d + Holm-Bonferroni being deterministic given the
  same input data.

If your reproduction produces different bytes, file an issue with your
provenance (this file's format) + the diff.

## 6. What is NOT pinned

- **The Anthropic / OpenAI / Gemini provider-pricing values** quoted in
  `formalization.md § 2.4`. Those reflect 2026-05-24 published pricing
  and may change. The `ρ = 0.10` ratio used in the cost-model theorem
  is a 2026 snapshot; it has historically been in the `0.05 – 0.25`
  range across providers.
- **The N≥60 corpus.** Round-1 (this report) uses the N=15
  `long_realistic_v3.jsonl` only. The expansion is a separate fixture
  file and a separate provenance (see `preregistration_n60.md`).
- **The list of compressors compared.** This document pins sophon as
  the reference public compressor (npm-installable, fully reproducible).
  Adding more compressors to a comparison adds rows to
  `statistical_analysis.md` without invalidating this provenance.

## 7. Cross-references

- `README.md` — entry point and reading order.
- `formalization.md` — formal definitions of B, K, Q, C_prod the protocol uses.
- `statistical_analysis.md` — the report whose numbers this pins.
- `preregistration_n60.md` — protocol for the next round.
- `datasheet.md` — corpus disclosure.
- `Dockerfile` + `repro-entrypoint.sh` — turnkey reproduction.
- `lib/statistical_analysis.py` — the analysis library (pure Python stdlib).
- `lib/tests/test_statistical_analysis.py` — 16 tests pinning library behaviour.
