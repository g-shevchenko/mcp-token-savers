"""Example compressors — minimal reference implementations.

These are toy compressors. They exist to:
1. Show the `(str) -> str` contract that the harness expects.
2. Provide a smoke-test target so `python3 run_bench.py` works out of the
   box without any external dependencies.

Replace these with your own real compressors when you measure a stack:
- a parser-based prep layer
- a regex-driven fact extractor
- an extractive summariser (like mcp-sophon)
- a vendor MCP exposed via stdio handshake
- a custom HTTP-wrapped service

Whatever it is, if it takes `str` in and returns `str` out, the harness
can measure it.
"""
from __future__ import annotations

import re
from typing import Callable


def first_n_lines(n: int) -> Callable[[str], str]:
    """Keep only the first N lines. Deterministic. Probably a bad compressor."""
    def _impl(x: str) -> str:
        return "\n".join(x.splitlines()[:n])
    return _impl


def strip_blank_lines(x: str) -> str:
    """Remove blank lines. Deterministic. Marginal saving on whitespace-heavy text."""
    return "\n".join(line for line in x.splitlines() if line.strip())


def extract_headings(x: str) -> str:
    """Extract markdown-style headings (`#` lines). Deterministic. Aggressive saving."""
    return "\n".join(
        line for line in x.splitlines() if re.match(r"^\s*#{1,6}\s+", line)
    )


def register(registry: dict) -> None:
    """Register example compressors into a dict.

    Called by `run_bench.py` to auto-load examples. Override or extend
    in your own code to register real compressors.
    """
    registry["first10lines"] = first_n_lines(10)
    registry["strip_blanks"] = strip_blank_lines
    registry["headings_only"] = extract_headings
