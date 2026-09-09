"""mcp-sophon runner — wraps `sophon compress-prompt` as a `(str) -> str` fn.

Treats sophon's `compressed_prompt` field as the C2 output. Char-based size of
that field becomes the harness's `output_size`. Sophon ALSO emits a token-based
`compression_ratio`; that's logged but the harness measures chars (portable).

Why subprocess and not MCP stdio: sophon is `command: sophon, args: [serve]`
when used as an MCP, but the CLI mode is the documented one-shot path and is
easier to wrap deterministically. For c2_bench purposes, both modes call the
same Rust binary; CLI is the cleanest `(str) -> str`.

Usage:
    from runners.sophon_runner import compress_via_sophon
    out = compress_via_sophon("long input text", max_tokens=200)

Or via the c2_bench CLI, register in COMPRESSOR_REGISTRY (see run_c2_bench.py).

Env:
    SOPHON_BIN   — path to sophon binary (default: ~/.npm-global/bin/sophon)
    SOPHON_TIMEOUT_SEC — wall-clock cap per call (default: 30)
"""
from __future__ import annotations

import functools
import json
import os
import subprocess
import tempfile


DEFAULT_SOPHON_BIN = os.path.expanduser("~/.npm-global/bin/sophon")
DEFAULT_TIMEOUT_SEC = 30


def _sophon_binary() -> str:
    return os.environ.get("SOPHON_BIN", DEFAULT_SOPHON_BIN)


def _sophon_timeout() -> int:
    raw = os.environ.get("SOPHON_TIMEOUT_SEC")
    try:
        return int(raw) if raw else DEFAULT_TIMEOUT_SEC
    except ValueError:
        return DEFAULT_TIMEOUT_SEC


def compress_via_sophon(
    text: str,
    *,
    max_tokens: int = 200,
    query: str = "",
) -> str:
    """Compress `text` via `sophon compress-prompt`. Returns the compressed_prompt string.

    Sophon requires a `--query` flag (it tailors content selection to the
    query). For C2 measurement of generic compression we default to empty
    string; for query-aware benchmarks the caller can pass a real query.

    Raises:
        FileNotFoundError — sophon binary missing on PATH
        subprocess.CalledProcessError — sophon exited non-zero
        json.JSONDecodeError — sophon emitted non-JSON (unlikely; CLI is JSON)
    """
    bin_path = _sophon_binary()
    if not os.path.isfile(bin_path):
        raise FileNotFoundError(
            f"sophon binary not found at {bin_path}. Set SOPHON_BIN or run "
            f"`npm install -g mcp-sophon` with prefix configured."
        )
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8",
    ) as f:
        f.write(text)
        tmp_path = f.name
    try:
        r = subprocess.run(
            [
                bin_path, "compress-prompt",
                "--prompt", tmp_path,
                "--query", query,
                "--max-tokens", str(max_tokens),
            ],
            capture_output=True,
            text=True,
            timeout=_sophon_timeout(),
            check=True,
        )
        # Sophon's compressed_prompt contains literal newlines INSIDE the JSON
        # string — Python 3.14's strict parser would reject them; strict=False
        # accepts. 3.9 default accepts. Either way: strict=False is safe.
        payload = json.loads(r.stdout, strict=False)
        return payload["compressed_prompt"]
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# Convenience factory for different max_tokens budgets
def sophon_factory(max_tokens: int = 200, query: str = "") -> "Callable[[str], str]":
    """Returns a parameter-free (str) -> str compressor with the given budget.

    Used by run_c2_bench.py to register sophon variants in COMPRESSOR_REGISTRY.
    """
    return functools.partial(compress_via_sophon, max_tokens=max_tokens, query=query)
