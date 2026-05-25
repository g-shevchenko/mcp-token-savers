# Schema: `scraper-mcp.act_receipt.v1`

> Public spec of the action-receipt shape used by cache-friendly browser MCPs.
> Companion to [*MCP-stack token economy, part 2*](https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/).

## Motivation

The default `op:"act"` mode of a browser MCP returns the full DOM after each action. This serves correctness (the agent can verify state visually) but defeats prompt-cache by construction — full DOM contains:

- Animation frame counters
- Focus indicators (`:focus-visible` state)
- Timestamp-like elements (countdown timers, "last updated 3 sec ago")
- Polling response payloads (hidden data attributes that refresh)
- ARIA-live region updates
- Anti-bot fingerprint markers injected by some sites

Even when the SEMANTICS of the page are stable, the BYTES vary on every fetch. This means cache miss on every agent turn that re-reads the DOM.

`op:"act_receipt"` (this spec) returns a small structured object containing only the information an agent needs for the **next decision**, with a byte-stable canonical form for prompt-cache reuse.

## Schema

```jsonc
{
  "schema_version": "scraper-mcp.act_receipt.v1",
  "action": {
    "type": "click" | "type" | "press" | "scroll" | "wait" | "navigate" | "select" | "drag",
    "selector": "css-or-xpath-or-text",  // omitted for type-only actions like "wait"
    "value": "...",                      // text typed, key name pressed, scroll delta, etc.
    "options": {
      "wait_after_ms": 500,
      "force": false,
      "strict": true
    }
  },
  "pre_state": {
    "url": "https://example.com/path?q=v",
    "dom_region_hash": "sha256:abc...",  // SHA-256 of the bounding-box DOM subtree around the action target
    "dom_region_size_bytes": 2341         // for observability, NOT in cache key
  },
  "post_state": {
    "url": "https://example.com/result?q=v",
    "dom_region_hash": "sha256:def...",
    "dom_region_size_bytes": 2872,
    "changed": true,                      // dom_region_hash differs from pre_state
    "stable": true,                       // DOM settled (no mutations for N ms)
    "navigated": false                    // URL changed
  },
  "errors": {
    "console": [],                        // canonicalized empty array — NOT omitted
    "network": [],
    "selector_not_found": false,
    "timeout": false,
    "action_failed": null                 // null OR { reason, retry_safe }
  },
  "observability": {
    "tier_used": "patchright",            // stripped from cache key
    "duration_ms": 234,                   // stripped from cache key
    "timing_breakdown": {                 // stripped from cache key
      "selector_lookup_ms": 12,
      "action_execution_ms": 45,
      "post_wait_ms": 178
    }
  }
}
```

## Cache-friendliness rules

Required for `cache_friendly_score == 1.0` on repeated identical `(action, pre_state.url, pre_state.dom_region_hash)` inputs.

### MUST be in canonical-byte representation

- `schema_version` — exact string match
- `action.*` — exact match (sorted-key serialization)
- `pre_state.url`, `pre_state.dom_region_hash`
- `post_state.url`, `post_state.dom_region_hash`, `post_state.changed`, `post_state.stable`, `post_state.navigated`
- `errors.*` — empty arrays canonicalized as `[]`, not omitted

### MUST be stripped before canonical-byte hashing

- `pre_state.dom_region_size_bytes` (informational, byte size varies with browser version)
- `post_state.dom_region_size_bytes`
- `observability.tier_used` (tier may differ on retry)
- `observability.duration_ms`
- `observability.timing_breakdown.*`

### MUST NOT appear in receipt body

- Timestamps (any form)
- Request IDs / trace IDs
- Browser session IDs
- Cookie values
- Hex/uuid that varies per call

## Hash computation: `dom_region_hash`

```python
def dom_region_hash(dom_subtree_html: str) -> str:
    """Cache-friendly hash of the DOM region around the action target.

    Strips DOM-noise patterns BEFORE hashing so same semantic content
    produces same hash even when noise varies.
    """
    cleaned = strip_dom_noise(dom_subtree_html)
    return "sha256:" + hashlib.sha256(cleaned.encode("utf-8")).hexdigest()
```

The default noise patterns (`data-time`, `data-timestamp`, `data-frame`, `data-focused`) are documented in `python/act_receipts.py::DOM_NOISE_ATTR_PATTERNS`. Add per-site patterns as your evidence requires.

## Comparison: full-DOM `op:"act"` vs `op:"act_receipt"`

| Aspect | `op:"act"` | `op:"act_receipt"` |
|---|---|---|
| Bytes returned per call | 50-500 KB (full DOM) | 0.5-2 KB (receipt only) |
| `cache_friendly_score` on repeat | < 50% (DOM noise) | ≥ 95% (canonical receipt) |
| Information available to agent | Full DOM | Action confirmation + region hashes |
| Verification: did action succeed? | Agent diffs DOM | `post_state.changed && stable` |
| Verification: did URL change? | Agent parses HTML | `post_state.navigated` |
| Verification: errors? | Agent parses console output | `errors.console`, `errors.action_failed` |

## When to use which

- **`op:"act_receipt"`** — multi-turn agent loops where the same target site is operated on repeatedly. Cache hits matter. Sites with documented DOM noise (timestamps, frame counters, ARIA-live).
- **`op:"act"`** (preserve for backward-compat) — single-shot debugging, visual verification scenarios, cases where the agent specifically needs to read DOM content after the action.
- **Hybrid (`op:"act_receipt"` + `include_dom_excerpt=true`)** — if Phase 1 measurement on your target shows agents systematically need both. Out-of-scope for v1 contract.

## Author + provenance

Gregory Shevchenko · 2026-05-25 · MIT licensed.

Architectural shape inspired by [LakshmanTurlapati/FSB](https://github.com/LakshmanTurlapati/FSB) (BSL 1.1) — adopted the shape, not the code; this is an independent clean implementation.
