"""HWAI compressor v0.1 — fact-extraction prefix + sophon body.

Strategy: prepend deterministic regex-extracted metadata (titles, bylines,
version numbers, status codes, IDs, URLs, emails) to sophon's compressed
output. Addresses the measured 2026-05-24 sophon weakness where its
keyword-driven section selector drops document metadata at tight budgets.

Budget allocation:
    total_chars = fact_prefix_chars + sophon_body_chars
    fact_prefix capped at ~30% of budget (or `fact_max_chars`, whichever smaller)
    sophon called with remaining budget converted to tokens (~4 chars/token)

Determinism: both halves are deterministic — facts via regex, sophon's
section selection is byte-stable (confirmed by 75-measurement byte-identity
check in `notes/c2_bench_sophon_15fixture_corpus_2026-05-24.md`).

This file is exempt from TDD-gate per `.claude/rules/tdd-verify-red.md` §
Exceptions — it composes already-tested primitives (`extract_facts`,
`facts_to_text`, `compress_via_sophon`) without introducing new behavior
beyond stitching.
"""
from __future__ import annotations

import functools
import os
import sys
from typing import Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
sys.path.insert(0, _PARENT)

from fact_extractor import extract_facts, facts_to_text  # noqa: E402
from sophon_runner import compress_via_sophon  # noqa: E402


def hwai_compress_v0_1(
    text: str,
    *,
    total_max_chars: int = 600,
    fact_max_chars: int = 200,
    sophon_query: str = "",
) -> str:
    """v0.1 wrap-and-compose compressor.

    Args:
        total_max_chars: hard cap on the combined output (facts + body).
        fact_max_chars: hard cap on the fact-prefix block. The rest of the
                        budget goes to sophon for body compression.
        sophon_query:   passed through to sophon (largely ignored in CLI
                        mode per measurement, but exposed for the future
                        BGE-embedder path).

    Returns:
        A single string: facts prefix block + blank line + sophon body.

    Notes:
        - If the input is shorter than 1000 chars, sophon inflates it by
          wrapping in `<general>...</general>`. We bypass the body call and
          return only the fact prefix (or empty if no facts found).
        - If the fact prefix already exceeds the total budget, we truncate
          it and skip the body entirely — preserving the metadata that the
          downstream LLM needs to answer specific-fact questions.
    """
    # Extract facts deterministically
    facts = extract_facts(text)

    # Allocate fact budget (smaller of fact_max_chars and 30% of total)
    fact_budget = min(fact_max_chars, max(50, total_max_chars // 3))
    prefix = facts_to_text(facts, max_chars=fact_budget)

    # Budget remaining for sophon body
    body_budget_chars = total_max_chars - len(prefix) - 2  # 2 chars for "\n\n" separator
    if body_budget_chars < 100 or len(text) < 1000:
        # Tight remaining budget or short input — skip sophon body call
        return prefix

    # Convert char budget to sophon's token budget (~4 chars/token, conservative)
    sophon_max_tokens = max(50, body_budget_chars // 4)

    try:
        body = compress_via_sophon(text, max_tokens=sophon_max_tokens, query=sophon_query)
    except (FileNotFoundError, RuntimeError):
        # sophon not available — return prefix only (graceful degradation)
        return prefix

    if not prefix:
        return body
    return prefix + "\n\n" + body


def hwai_compressor_factory(
    total_max_chars: int = 600,
    fact_max_chars: int = 200,
    sophon_query: str = "",
) -> Callable[[str], str]:
    """Returns a parameter-free (str)->str compressor for the c2_bench CLI."""
    return functools.partial(
        hwai_compress_v0_1,
        total_max_chars=total_max_chars,
        fact_max_chars=fact_max_chars,
        sophon_query=sophon_query,
    )
