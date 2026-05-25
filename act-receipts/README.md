# act-receipts — cache-friendly action receipts for browser MCPs

> Companion code for [*We measured our own scraper-stack. The receipt design works on controlled jitter, but real prod is harder.*](https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/)
>
> Continuation of [part 1](https://gregshevchenko.com/research/mcp-stack-token-economy/) (token economy of a 17-MCP local-first stack).

A **cache-friendly action receipt** is what a browser MCP returns after performing a user-shaped action (click, type, submit, scroll), instead of the full DOM. The receipt's byte representation stays stable across calls when the page region the agent acted on didn't change — so Anthropic's 5-minute prompt cache can hit on the next agent turn.

This directory ships:

- **JSON Schema** for `act_receipt.v1` (`schema/act_receipt_v1.json`)
- **Human-readable spec** (`schema/act_receipt_v1.md`)
- **Python reference implementation** (`python/act_receipts.py`) — validate / canonicalize / hash / score
- **JavaScript reference implementation** (`js/canonical_bytes.mjs`) — byte-equivalent port
- **Cross-runtime equivalence tests** (`python/tests/` + `js/canonical_bytes.test.mjs`) — same SHA-256 across Python + Node
- **Three A/B scenarios** (`scenarios/`) — the iana.org / `/test/jitter` / Hacker News probes from the article
- **`detect_selector_miss_artifact()` guard** (`python/artifact_guard.py`) — useful to anyone running LLM evals against CSS-selectored regions

## Why this is here, not in a separate repo

This is a continuation of the two-axis MCP-stack framework introduced in part 1. The schema + algorithm + guard pattern are **not the moat** — they're the public-facing methodology. The actual measurement engine, scraper-stack tiers, and production deploy live elsewhere; this directory exposes only what's already public in the article.

## Quick example (Python)

```python
from act_receipts import (
    assemble_receipt,
    canonical_receipt_bytes,
    canonical_sha256,
    cache_friendly_score,
)

# After your browser MCP performs an action, build a receipt:
receipt = assemble_receipt(
    action={"type": "click", "selector": "a[href='/about']"},
    pre_url="https://example.com/",
    pre_dom_region_html="<header>...</header>",
    post_url="https://example.com/about",
    post_dom_region_html="<header>...</header>",  # same region content → same hash
    navigated=True,
)

# The cache key is the SHA-256 of the canonical bytes:
print(canonical_sha256(receipt))
# Same semantic action on the same page → same hash → prompt-cache hit
```

## Quick example (JavaScript)

```js
import { canonicalBytes, canonicalSha256 } from "./js/canonical_bytes.mjs";

const receipt = {
  schema_version: "scraper-mcp.act_receipt.v1",
  action: { type: "click", selector: "a[href='/about']" },
  pre_state: { url: "https://example.com/", dom_region_hash: "sha256:abc..." },
  post_state: {
    url: "https://example.com/about",
    dom_region_hash: "sha256:def...",
    changed: true,
    stable: true,
    navigated: true,
  },
  errors: { console: [], network: [], selector_not_found: false, timeout: false, action_failed: null },
  observability: { tier_used: "patchright", duration_ms: 234 },  // stripped before hashing
};

console.log(canonicalSha256(receipt));
// Same semantic receipt → same hash as Python's canonical_sha256()
```

## Run the equivalence tests

```bash
# Python — uses stdlib only
cd python
python3 -m unittest tests.test_canonical_bytes -v

# JavaScript — Node 20+
cd js
node --test canonical_bytes.test.mjs
```

Both suites load the same 4 fixtures (`tests/fixtures/cross_runtime_equivalence.json`) and assert byte-identical canonical output + matching SHA-256.

## Use the artifact guard

```python
from artifact_guard import detect_selector_miss_artifact

# treatment_runs is a list of dicts with at least 'post_region_size_bytes'
is_artifact, reason = detect_selector_miss_artifact(treatment_runs)
if is_artifact:
    print(f"REJECT: {reason}")
```

The guard exists because of an incident: a first A/B run on Hacker News reported +77.8 percentage points "win" that turned out to be a CSS selector miss. `table.itemlist` doesn't exist on HN's homepage → both control and treatment hashed the same empty region → false 100% byte-stability. A permanent guard in the harness now rejects this: if `post_region_size_bytes < 200` across all N runs, the selector probably missed.

Useful to anyone running LLM evals against CSS-selectored regions.

## The three measurement scenarios

The article ships three live A/B measurements. The scenario JSONs are reusable as-is:

| Scenario | Target | What it tells you |
|---|---|---|
| `AB1-iana-click.json` | iana.org (static) | Phase-0 strip already perfect → 0pp delta. **Invariant proof** that JS + Python + Camoufox produce the same SHA-256. |
| `AB2-jitter-fixture.json` | `/test/jitter` (synthetic, see `examples/`) | Controlled DOM noise → **+80pp delta**. Mechanism works. |
| `AB3-hn-frontpage.json` | news.ycombinator.com | Mixed signal (+5pp unique-count, -25pp modal artifact, **+3017ms wall-time**). Real-prod isn't structured like the synthetic. |

Run them against your own browser-MCP fork to compare measurements.

## License

MIT (same as the repo root).

## SSOT

- Canonical article: https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/
- Part 1 article: https://gregshevchenko.com/research/mcp-stack-token-economy/
- Repo root: https://github.com/g-shevchenko/mcp-token-savers

## Credits

- [LakshmanTurlapati/FSB](https://github.com/LakshmanTurlapati/FSB) (BSL 1.1) — architectural inspiration for the action-receipt pattern. We adopted the shape, not the code; this implementation is original.
- [u/pquattro on r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1tn6cey/i_measured_my_claude_code_mcp_stack_on_two_axes/) — feedback on part 1's cache-friendliness framing that pushed us to measure the browser-MCP layer.

## Status

Reference implementation, **not** a published package. Copy what you need; the article documents the boundary of applicability. **Default-on stays OFF** in our own production stack — the wall-time cost on real-prod targets is too steep for a global default.
