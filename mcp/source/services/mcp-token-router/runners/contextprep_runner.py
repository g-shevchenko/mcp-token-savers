"""context-prep runner — wraps `prepText` via a Node bridge.

context-prep-mcp's `prepText` is a TypeScript function from this repo's
`services/context-prep-mcp/`. The function is a deterministic extractive
summariser: it composes (purpose + extractive summary + decisions +
action_items + open_questions + risks + clamped raw carry).

Because the function lives in Node land, the Python runner shells out
to `contextprep_bridge.mjs` which imports `prepText` from the built
`dist/` and emits a one-line JSON envelope on stdout.

Compared to sophon (vendor MCP):
  - sophon: relevance-based section selection, max_tokens budget
  - context-prep: regex-based decisions/actions/questions/risks extraction
                  + first-N-line extractive summary + clamped raw carry
  - both are deterministic (parser-first, no LLM in the path)
  - HWAI-authored, optimised for our own ContentOS pipeline use cases

Env:
    CONTEXTPREP_BRIDGE — override path to contextprep_bridge.mjs
    CONTEXTPREP_TIMEOUT_SEC — wall-clock cap per call (default 30)
"""
from __future__ import annotations

import functools
import json
import os
import subprocess


_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BRIDGE = os.path.join(_HERE, "contextprep_bridge.mjs")
DEFAULT_TIMEOUT_SEC = 30


def _bridge_path() -> str:
    return os.environ.get("CONTEXTPREP_BRIDGE", DEFAULT_BRIDGE)


def _bridge_timeout() -> int:
    raw = os.environ.get("CONTEXTPREP_TIMEOUT_SEC")
    try:
        return int(raw) if raw else DEFAULT_TIMEOUT_SEC
    except ValueError:
        return DEFAULT_TIMEOUT_SEC


def compress_via_contextprep(
    text: str,
    *,
    max_compact_chars: int = 7000,
    preserve_exact: bool = False,
    purpose: str = "compact long text for frontier model context",
) -> str:
    """Compress `text` via context-prep `prepText`. Returns compact_context string.

    max_compact_chars defaults to 7000 (context-prep's own default). For
    apples-to-apples comparison with sophon at max_tokens=200 (~600 chars
    output), set max_compact_chars=600.

    Raises:
        FileNotFoundError — bridge missing
        subprocess.CalledProcessError — bridge exited non-zero
        json.JSONDecodeError — bridge emitted non-JSON
    """
    bridge = _bridge_path()
    if not os.path.isfile(bridge):
        raise FileNotFoundError(
            f"context-prep bridge not found at {bridge}. Set "
            f"CONTEXTPREP_BRIDGE or build context-prep-mcp first."
        )
    r = subprocess.run(
        ["node", bridge, str(max_compact_chars), "true" if preserve_exact else "false", purpose],
        input=text,
        capture_output=True,
        text=True,
        timeout=_bridge_timeout(),
        check=True,
    )
    payload = json.loads(r.stdout, strict=False)
    return payload["compact_context"]


def contextprep_factory(
    max_compact_chars: int = 7000,
    preserve_exact: bool = False,
    purpose: str = "compact long text for frontier model context",
):
    """Returns a parameter-free (str) -> str compressor for the c2_bench CLI."""
    return functools.partial(
        compress_via_contextprep,
        max_compact_chars=max_compact_chars,
        preserve_exact=preserve_exact,
        purpose=purpose,
    )
