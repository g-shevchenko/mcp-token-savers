"""HWAI fact-extractor — deterministic regex pass for critical document metadata.

Closes the sophon weakness measured 2026-05-24:
  https://github.com/g-shevchenko/mcp-token-savers#measured-vendor-mcps
Sophon's keyword-driven section parser drops document METADATA (version
numbers, bylines, status codes, IDs, URLs) at tight budgets. This module
extracts those facts via deterministic regex BEFORE any LLM-aware section
selection runs, so they can be prepended to whatever the downstream
compressor produces.

Design constraints:
  - Deterministic: same input → same fact list (byte-identical) — C2 bar.
  - No LLM, no network, no embedder.
  - Stdlib only (re, dataclasses).
  - Cheap: linear in len(text) for all patterns.
  - Honest: a fact is included only when its regex matches; no hallucinated
    "what we wish was in the doc".

Composes with: `runners/sophon_runner.py` and the broader c2_bench harness.
v0.1 deliberately scoped to 7 fact kinds; expansion (e.g. SQL table names,
numeric thresholds, GPS coords) is a follow-up if measurement warrants.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Dict, List, Pattern


# ---------------------------------------------------------------------------
# Fact dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Fact:
    """One extracted document-metadata fact.

    Attributes:
        kind:     one of {"title", "byline", "version", "http_status", "id",
                  "url", "email"}.
        value:    the extracted string (already trimmed).
        position: character offset in the original text of the FIRST occurrence.
                  Used for stable ordering and dedup.
    """
    kind: str
    value: str
    position: int


# ---------------------------------------------------------------------------
# Regex patterns (compiled once)
# ---------------------------------------------------------------------------

# Semver-like version: v1.2.3, 1.2.3, Astro 4.5.2, Python 3.13.1, 3.13.
# Negative lookbehind: don't match the "2026" in "2026-05-24" (a date).
# We require either a leading "v" / "version" word, or the number not be
# part of a date (preceded by neither a digit-dash nor followed by -\d\d).
_VERSION_RE: Pattern[str] = re.compile(
    r"""
    (?<![\d-])                              # don't match year inside a date
    (?:
        v(?P<v_with_v>\d+\.\d+(?:\.\d+)?)   # v1.2.3 / v1.2
        |
        (?<![\w.])                          # word boundary on left
        (?P<v_bare>\d+\.\d+\.\d+)           # bare 1.2.3 (3-segment to avoid floats)
        |
        (?<![\w.])
        (?P<v_two>\d+\.\d+)                 # bare 1.2 (only after keywords below)
    )
    """,
    re.VERBOSE,
)

# Heuristic: bare 2-segment number is only a version if a keyword precedes
# it within 32 chars (Python|Node|Astro|version|release|v).
_VERSION_KEYWORD_PRECEDES_RE: Pattern[str] = re.compile(
    r"\b(?:python|node|astro|version|release|v|build|api)\b[^.\d\n]{0,32}$",
    re.IGNORECASE,
)


# Byline patterns: "Posted by X — Org", "Author: X", "By X" on its own line.
_BYLINE_PATTERNS: List[Pattern[str]] = [
    # "*Posted by Gregory Shevchenko — Founder, Humanswith.ai*"
    re.compile(r"\*?\bPosted\s+by\s+([^\n*]{2,160})\*?", re.IGNORECASE),
    # "Author: Jane Smith"
    re.compile(r"^\s*Author\s*:\s*([^\n]{2,160})$", re.IGNORECASE | re.MULTILINE),
    # "By Patrick Collison" on its own paragraph (line starting with By + Capitalised)
    re.compile(r"^By\s+([A-Z][\w'.\- ]{2,80})\s*$", re.MULTILINE),
]

# HTTP status code:
#   - In curl-verbose: "HTTP/1.1 200" or "HTTP/2 200"
#   - In JSON / logs: '"status": 200' / 'status: 404' / 'status_code: 500'
_HTTP_STATUS_PATTERNS: List[Pattern[str]] = [
    re.compile(r"\b(HTTP/\d(?:\.\d)?\s+(\d{3})\b)"),
    re.compile(r'"?\bstatus(?:_code)?\b"?\s*[:=]\s*"?(\d{3})\b'),
]

# IDs:
#   - Quoted "<name>_id": "value"  → v0.3 captures BOTH the key and value
#     so the renderer emits `database_id=db-team-tasks` (disambiguates which
#     ID is which when multiple ID kinds appear in one document — closes
#     the v0.2 blind-validation disagreement under qwen-3-235b on
#     long-notion-api).
#   - UUID (no JSON key context — just the literal value)
_ID_QUOTED_RE: Pattern[str] = re.compile(
    r'"([a-z_]*_id|id)"\s*:\s*"([^"\n]{2,80})"', re.IGNORECASE
)
_ID_UUID_RE: Pattern[str] = re.compile(
    r"\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b",
    re.IGNORECASE,
)

# URLs and emails.
_URL_RE: Pattern[str] = re.compile(r"https?://[^\s<>\"')\]]+")
_EMAIL_RE: Pattern[str] = re.compile(r"\b[\w.+-]+@[\w.-]+\.\w{2,}\b")

# Titles:
#   - first markdown H1 (`# Title` on first non-blank line)
#   - first diff header (`diff --git a/path/file.py`)
_TITLE_MD_RE: Pattern[str] = re.compile(r"^#\s+([^\n]{2,200})$", re.MULTILINE)
_TITLE_DIFF_RE: Pattern[str] = re.compile(
    r"^diff\s+--git\s+a/([^\s]+)\s+b/", re.MULTILINE
)

# v0.2 — error patterns (closes long-pytest-output failure)
# Two shapes:
#   `AssertionError: assert 'X' == 'Y'`  — pytest-style assert
#   `<Name>Error: <message>` / `<Name>Exception: <message>` — Python tracebacks
_ASSERT_RE: Pattern[str] = re.compile(
    r"\bAssertionError:\s*assert\s+([^\n]{1,200})", re.IGNORECASE
)
_EXCEPTION_RE: Pattern[str] = re.compile(
    r"\b([A-Z][A-Za-z]*(?:Error|Exception)):\s*([^\n]{1,200})"
)

# v0.2 — JSON top-level key/value (closes long-stripe-webhook, partial notion-api)
# High-signal keys curated from realistic agentic-input shapes (webhooks, API
# responses, configs). The list is small + auditable — broader semantic
# selection is v0.3 work.
_JSON_KV_KEYS = {
    "type",           # webhook event type
    "event_type",     # generic event identifier
    "amount_total",   # money amount
    "amount",         # generic amount
    "currency",
    "status",         # already extracted as http_status if numeric, but keep
                      # string status here ("paid", "active", "complete")
    "payment_status",
    "name",           # workflow/object name
    "description",
    "title",          # alternative to markdown h1
    "version",        # JSON-encoded version (string form)
    "model",          # LLM model name in payload
    "method",         # HTTP method in api log
    "url",            # endpoint URL in api log
}
# Match `"key": "value"` (string) OR `"key": 12345` (number). Skip booleans,
# null, arrays, objects — those are structure, not high-signal values.
_JSON_KV_RE: Pattern[str] = re.compile(
    r'"(' + "|".join(re.escape(k) for k in _JSON_KV_KEYS) + r')"\s*:\s*(?:"([^"\n]{1,200})"|(-?\d{1,15}(?:\.\d+)?))',
)

# v0.2 — enumeration (closes long-yaml-config failure)
# Detect recurring `<field_name>: <value>` patterns in YAML/key-value docs;
# if the same field name appears ≥ENUMERATION_MIN_OCCURRENCES times with
# DIFFERENT values, emit ONE enumeration fact listing the distinct values.
# Skip patterns where every occurrence has the same value (not a "list").
_KV_LINE_RE: Pattern[str] = re.compile(
    r"^\s*([a-zA-Z_][\w.-]{0,30})\s*:\s*(['\"]?)([^\n#'\"]{1,80})\2\s*$",
    re.MULTILINE,
)

# v0.3 — filesystem paths embedded in prose (closes long-claude-conversation).
# Conservative: at least one `/` separator, recognised code/config/doc extension,
# NOT preceded by `://` (avoid URL double-counting — those go through the url
# kind already).
_PATH_EXTENSIONS = (
    "yaml", "yml", "json", "toml", "ini", "env",
    "py", "ts", "tsx", "js", "mjs", "cjs", "jsx", "go", "rs", "rb",
    "sh", "bash", "zsh",
    "md", "txt", "rst", "html", "css", "scss",
    "sql", "csv", "tsv", "jsonl",
    "yaml.bak", "lock",
)
_PATH_EXT_GROUP = "|".join(re.escape(e) for e in _PATH_EXTENSIONS)
_PATH_RE: Pattern[str] = re.compile(
    r"(?<![:/\w])"                                     # not preceded by :// or word char
    r"((?:[A-Za-z_][\w.-]*/){1,8}"                     # 1-8 dir segments + slash
    r"[A-Za-z_][\w.-]*\.(?:" + _PATH_EXT_GROUP + r"))" # filename with whitelisted ext
    r"(?!\w)",                                         # not followed by word char (avoid catching mid-word)
)
ENUMERATION_MIN_OCCURRENCES = 3  # need ≥3 entries to call it a "list"
ENUMERATION_MIN_UNIQUE_VALUES = 2  # at least 2 distinct values
# Skip noisy generic field names that flood realistic structured inputs
# (line counts, version numbers stripped of meaning when repeated, etc.).
_ENUMERATION_SKIP_FIELDS = frozenset({
    "id", "size", "len", "length", "count", "total", "index", "n",
    "lineno", "line", "offset", "position", "value", "key", "type",  # too generic
    # Conversation role markers — values are full sentences, not category lists.
    # Hogs the enum slot on Claude/agent conversation transcripts.
    "user", "assistant", "role", "speaker", "human", "ai",
})
# Median value length above which enum is treated as narrative not categorical
_ENUMERATION_MAX_VALUE_MEDIAN_CHARS = 60


# ---------------------------------------------------------------------------
# Extractor — main entrypoint
# ---------------------------------------------------------------------------


def _extract_versions(text: str) -> List[Fact]:
    out: List[Fact] = []
    for m in _VERSION_RE.finditer(text):
        v_with_v = m.group("v_with_v")
        v_bare = m.group("v_bare")
        v_two = m.group("v_two")
        if v_with_v:
            value = v_with_v
        elif v_bare:
            value = v_bare
        elif v_two:
            # Only accept 2-segment if a version keyword precedes it within 32 chars
            preceding = text[max(0, m.start() - 32) : m.start()]
            if not _VERSION_KEYWORD_PRECEDES_RE.search(preceding):
                continue
            value = v_two
        else:
            continue
        out.append(Fact(kind="version", value=value, position=m.start()))
    return out


def _extract_bylines(text: str) -> List[Fact]:
    out: List[Fact] = []
    for pat in _BYLINE_PATTERNS:
        for m in pat.finditer(text):
            value = m.group(1).strip().rstrip("*").strip()
            if value:
                out.append(Fact(kind="byline", value=value, position=m.start()))
    return out


def _extract_http_status(text: str) -> List[Fact]:
    out: List[Fact] = []
    for pat in _HTTP_STATUS_PATTERNS:
        for m in pat.finditer(text):
            # group 1 = full match for HTTP/X 200 pattern; group 2 = bare status code
            # for the explicit-status pattern, group 1 = code
            if pat is _HTTP_STATUS_PATTERNS[0]:
                value = m.group(1).strip()
            else:
                value = m.group(1).strip()
            out.append(Fact(kind="http_status", value=value, position=m.start()))
    return out


def _extract_ids(text: str) -> List[Fact]:
    """Extract IDs. v0.3 — quoted `"<key>_id": "<value>"` pattern preserves
    the JSON key in the fact value (`key=value`) so multiple ID kinds in
    one document remain disambiguated. UUIDs are kept as bare literals."""
    out: List[Fact] = []
    for m in _ID_QUOTED_RE.finditer(text):
        key = m.group(1).strip()
        value = m.group(2).strip()
        if not value:
            continue
        # Render as `key=value` for the renderer; preserves the literal
        # value (existing tests look for `value in fact.value`).
        rendered = f"{key}={value}"
        out.append(Fact(kind="id", value=rendered, position=m.start()))
    for m in _ID_UUID_RE.finditer(text):
        value = m.group(1).strip()
        if value:
            out.append(Fact(kind="id", value=value, position=m.start()))
    return out


def _extract_urls(text: str) -> List[Fact]:
    out: List[Fact] = []
    for m in _URL_RE.finditer(text):
        # Strip trailing punctuation that's commonly NOT part of the URL
        value = m.group(0).rstrip(".,;:!?")
        out.append(Fact(kind="url", value=value, position=m.start()))
    return out


def _extract_emails(text: str) -> List[Fact]:
    return [Fact(kind="email", value=m.group(0), position=m.start())
            for m in _EMAIL_RE.finditer(text)]


def _extract_paths(text: str) -> List[Fact]:
    """v0.3 — filesystem paths embedded in prose (closes long-claude-conversation).

    Excludes URLs (which are captured by the url kind).
    """
    out: List[Fact] = []
    for m in _PATH_RE.finditer(text):
        value = m.group(1).strip()
        if value:
            out.append(Fact(kind="path", value=value, position=m.start()))
    return out


def _extract_titles(text: str) -> List[Fact]:
    out: List[Fact] = []
    # Markdown H1 — only first occurrence
    md_match = _TITLE_MD_RE.search(text)
    if md_match:
        value = md_match.group(1).strip()
        out.append(Fact(kind="title", value=value, position=md_match.start()))
    # Diff title — only first occurrence
    diff_match = _TITLE_DIFF_RE.search(text)
    if diff_match:
        value = f"diff: {diff_match.group(1).strip()}"
        out.append(Fact(kind="title", value=value, position=diff_match.start()))
    return out


def _extract_error_patterns(text: str) -> List[Fact]:
    """v0.2 — extract Python exceptions + pytest assertion failures."""
    out: List[Fact] = []
    for m in _ASSERT_RE.finditer(text):
        value = f"AssertionError: assert {m.group(1).strip()}"
        out.append(Fact(kind="error_pattern", value=value, position=m.start()))
    for m in _EXCEPTION_RE.finditer(text):
        exc_name = m.group(1)
        msg = m.group(2).strip().rstrip(".")
        # Don't double-count AssertionError (already captured above)
        if exc_name == "AssertionError" and "assert" in msg.lower():
            continue
        value = f"{exc_name}: {msg}"
        out.append(Fact(kind="error_pattern", value=value, position=m.start()))
    return out


def _extract_json_kvs(text: str) -> List[Fact]:
    """v0.2 — extract curated high-signal JSON top-level keys."""
    out: List[Fact] = []
    for m in _JSON_KV_RE.finditer(text):
        key = m.group(1)
        # Either the string value (group 2) or the numeric (group 3)
        value = (m.group(2) or m.group(3) or "").strip()
        if not value:
            continue
        out.append(
            Fact(kind="json_kv", value=f"{key}={value}", position=m.start()),
        )
    return out


_SEQUENTIAL_ID_RE: Pattern[str] = re.compile(r"^.+\s+\d{1,6}$")


def _is_sequential_id_enum(values: List[str]) -> bool:
    """Detect enumeration values that are all `<common-prefix>\\s+<number>` —
    these are sequential IDs (Server 000, server-001, etc.), not useful as
    a category list. They flood the budget with low-signal content.

    Heuristic: ≥80% of values match the "prefix + number" pattern AND share
    a common word-prefix. Conservative — only fires on clearly-sequential lists.
    """
    if len(values) < 3:
        return False
    matching = sum(1 for v in values if _SEQUENTIAL_ID_RE.match(v.strip()))
    if matching / len(values) < 0.8:
        return False
    # Common-prefix check (first whitespace-delimited token of each value)
    prefixes = [v.split()[0] for v in values if v.split()]
    if not prefixes:
        return False
    unique_prefixes = set(prefixes)
    # ≤2 distinct prefixes = sequential (allow minor noise like quoted vs unquoted)
    return len(unique_prefixes) <= 2


def _extract_enumerations(text: str) -> List[Fact]:
    """v0.2 — detect recurring `<field>: <value>` patterns; emit list summaries.

    Only fields meeting ALL of:
      - appears ≥ ENUMERATION_MIN_OCCURRENCES times
      - has ≥ ENUMERATION_MIN_UNIQUE_VALUES distinct values
      - field name not in _ENUMERATION_SKIP_FIELDS
      - values NOT a sequential-ID pattern (Server 000, Server 001, ...)
    """
    from collections import defaultdict

    by_field: Dict[str, List[tuple]] = defaultdict(list)
    for m in _KV_LINE_RE.finditer(text):
        field = m.group(1).lower()
        value = m.group(3).strip()
        if field in _ENUMERATION_SKIP_FIELDS:
            continue
        if not value:
            continue
        by_field[field].append((value, m.start()))

    out: List[Fact] = []
    for field, entries in by_field.items():
        if len(entries) < ENUMERATION_MIN_OCCURRENCES:
            continue
        # Distinct values, preserving first-occurrence order
        seen = set()
        ordered_unique: List[str] = []
        first_position = entries[0][1]
        for value, _pos in entries:
            if value not in seen:
                seen.add(value)
                ordered_unique.append(value)
        if len(ordered_unique) < ENUMERATION_MIN_UNIQUE_VALUES:
            continue
        # Skip sequential-ID enumerations (Server 000, Server 001, ... — low signal)
        if _is_sequential_id_enum(ordered_unique):
            continue
        # Skip if values look like narrative (median value too long to be a category)
        sorted_lens = sorted(len(v) for v in ordered_unique)
        median_len = sorted_lens[len(sorted_lens) // 2]
        if median_len > _ENUMERATION_MAX_VALUE_MEDIAN_CHARS:
            continue
        # Cap enumeration size — keep first 8 distinct values to avoid hogging
        # the fact-prefix budget when there are 60+ values to enumerate.
        capped = ordered_unique[:8]
        suffix = f", … ({len(ordered_unique)} total)" if len(ordered_unique) > 8 else ""
        rendered = f"{field}: {', '.join(capped)}{suffix}"
        out.append(
            Fact(kind="enumeration", value=rendered, position=first_position),
        )
    return out


# Kind → sort order for stable rendering (title first, then byline, then version, etc.)
_KIND_RANK: Dict[str, int] = {
    "title": 0,
    "byline": 1,
    "version": 2,
    "error_pattern": 3,
    "http_status": 4,
    "json_kv": 5,
    "enumeration": 6,
    "id": 7,
    "path": 8,
    "url": 9,
    "email": 10,
}


def extract_facts(text: str) -> List[Fact]:
    """Extract critical document-metadata facts from `text`.

    Returns a list of `Fact` objects, deduplicated by (kind, value) preserving
    the FIRST occurrence position. Ordered first by kind rank, then by
    document position within each kind.

    Determinism: the same input always produces the same fact list in the
    same order (no hashing of memory-address-dependent state, no random).
    """
    if not text:
        return []

    raw: List[Fact] = []
    raw.extend(_extract_titles(text))
    raw.extend(_extract_bylines(text))
    raw.extend(_extract_versions(text))
    raw.extend(_extract_error_patterns(text))  # v0.2
    raw.extend(_extract_http_status(text))
    raw.extend(_extract_json_kvs(text))        # v0.2
    raw.extend(_extract_enumerations(text))    # v0.2
    raw.extend(_extract_ids(text))
    raw.extend(_extract_paths(text))           # v0.3
    raw.extend(_extract_urls(text))
    raw.extend(_extract_emails(text))

    # Dedup by (kind, value), keep first-occurrence position
    seen: Dict[tuple, Fact] = {}
    for f in raw:
        key = (f.kind, f.value)
        if key not in seen or f.position < seen[key].position:
            seen[key] = f
    deduped = list(seen.values())

    # Stable order: by kind rank, then by document position within kind
    deduped.sort(key=lambda f: (_KIND_RANK.get(f.kind, 99), f.position))
    return deduped


# ---------------------------------------------------------------------------
# Renderer — facts → compact prefix block
# ---------------------------------------------------------------------------


_KIND_LABELS: Dict[str, str] = {
    "title": "Title",
    "byline": "By",
    "version": "Version",
    "error_pattern": "Error",
    "http_status": "Status",
    "json_kv": "Field",
    "enumeration": "Enum",
    "id": "Id",
    "path": "Path",
    "url": "URL",
    "email": "Email",
}


def facts_to_text(facts: List[Fact], max_chars: int = 600,
                   max_per_kind: int = 5) -> str:
    """Render facts as a compact labelled prefix block.

    Format:
        [HWAI facts]
        Title: ...
        By: ...
        Version: ...
        Status: ...
        Id: ..., ..., ...   (multiple values comma-joined when same kind)
        URL: ..., ...

    Total length is hard-capped at `max_chars`; later lines are dropped
    (truncated with `[...]` marker) rather than fitting partial values
    that would mislead downstream consumers.

    `max_per_kind` caps how many values of each kind survive (top by
    document position). Prevents version-spam (e.g. blog with `v1.0`,
    `v2.0`, ..., `v15.0` examples) from crowding out other facts.
    """
    if not facts:
        return ""

    # Group by kind in the canonical kind order, capping per-kind to top-N
    by_kind: Dict[str, List[str]] = {}
    for f in facts:
        bucket = by_kind.setdefault(f.kind, [])
        if len(bucket) < max_per_kind:
            bucket.append(f.value)

    lines: List[str] = ["[HWAI facts]"]
    truncated = False
    for kind in sorted(by_kind, key=lambda k: _KIND_RANK.get(k, 99)):
        label = _KIND_LABELS.get(kind, kind.capitalize())
        # Enumerations render ONE-PER-LINE (each enum is "field: v1, v2, ...");
        # comma-joining them into one line confuses the LLM about which values
        # belong to which field. Other kinds comma-join values on a single
        # labelled line, which is fine for short values (versions, status codes,
        # URLs, etc.).
        if kind == "enumeration":
            value_lines = [f"{label} {v}" for v in by_kind[kind]]
        else:
            value_lines = [f"{label}: {', '.join(by_kind[kind])}"]
        for line in value_lines:
            next_total = sum(len(l) + 1 for l in lines) + len(line) + 1
            if next_total > max_chars:
                remaining = max_chars - sum(len(l) + 1 for l in lines) - 5  # "[...]"
                if remaining > len(label) + 4:
                    lines.append(line[:remaining] + "[...]")
                else:
                    lines.append("[...]")
                truncated = True
                break
            lines.append(line)
        if truncated:
            break

    out = "\n".join(lines)
    # Final hard truncation guard
    if len(out) > max_chars:
        out = out[: max_chars - 5] + "[...]"
    return out
