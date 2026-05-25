"""scraper-mcp.act_receipt.v1 — Python reference implementation.

Companion to https://gregshevchenko.com/research/mcp-stack-token-economy-part-2/

Functions:
- validate_receipt(receipt) -> (ok, errors)
- canonical_receipt_bytes(receipt) -> bytes
- canonical_sha256(receipt) -> str
- cache_friendly_score(receipts) -> float | None
- dom_region_hash(html) -> str
- assemble_receipt(...) -> dict          (convenience builder)

Cross-runtime equivalent: `../js/canonical_bytes.mjs`. Both produce the
same SHA-256 for the same canonical input — verified in
`tests/test_canonical_bytes.py`.

Standard library only. No external dependencies.

License: MIT
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SCHEMA_VERSION = "scraper-mcp.act_receipt.v1"

# Action types allowed in v1.
ALLOWED_ACTION_TYPES = frozenset({
    "click", "type", "press", "scroll", "wait", "navigate", "select", "drag",
})

# Required top-level keys in a v1 receipt.
REQUIRED_TOP_KEYS = ("schema_version", "action", "pre_state", "post_state", "errors")

# Required keys in nested objects.
REQUIRED_ACTION_KEYS = ("type",)  # selector/value/options are optional per action type
REQUIRED_PRE_STATE_KEYS = ("url", "dom_region_hash")
REQUIRED_POST_STATE_KEYS = ("url", "dom_region_hash", "changed", "stable", "navigated")
REQUIRED_ERRORS_KEYS = ("console", "network", "selector_not_found", "timeout", "action_failed")

# Fields stripped before canonical-byte hashing (jitter).
STRIPPED_TOP_KEYS = ("observability",)
STRIPPED_STATE_KEYS = ("dom_region_size_bytes",)

# DOM-noise attribute patterns stripped before dom_region_hash computation.
# v1 ships with conservative defaults; extend per-site as your evidence requires.
DOM_NOISE_ATTR_PATTERNS = (
    re.compile(r'\s*data-time="[^"]*"'),
    re.compile(r"\s*data-time='[^']*'"),
    re.compile(r'\s*data-timestamp="[^"]*"'),
    re.compile(r"\s*data-timestamp='[^']*'"),
    re.compile(r'\s*data-frame="[^"]*"'),
    re.compile(r"\s*data-frame='[^']*'"),
    re.compile(r'\s*data-focused="[^"]*"'),
    re.compile(r"\s*data-focused='[^']*'"),
)


# --------------------------------------------------------------------------- #
# validate_receipt
# --------------------------------------------------------------------------- #

def validate_receipt(receipt: Any) -> tuple[bool, list[str]]:
    """Validate a receipt against the v1 schema. Returns (ok, errors)."""
    errors: list[str] = []

    if not isinstance(receipt, dict):
        return False, ["receipt must be a dict"]

    sv = receipt.get("schema_version")
    if sv is None:
        errors.append("missing required field: schema_version")
    elif sv != SCHEMA_VERSION:
        errors.append(f"schema_version mismatch: expected {SCHEMA_VERSION!r}, got {sv!r}")

    for key in REQUIRED_TOP_KEYS:
        if key not in receipt:
            errors.append(f"missing required top-level key: {key}")

    action = receipt.get("action")
    if isinstance(action, dict):
        for key in REQUIRED_ACTION_KEYS:
            if key not in action:
                errors.append(f"missing required action.{key}")
        a_type = action.get("type")
        if a_type is not None and a_type not in ALLOWED_ACTION_TYPES:
            errors.append(
                f"action.type {a_type!r} not in allowed set {sorted(ALLOWED_ACTION_TYPES)}"
            )
    elif action is not None:
        errors.append("action must be a dict")

    pre_state = receipt.get("pre_state")
    if isinstance(pre_state, dict):
        for key in REQUIRED_PRE_STATE_KEYS:
            if key not in pre_state:
                errors.append(f"missing required pre_state.{key}")
    elif pre_state is not None:
        errors.append("pre_state must be a dict")

    post_state = receipt.get("post_state")
    if isinstance(post_state, dict):
        for key in REQUIRED_POST_STATE_KEYS:
            if key not in post_state:
                errors.append(f"missing required post_state.{key}")
    elif post_state is not None:
        errors.append("post_state must be a dict")

    err_block = receipt.get("errors")
    if isinstance(err_block, dict):
        for key in REQUIRED_ERRORS_KEYS:
            if key not in err_block:
                errors.append(f"missing required errors.{key}")
    elif err_block is not None:
        errors.append("errors must be a dict")

    return (len(errors) == 0), errors


# --------------------------------------------------------------------------- #
# canonical_receipt_bytes / canonical_sha256
# --------------------------------------------------------------------------- #

def _strip_for_canonical(receipt: dict) -> dict:
    """Return a copy of the receipt with jitter fields stripped.

    - Remove the top-level `observability` subtree entirely.
    - Remove `dom_region_size_bytes` from pre_state and post_state.
    """
    cleaned: dict = {}
    for key, value in receipt.items():
        if key in STRIPPED_TOP_KEYS:
            continue
        if key in ("pre_state", "post_state") and isinstance(value, dict):
            cleaned[key] = {
                k: v for k, v in value.items() if k not in STRIPPED_STATE_KEYS
            }
        else:
            cleaned[key] = value
    return cleaned


def canonical_receipt_bytes(receipt: dict) -> bytes:
    """Return a deterministic byte representation of the receipt.

    Strips jitter fields, then JSON-serializes with sorted keys at every
    nesting level. Same semantic receipt -> byte-identical output across
    runs and across runtimes (matches `../js/canonical_bytes.mjs`).
    """
    cleaned = _strip_for_canonical(receipt)
    return json.dumps(cleaned, sort_keys=True, ensure_ascii=False).encode("utf-8")


def canonical_sha256(receipt: dict) -> str:
    """Return the SHA-256 hex of the canonical byte representation."""
    return hashlib.sha256(canonical_receipt_bytes(receipt)).hexdigest()


# --------------------------------------------------------------------------- #
# cache_friendly_score
# --------------------------------------------------------------------------- #

def cache_friendly_score(receipts: list[dict]) -> float | None:
    """Return the fraction of receipts matching the modal canonical hash.

    - 1.0 means all receipts produce byte-identical canonical form
      (prompt-cache hit guaranteed on N+1th call).
    - < 1.0 means at least one receipt differs semantically.
    - None for empty input.
    """
    if not receipts:
        return None
    if len(receipts) == 1:
        return 1.0

    hashes = [canonical_sha256(r) for r in receipts]
    most_common_count = max(hashes.count(h) for h in set(hashes))
    return most_common_count / len(hashes)


# --------------------------------------------------------------------------- #
# dom_region_hash
# --------------------------------------------------------------------------- #

def _strip_dom_noise(html: str) -> str:
    """Remove known DOM-noise patterns from HTML before hashing."""
    cleaned = html
    for pattern in DOM_NOISE_ATTR_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    return cleaned


def dom_region_hash(html: str) -> str:
    """Return 'sha256:HEX' fingerprint of an HTML region, DOM noise stripped.

    Same semantic content (modulo noise patterns) -> same hash -> cache-friendly.
    """
    cleaned = _strip_dom_noise(html)
    digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


# --------------------------------------------------------------------------- #
# assemble_receipt — convenience builder
# --------------------------------------------------------------------------- #

def assemble_receipt(
    *,
    action: dict,
    pre_url: str,
    pre_dom_region_html: str,
    post_url: str,
    post_dom_region_html: str,
    navigated: bool = False,
    stable: bool = True,
    errors: dict | None = None,
    observability: dict | None = None,
) -> dict:
    """Build a v1-compliant receipt from raw browser-MCP outputs.

    Hashes the pre/post DOM regions for you, fills the required errors
    block with empty defaults if not supplied, and computes the `changed`
    boolean by comparing the two region hashes.
    """
    pre_hash = dom_region_hash(pre_dom_region_html)
    post_hash = dom_region_hash(post_dom_region_html)
    receipt = {
        "schema_version": SCHEMA_VERSION,
        "action": dict(action),
        "pre_state": {
            "url": pre_url,
            "dom_region_hash": pre_hash,
            "dom_region_size_bytes": len(pre_dom_region_html.encode("utf-8")),
        },
        "post_state": {
            "url": post_url,
            "dom_region_hash": post_hash,
            "dom_region_size_bytes": len(post_dom_region_html.encode("utf-8")),
            "changed": pre_hash != post_hash,
            "stable": stable,
            "navigated": navigated,
        },
        "errors": errors if errors is not None else {
            "console": [],
            "network": [],
            "selector_not_found": False,
            "timeout": False,
            "action_failed": None,
        },
    }
    if observability is not None:
        receipt["observability"] = observability
    return receipt
