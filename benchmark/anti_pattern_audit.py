"""12-anti-pattern cache-killing audit (DSA framework).

Twelve enumerable patterns destroy provider prefix-cache reuse. They are
documented in the `agents-best-practices` reference repository (MIT,
provider-neutral synthesis of OpenAI / Anthropic / MCP guidance):

  https://github.com/DenisSergeevitch/agents-best-practices/blob/main/references/prompt-caching-and-cost.md

This script grep-audits one or more MCP source directories (or any
source tree) for each pattern and emits a compliance matrix. Run it
against your own MCPs (or any tool surface that ships static
descriptions / prompt prefixes) to catch cache-killers before they ship.

Usage:
    python3 anti_pattern_audit.py --mcp path/to/your-mcp/src
    python3 anti_pattern_audit.py --mcp services/mcp-a --mcp services/mcp-b
    python3 anti_pattern_audit.py --root services --mcp mcp-a --mcp mcp-b

Some of the 12 DSA patterns apply only to prompt-builder code (the
client/agent side, not the tool/MCP side). Those rows render as `N/A`
for tool-provider scope and are noted in the per-rule notes.

Pure-Python stdlib. Reads files only — no writes, no network.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Pattern, Tuple


@dataclass
class AntiPatternRule:
    """One DSA anti-pattern with greppable signal + scope filter."""

    pattern_id: int
    name: str
    scope: str  # "tool-provider" | "client-prompt-builder" | "both"
    regex: Optional[Pattern[str]] = None
    ignore_if_contains: List[str] = field(default_factory=list)
    notes: str = ""


RULES: List[AntiPatternRule] = [
    AntiPatternRule(
        pattern_id=1,
        name="Timestamps/Date.now in stable response/description",
        scope="tool-provider",
        regex=re.compile(r"\b(Date\.now|new Date|time\.time|time\.perf_counter)\b"),
        ignore_if_contains=["latency", "duration", "elapsed", "_ms"],
        notes="latency_ms in a measurement-result field is documented/expected; "
              "real violation = timestamp in a stable description or as a cache key",
    ),
    AntiPatternRule(
        pattern_id=2,
        name="Request/correlation ID in stable prefix",
        scope="tool-provider",
        regex=re.compile(r"\b(request_id|correlation_id|trace_id)\b", re.IGNORECASE),
        ignore_if_contains=["log", "audit", "request_log"],
        notes="OK in log records; violation if injected into tool description",
    ),
    AntiPatternRule(
        pattern_id=3,
        name="Randomized tool order",
        scope="tool-provider",
        regex=re.compile(r"random\.shuffle.*tools?\b|tools?\.shuffle\(", re.IGNORECASE),
        notes="MCPs that present tools in non-deterministic order each list/init",
    ),
    AntiPatternRule(
        pattern_id=4,
        name="JSON serialization without stable key order",
        scope="tool-provider",
        regex=re.compile(r"json\.dumps\([^)]*sort_keys=False", re.IGNORECASE),
        notes="Python 3.7+ dicts are insertion-ordered; pattern catches explicit "
              "disable of stable ordering",
    ),
    AntiPatternRule(
        pattern_id=5,
        name="Live env state injected before static instructions",
        scope="client-prompt-builder",
        regex=re.compile(r"process\.env\.[A-Z_]+\s*\+\s*system|env\(.*\)\s*\+\s*"),
        notes="Applies to agent prompt builders, not tool servers.",
    ),
    AntiPatternRule(
        pattern_id=6,
        name="Per-user secrets in stable description/prefix",
        scope="tool-provider",
        regex=re.compile(r'description.*\$\{?[A-Z_]*(token|key|secret|password)', re.IGNORECASE),
        notes="String interpolation of credentials into a tool description",
    ),
    AntiPatternRule(
        pattern_id=7,
        name="Rewriting conversation history every turn",
        scope="client-prompt-builder",
        notes="N/A for tool-providers (no conversation state owned)",
    ),
    AntiPatternRule(
        pattern_id=8,
        name="Re-summarizing whole session every turn",
        scope="client-prompt-builder",
        notes="N/A for tool-providers; compression tools COMPRESS once, don't re-summarize",
    ),
    AntiPatternRule(
        pattern_id=9,
        name="Schema formatting changes without versioning",
        scope="tool-provider",
        regex=re.compile(r"schema_version|api_version", re.IGNORECASE),
        notes="Inversion test: an MCP with NO schema_version field anywhere "
              "is a violation. Computed separately.",
    ),
    AntiPatternRule(
        pattern_id=10,
        name="Volatile retrieval results before stable instructions",
        scope="client-prompt-builder",
        notes="N/A for tool-providers; agent-side concern",
    ),
    AntiPatternRule(
        pattern_id=11,
        name="Overly granular cache keys with low request volume",
        scope="tool-provider",
        regex=re.compile(r"cache_key.*\+\s*(uuid|random|datetime|time)", re.IGNORECASE),
        notes="A tool that builds cache keys with per-call random salts",
    ),
    AntiPatternRule(
        pattern_id=12,
        name="Failing to log cached-token fields",
        scope="both",
        regex=re.compile(r"cached_tokens|cache_read_tokens|cache_write_tokens"),
        notes="Inversion test: log/response shapes that should include these but don't.",
    ),
]


# Infrastructure files where timestamps/IDs are EXPECTED + benign (logs, cache
# TTL math, artifact-ID generation). The DSA anti-patterns target STABLE PROMPT
# PREFIX content, not response/log/cache plumbing.
DEFAULT_INFRASTRUCTURE_FILE_PATTERNS = (
    "request-log.",
    "cache.",
    "artifact-store.",
    "measurement.",
)


def _gather_source_files(
    target_dir: Path,
    infra_patterns: tuple = DEFAULT_INFRASTRUCTURE_FILE_PATTERNS,
) -> List[Path]:
    """Source files in scope: code files under target_dir, infra files excluded."""
    out: List[Path] = []
    for p in target_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix not in {".ts", ".tsx", ".js", ".mjs", ".py"}:
            continue
        if any(infra in p.name for infra in infra_patterns):
            continue
        # Skip node_modules and dist/build outputs
        parts = p.parts
        if "node_modules" in parts or "dist" in parts or "build" in parts:
            continue
        out.append(p)
    return out


def audit_target(target_dir: Path, label: str = "") -> dict:
    """Run all 12 anti-pattern rules against one source tree."""
    if not target_dir.is_dir():
        return {"target": label or str(target_dir), "status": "NOT_FOUND", "rules": []}
    files = _gather_source_files(target_dir)
    file_contents = {p: p.read_text(encoding="utf-8", errors="ignore") for p in files}

    rule_results = []
    for rule in RULES:
        if rule.scope == "client-prompt-builder":
            rule_results.append({
                "id": rule.pattern_id,
                "name": rule.name,
                "scope": rule.scope,
                "verdict": "N/A",
                "hits": 0,
                "evidence": [],
                "notes": rule.notes,
            })
            continue

        if rule.regex is None:
            rule_results.append({
                "id": rule.pattern_id,
                "name": rule.name,
                "scope": rule.scope,
                "verdict": "MANUAL",
                "hits": 0,
                "evidence": [],
                "notes": rule.notes,
            })
            continue

        evidence: List[Tuple[str, str]] = []
        for path, text in file_contents.items():
            for m in rule.regex.finditer(text):
                line_start = text.rfind("\n", 0, m.start()) + 1
                line_end = text.find("\n", m.end())
                line = text[line_start:line_end if line_end != -1 else None].strip()
                if any(w in line.lower() for w in rule.ignore_if_contains):
                    continue
                rel = path.relative_to(target_dir) if path.is_relative_to(target_dir) else path
                evidence.append((str(rel), line[:160]))

        # Inversion checks
        if rule.pattern_id == 9:
            present = bool(evidence)
            verdict = "PASS" if present else "VIOLATION"
            hits = len(evidence)
        elif rule.pattern_id == 12:
            verdict = "PASS" if evidence else "N/A"
            hits = len(evidence)
        else:
            hits = len(evidence)
            verdict = "VIOLATION" if hits > 0 else "PASS"

        rule_results.append({
            "id": rule.pattern_id,
            "name": rule.name,
            "scope": rule.scope,
            "verdict": verdict,
            "hits": hits,
            "evidence": evidence[:5],
            "notes": rule.notes,
        })

    return {
        "target": label or str(target_dir),
        "rules": rule_results,
        "files_scanned": len(files),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcp", action="append", default=[],
                    help="Path to an MCP/source directory to audit. "
                         "Can be passed multiple times.")
    ap.add_argument("--root", default=None,
                    help="Optional parent directory; --mcp values become subdirs of this.")
    ap.add_argument("--json", action="store_true",
                    help="Emit machine-readable JSON instead of human-readable text.")
    args = ap.parse_args()

    if not args.mcp:
        print("ERROR: pass --mcp <path> at least once", file=sys.stderr)
        return 2

    targets = []
    for m in args.mcp:
        p = Path(args.root) / m if args.root else Path(m)
        targets.append((m, p.resolve()))

    if not args.json:
        print("=" * 78)
        print("12-anti-pattern cache-killing audit (DSA framework)")
        print(f"Targets: {', '.join(label for label, _ in targets)}")
        print("=" * 78)

    all_results = []
    for label, path in targets:
        result = audit_target(path, label=label)
        all_results.append(result)
        if args.json:
            continue
        print(f"\n### {label}  ({result.get('files_scanned', 0)} files scanned)")
        if result.get("status") == "NOT_FOUND":
            print(f"  (directory not found: {path})")
            continue
        for r in result["rules"]:
            badge = {
                "PASS": "[PASS]",
                "VIOLATION": "[VIOL]",
                "N/A": "[ N/A]",
                "MANUAL": "[ ?  ]",
            }[r["verdict"]]
            print(f"  {badge} #{r['id']:2d} {r['name'][:60]:60s}  {r['verdict']}")
            if r["verdict"] == "VIOLATION" and r["evidence"]:
                for src, line in r["evidence"][:3]:
                    print(f"      -> {src}: {line[:120]}")

    if args.json:
        print(json.dumps({"targets": all_results}, indent=2, default=str))
        return 0

    print()
    print("=" * 78)
    print("Summary by target x verdict")
    print("=" * 78)
    print(f"{'target':25s} {'PASS':>5s} {'VIOL':>5s} {'N/A':>5s} {'MAN':>5s}")
    total_violations = 0
    for r in all_results:
        if r.get("status") == "NOT_FOUND":
            continue
        verdicts = [rule["verdict"] for rule in r["rules"]]
        p = verdicts.count("PASS")
        v = verdicts.count("VIOLATION")
        na = verdicts.count("N/A")
        m = verdicts.count("MANUAL")
        total_violations += v
        print(f"{r['target']:25s} {p:>5d} {v:>5d} {na:>5d} {m:>5d}")
    print()
    print(f"Total violations across all targets: {total_violations}")
    return 0 if total_violations == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
